import { type Credentials } from "./credentials";
import { jiraGet, jiraBulkChangelog, type BulkChangelogHistory } from "./api";
import { type IssueData, type IssueLinkData, parseIssue, parseIssueLinks } from "./parser";
import { getCachedIssuesRaw, getChildrenRaw, getTimelineDates, cacheTimelineDates, getKeysNeedingChangelogSync, cachePreviousAssignees, markChangelogSynced, cacheChangelog } from "./cache";
import { StatusCategory } from "../ui/format";
import { localConfig } from "./config";

export type TimelineDate = {
  startedAt: string | null;
  testingAt: string | null;
  completedAt: string | null;
  doneAt: string | null;
};

export type TimelineTicket = {
  issue: IssueData;
  dates: TimelineDate;
  links: IssueLinkData[];
};

export type TimelineEdge = {
  from: string;
  to: string;
  type: string;
  label: string;
};

export type TimelineEvent = {
  date: string;
  rawDate: string;
  key: string;
  summary: string;
  eventType: "created" | "started" | "testing" | "completed" | "done" | "instant";
  lane: number;
  duration?: string;
  connections: string;
  issue: IssueData;
};

export type TimelineData = {
  tickets: Map<string, TimelineTicket>;
  edges: TimelineEdge[];
  events: TimelineEvent[];
  noDateTickets: IssueData[];
  dateRange: { start: string; end: string };
  stats: { total: number; done: number; active: number };
};

const STARTED_STATUSES = new Set(localConfig.statuses.timeline.started);

const DONE_STATUSES = new Set(StatusCategory.done.statuses);

const TESTING_STATUSES = new Set(localConfig.statuses.timeline.testing);
const COMPLETED_STATUSES = new Set(localConfig.statuses.timeline.completed);

type ChangelogEntry = {
  created: string;
  items: Array<{ field: string; fromString: string; toString: string; from: string | null; to: string | null }>;
  author?: { accountId?: string; displayName?: string; emailAddress?: string };
};

type ChangelogPage = {
  values?: ChangelogEntry[];
  startAt?: number;
  maxResults?: number;
  total?: number;
  isLast?: boolean;
};

async function fetchChangelog(creds: Credentials, key: string): Promise<ChangelogEntry[]> {
  const entries: ChangelogEntry[] = [];
  let startAt = 0;

  while (true) {
    const page = (await jiraGet(
      creds,
      `/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`
    )) as ChangelogPage;

    const values = page.values || [];
    entries.push(...values);

    if (page.isLast !== false || values.length === 0) break;
    startAt += values.length;
  }

  return entries;
}

function bulkHistoryToEntries(histories: BulkChangelogHistory[]): ChangelogEntry[] {
  return histories.map(h => ({
    created: new Date(h.created).toISOString(),
    items: h.items.map(i => ({
      field: i.field,
      fromString: i.fromString || "",
      toString: i.toString || "",
      from: i.from,
      to: i.to,
    })),
  }));
}

function extractDates(entries: ChangelogEntry[], issue: IssueData): TimelineDate {
  let startedAt: string | null = null;
  let testingAt: string | null = null;
  let completedAt: string | null = null;
  let doneAt: string | null = null;

  for (const entry of entries) {
    for (const item of entry.items) {
      if (item.field !== "status") continue;
      const date = entry.created.slice(0, 10);

      if (!startedAt && STARTED_STATUSES.has(item.toString)) startedAt = date;
      if (!testingAt && TESTING_STATUSES.has(item.toString)) testingAt = date;
      if (!completedAt && COMPLETED_STATUSES.has(item.toString)) completedAt = date;
      if (DONE_STATUSES.has(item.toString)) doneAt = date;
    }
  }

  // If ticket is done but was never explicitly moved through in-progress, use created date
  if (!startedAt && doneAt) {
    startedAt = issue.created.slice(0, 10);
  }

  return { startedAt, testingAt, completedAt, doneAt };
}

export function extractPreviousAssignees(entries: ChangelogEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const item of entry.items) {
      if (item.field === "assignee" && item.from) {
        ids.add(item.from);
      }
    }
  }
  return [...ids];
}

function needsChangelogFetch(
  startedAt: string | null,
  doneAt: string | null,
  statusCategory: string | null,
  testingAt?: string | null,
  completedAt?: string | null,
  status?: string | null,
): boolean {
  // Ticket in to-do / new status — no dates to extract
  if (statusCategory === "To Do" || statusCategory === "New") return false;
  // Done ticket: only fully resolved if phase dates are also populated
  if (startedAt && doneAt) {
    if (testingAt || completedAt) return false;
    return true;
  }
  // In-progress ticket: re-fetch if current status implies a phase date we don't have
  if (startedAt && !doneAt && statusCategory !== "Done") {
    if (status && TESTING_STATUSES.has(status) && !testingAt) return true;
    if (status && COMPLETED_STATUSES.has(status) && !completedAt) return true;
    return false;
  }
  // Otherwise needs fetch (progressed but missing dates)
  return true;
}

export async function fetchTimelineDates(
  creds: Credentials,
  keys: string[],
  fresh = false,
): Promise<Map<string, TimelineDate>> {
  const results = new Map<string, TimelineDate>();
  const BATCH_SIZE = 10;

  // Read cached timeline dates
  const cached = getTimelineDates(keys);
  const cachedMap = new Map(cached.map(c => [c.key, c]));

  // Determine which keys need fresh changelog
  const staleKeys: string[] = [];
  for (const key of keys) {
    const c = cachedMap.get(key);
    if (c && !needsChangelogFetch(c.startedAt, c.doneAt, c.statusCategory, c.testingAt, c.completedAt, c.status)) {
      results.set(key, {
        startedAt: c.startedAt,
        testingAt: c.testingAt,
        completedAt: c.completedAt,
        doneAt: c.doneAt,
        _cached: true,
      } as unknown as TimelineDate);
    } else {
      staleKeys.push(key);
    }
  }

  if (fresh) {
    // Fetch changelog only for stale keys
    for (let i = 0; i < staleKeys.length; i += BATCH_SIZE) {
      const batch = staleKeys.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (key) => {
        try {
          const entries = await fetchChangelog(creds, key);
          return { key, entries };
        } catch {
          return { key, entries: [] as ChangelogEntry[] };
        }
      });
      const batchResults = await Promise.all(promises);
      for (const { key, entries } of batchResults) {
        results.set(key, { startedAt: null, testingAt: null, completedAt: null, doneAt: null, _entries: entries } as unknown as TimelineDate);
      }
    }
  } else {
    // Offline: use whatever is cached, null for the rest
    for (const key of staleKeys) {
      const c = cachedMap.get(key);
      results.set(key, {
        startedAt: c?.startedAt ?? null,
        testingAt: c?.testingAt ?? null,
        completedAt: c?.completedAt ?? null,
        doneAt: c?.doneAt ?? null,
      });
    }
  }

  return results;
}

export function extractTimelineDates(
  rawDates: Map<string, TimelineDate>,
  issues: Map<string, IssueData>
): Map<string, TimelineDate> {
  const results = new Map<string, TimelineDate>();
  const toCache: Array<{ key: string; startedAt: string | null; testingAt: string | null; completedAt: string | null; doneAt: string | null }> = [];

  for (const [key, raw] of rawDates) {
    const augmented = raw as unknown as { _cached?: boolean; _entries?: ChangelogEntry[] };

    if (augmented._cached) {
      results.set(key, { startedAt: raw.startedAt, testingAt: raw.testingAt, completedAt: raw.completedAt, doneAt: raw.doneAt });
      continue;
    }

    const entries = augmented._entries || [];
    const issue = issues.get(key);
    if (issue) {
      const dates = extractDates(entries, issue);
      results.set(key, dates);
      toCache.push({ key, startedAt: dates.startedAt, testingAt: dates.testingAt, completedAt: dates.completedAt, doneAt: dates.doneAt });
    } else {
      results.set(key, { startedAt: null, testingAt: null, completedAt: null, doneAt: null });
    }
  }

  if (toCache.length > 0) {
    cacheTimelineDates(toCache);
  }

  return results;
}

export async function syncTimelineDates(
  creds: Credentials,
  keys: string[],
  onProgress?: (fetched: number, total: number) => void,
): Promise<number> {
  // Read cached timeline dates to determine which keys are stale
  const cached = getTimelineDates(keys);
  const cachedMap = new Map(cached.map(c => [c.key, c]));

  // Keys needing timeline dates
  const timelineStaleKeys = new Set<string>();
  for (const key of keys) {
    const c = cachedMap.get(key);
    if (!c || needsChangelogFetch(c.startedAt, c.doneAt, c.statusCategory, c.testingAt, c.completedAt, c.status)) {
      timelineStaleKeys.add(key);
    }
  }

  // Keys needing assignee changelog extraction
  const changelogNeeded = getKeysNeedingChangelogSync(keys);
  const allStaleKeys = new Set([...timelineStaleKeys, ...changelogNeeded]);

  if (allStaleKeys.size === 0) return 0;

  const staleKeys = [...allStaleKeys];

  // Load issue data from cache for fallback logic in extractDates
  // Also build issueId→key map for bulk changelog response mapping
  const rawMap = getCachedIssuesRaw(staleKeys);
  const issueMap = new Map<string, IssueData>();
  const idToKey = new Map<string, string>();
  for (const [key, raw] of rawMap) {
    issueMap.set(key, parseIssue(raw));
    const id = (raw as Record<string, unknown>)?.id;
    if (id) idToKey.set(String(id), key);
  }

  const toCache: Array<{ key: string; startedAt: string | null; testingAt: string | null; completedAt: string | null; doneAt: string | null }> = [];
  const assigneeData: Array<{ key: string; accountIds: string[] }> = [];
  const processedKeys: string[] = [];

  // Try bulk changelog API first, fall back to individual fetches
  let usedBulk = false;
  const changelogEntries: Array<{ key: string; created: number; field: string; fromString: string | null; toString: string | null; author: string | null }> = [];
  try {
    const BULK_BATCH = 500;
    let fetched = 0;

    for (let i = 0; i < staleKeys.length; i += BULK_BATCH) {
      const batch = staleKeys.slice(i, i + BULK_BATCH);
      const result = await jiraBulkChangelog(creds, batch);

      for (const issueLog of result.issues) {
        const key = idToKey.get(issueLog.issueId);
        if (!key) continue;

        const entries = bulkHistoryToEntries(issueLog.changeHistories);
        const issue = issueMap.get(key);

        if (issue && timelineStaleKeys.has(key)) {
          const dates = extractDates(entries, issue);
          toCache.push({ key, startedAt: dates.startedAt, testingAt: dates.testingAt, completedAt: dates.completedAt, doneAt: dates.doneAt });
        }

        const prevAssignees = extractPreviousAssignees(entries);
        if (prevAssignees.length > 0) {
          assigneeData.push({ key, accountIds: prevAssignees });
        }
        processedKeys.push(key);

        for (const h of issueLog.changeHistories) {
          for (const item of h.items) {
            changelogEntries.push({
              key,
              created: h.created,
              field: item.field ?? "",
              fromString: item.fromString ?? null,
              toString: item.toString ?? null,
              author: h.author?.displayName ?? h.author?.accountId ?? null,
            });
          }
        }
      }

      fetched += batch.length;
      onProgress?.(fetched, staleKeys.length);
    }
    usedBulk = true;
  } catch {
    // Bulk API failed (404 or other) — fall back to individual fetches
  }

  if (!usedBulk) {
    const BATCH_SIZE = 20;
    let fetched = 0;

    for (let i = 0; i < staleKeys.length; i += BATCH_SIZE) {
      const batch = staleKeys.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (key) => {
        try {
          const entries = await fetchChangelog(creds, key);
          return { key, entries };
        } catch {
          return { key, entries: [] as ChangelogEntry[] };
        }
      });
      const batchResults = await Promise.all(promises);
      for (const { key, entries } of batchResults) {
        const issue = issueMap.get(key);
        if (issue && timelineStaleKeys.has(key)) {
          const dates = extractDates(entries, issue);
          toCache.push({ key, startedAt: dates.startedAt, testingAt: dates.testingAt, completedAt: dates.completedAt, doneAt: dates.doneAt });
        }
        const prevAssignees = extractPreviousAssignees(entries);
        if (prevAssignees.length > 0) {
          assigneeData.push({ key, accountIds: prevAssignees });
        }
        processedKeys.push(key);

        for (const entry of entries) {
          const createdMs = new Date(entry.created).getTime();
          for (const item of entry.items) {
            changelogEntries.push({
              key,
              created: createdMs,
              field: item.field,
              fromString: item.fromString || null,
              toString: item.toString || null,
              author: entry.author?.displayName ?? null,
            });
          }
        }
      }
      fetched += batchResults.length;
      onProgress?.(fetched, staleKeys.length);
    }
  }

  if (toCache.length > 0) {
    cacheTimelineDates(toCache);
  }
  if (assigneeData.length > 0) {
    cachePreviousAssignees(assigneeData);
  }
  if (processedKeys.length > 0) {
    markChangelogSynced(processedKeys);
  }
  if (changelogEntries.length > 0) {
    cacheChangelog(changelogEntries);
  }

  return staleKeys.length;
}

export function expandRelatedTickets(
  initialIssues: IssueData[],
  initialRaws: Map<string, unknown>
): { issues: Map<string, IssueData>; raws: Map<string, unknown> } {
  const issues = new Map<string, IssueData>();
  const raws = new Map<string, unknown>(initialRaws);

  for (const issue of initialIssues) {
    issues.set(issue.key, issue);
  }

  // Collect all referenced keys (links, parents, epics)
  const referencedKeys: string[] = [];
  for (const [key, raw] of raws) {
    const links = parseIssueLinks(raw);
    for (const link of links) {
      if (!issues.has(link.linkedIssue.key)) {
        referencedKeys.push(link.linkedIssue.key);
      }
    }
    const issue = issues.get(key);
    if (issue?.parentKey && !issues.has(issue.parentKey)) {
      referencedKeys.push(issue.parentKey);
    }
    if (issue?.epicKey && !issues.has(issue.epicKey)) {
      referencedKeys.push(issue.epicKey);
    }
  }

  // Resolve referenced keys from cache
  if (referencedKeys.length > 0) {
    const cachedRaws = getCachedIssuesRaw(referencedKeys);
    for (const [key, raw] of cachedRaws) {
      raws.set(key, raw);
      issues.set(key, parseIssue(raw));
    }
  }

  // Expand children: for every parent/epic in the set, include their children
  const parentAndEpicKeys: string[] = [];
  for (const [key, issue] of issues) {
    if (issue.issueType === "Epic") {
      parentAndEpicKeys.push(key);
    }
  }
  const knownParentKeys = new Set<string>();
  for (const [, issue] of issues) {
    if (issue.parentKey && issues.has(issue.parentKey)) knownParentKeys.add(issue.parentKey);
    if (issue.epicKey && issues.has(issue.epicKey)) knownParentKeys.add(issue.epicKey);
  }
  for (const k of knownParentKeys) parentAndEpicKeys.push(k);
  const uniqueParentEpicKeys = [...new Set(parentAndEpicKeys)];

  if (uniqueParentEpicKeys.length > 0) {
    const childRaws = getChildrenRaw(uniqueParentEpicKeys);
    for (const [key, raw] of childRaws) {
      if (!issues.has(key)) {
        raws.set(key, raw);
        issues.set(key, parseIssue(raw));
      }
    }
  }

  return { issues, raws };
}

export function buildGraph(
  issues: Map<string, IssueData>,
  raws: Map<string, unknown>
): TimelineEdge[] {
  const edges: TimelineEdge[] = [];
  const seen = new Set<string>();

  for (const [key, raw] of raws) {
    if (!issues.has(key)) continue;
    const links = parseIssueLinks(raw);

    for (const link of links) {
      if (!issues.has(link.linkedIssue.key)) continue;

      const edgeId = [key, link.linkedIssue.key].sort().join(":");
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);

      const typeName = link.type.toLowerCase();
      let label: string;
      if (typeName.includes("block")) {
        label = "⊣";
      } else if (typeName.includes("relat")) {
        label = "→";
      } else if (typeName.includes("duplic")) {
        label = "=";
      } else {
        label = "→";
      }

      edges.push({
        from: link.inward ? link.linkedIssue.key : key,
        to: link.inward ? key : link.linkedIssue.key,
        type: link.type,
        label,
      });
    }

    // Parent/child edges
    const issue = issues.get(key)!;
    if (issue.parentKey && issues.has(issue.parentKey)) {
      const edgeId = [key, issue.parentKey].sort().join(":parent:");
      if (!seen.has(edgeId)) {
        seen.add(edgeId);
        edges.push({
          from: issue.parentKey,
          to: key,
          type: "parent",
          label: "↑",
        });
      }
    }

    if (issue.epicKey && issues.has(issue.epicKey) && issue.epicKey !== issue.parentKey) {
      const edgeId = [key, issue.epicKey].sort().join(":epic:");
      if (!seen.has(edgeId)) {
        seen.add(edgeId);
        edges.push({
          from: issue.epicKey,
          to: key,
          type: "epic",
          label: "⚡",
        });
      }
    }
  }

  return edges;
}

function formatDuration(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

  if (days < 1) return "<1d";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

function formatMonthDay(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

export function buildTimeline(
  tickets: Map<string, TimelineTicket>,
  edges: TimelineEdge[]
): TimelineData {
  const events: TimelineEvent[] = [];
  const noDateTickets: IssueData[] = [];
  const edgeLookup = new Map<string, TimelineEdge[]>();

  // Build edge lookup for connection annotations
  for (const edge of edges) {
    if (!edgeLookup.has(edge.to)) edgeLookup.set(edge.to, []);
    edgeLookup.get(edge.to)!.push(edge);
    if (!edgeLookup.has(edge.from)) edgeLookup.set(edge.from, []);
    edgeLookup.get(edge.from)!.push(edge);
  }

  // Build parent/epic child lookup
  const containerChildren = new Map<string, string[]>();
  for (const [key, ticket] of tickets) {
    const containerKey = ticket.issue.parentKey || ticket.issue.epicKey;
    if (containerKey && tickets.has(containerKey) && containerKey !== key) {
      if (!containerChildren.has(containerKey)) containerChildren.set(containerKey, []);
      containerChildren.get(containerKey)!.push(key);
    }
  }

  // Adjust container startedAt: use earliest child start if container has none
  for (const [containerKey, childKeys] of containerChildren) {
    const container = tickets.get(containerKey)!;
    let earliest = container.dates.startedAt;
    for (const ck of childKeys) {
      const child = tickets.get(ck)!;
      if (child.dates.startedAt && (!earliest || child.dates.startedAt < earliest)) {
        earliest = child.dates.startedAt;
      }
    }
    if (earliest && earliest !== container.dates.startedAt) {
      container.dates = { ...container.dates, startedAt: earliest };
    }
  }

  // All tickets with a created date enter the timeline; others go to noDate
  const datedTickets: Array<{ key: string; ticket: TimelineTicket }> = [];

  for (const [key, ticket] of tickets) {
    if (ticket.issue.created) {
      datedTickets.push({ key, ticket });
    } else {
      noDateTickets.push(ticket.issue);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  // Sort: containers first, then by duration descending (longest left)
  const isContainer = (key: string) => containerChildren.has(key);
  datedTickets.sort((a, b) => {
    const contA = isContainer(a.key) ? 0 : 1;
    const contB = isContainer(b.key) ? 0 : 1;
    if (contA !== contB) return contA - contB;
    const endA = a.ticket.dates.doneAt || today;
    const endB = b.ticket.dates.doneAt || today;
    const durA = new Date(endA).getTime() - new Date(a.ticket.issue.created.slice(0, 10)).getTime();
    const durB = new Date(endB).getTime() - new Date(b.ticket.issue.created.slice(0, 10)).getTime();
    return durB - durA;
  });

  // Assign lanes (greedy lowest-available, start = created)
  const MAX_LANES = 10;
  const laneEndDates: (string | null)[] = [];
  const laneAssignment = new Map<string, number>();

  for (const { key, ticket } of datedTickets) {
    const endDate = ticket.dates.doneAt || "9999-99-99";

    let assignedLane = -1;
    for (let i = 0; i < laneEndDates.length; i++) {
      if (laneEndDates[i] !== null && laneEndDates[i]! <= ticket.issue.created.slice(0, 10)) {
        assignedLane = i;
        break;
      }
    }

    if (assignedLane === -1) {
      if (laneEndDates.length < MAX_LANES) {
        assignedLane = laneEndDates.length;
        laneEndDates.push(null);
      } else {
        assignedLane = MAX_LANES - 1;
      }
    }

    laneEndDates[assignedLane] = endDate;
    laneAssignment.set(key, assignedLane);
  }

  function getConnections(key: string): string {
    const relatedEdges = edgeLookup.get(key) || [];
    const parts: string[] = [];
    for (const edge of relatedEdges) {
      const otherKey = edge.from === key ? edge.to : edge.from;
      if (!tickets.has(otherKey)) continue;
      if (parts.length >= 2) break;
      parts.push(`${edge.label} ${otherKey}`);
    }
    return parts.join("  ");
  }

  // Emit lifecycle events per ticket
  for (const { key, ticket } of datedTickets) {
    const lane = laneAssignment.get(key) || 0;
    const created = ticket.issue.created.slice(0, 10); // normalize to YYYY-MM-DD
    const { startedAt, testingAt, completedAt, doneAt } = ticket.dates;
    const connections = getConnections(key);
    const base = { key, summary: ticket.issue.summary, lane, issue: ticket.issue, connections: "" };

    // 1. Created (opens lane, shows summary)
    events.push({ ...base, date: formatMonthDay(created), rawDate: created, eventType: "created", connections });

    // 2. Started (skip if same day as created — already introduced)
    if (startedAt && startedAt !== created) {
      events.push({ ...base, date: formatMonthDay(startedAt), rawDate: startedAt, eventType: "started" });
    }

    // 3. Testing
    if (testingAt) {
      events.push({ ...base, date: formatMonthDay(testingAt), rawDate: testingAt, eventType: "testing" });
    }

    // 4. Completed
    if (completedAt) {
      events.push({ ...base, date: formatMonthDay(completedAt), rawDate: completedAt, eventType: "completed" });
    }

    // 5. Done (closes lane, shows duration)
    if (doneAt) {
      const duration = formatDuration(created, doneAt);
      events.push({ ...base, date: formatMonthDay(doneAt), rawDate: doneAt, eventType: "done", duration });
    }
  }

  // Hierarchy ranks for sort stability
  const parentKeys = new Set<string>();
  const epicKeys = new Set<string>();
  for (const [, ticket] of tickets) {
    if (ticket.issue.parentKey && tickets.has(ticket.issue.parentKey)) parentKeys.add(ticket.issue.parentKey);
    if (ticket.issue.epicKey && tickets.has(ticket.issue.epicKey)) epicKeys.add(ticket.issue.epicKey);
  }

  function hierarchyRank(key: string): number {
    if (epicKeys.has(key)) return 0;
    if (parentKeys.has(key)) return 1;
    return 2;
  }

  // Stage order for same-date sorting
  const stageOrder: Record<string, number> = {
    created: 0, started: 1, testing: 2, completed: 3, done: 4, instant: 1,
  };

  events.sort((a, b) => {
    if (a.rawDate !== b.rawDate) return a.rawDate.localeCompare(b.rawDate);
    const sa = stageOrder[a.eventType] ?? 5;
    const sb = stageOrder[b.eventType] ?? 5;
    if (sa !== sb) return sa - sb;
    const ra = hierarchyRank(a.key);
    const rb = hierarchyRank(b.key);
    if (sa <= 3) return ra - rb; // opening/intermediate: epics first
    return rb - ra; // closing: epics last
  });

  // Stats
  let done = 0;
  let active = 0;
  for (const { ticket } of datedTickets) {
    if (ticket.dates.doneAt) done++;
    else active++;
  }

  // Date range
  const allDates = datedTickets
    .flatMap(({ ticket }) => [ticket.issue.created.slice(0, 10), ticket.dates.doneAt].filter(Boolean) as string[]);
  const start = allDates.length > 0 ? allDates.sort()[0] : today;
  const end = allDates.length > 0 ? allDates.sort().pop()! : start;

  return {
    tickets,
    edges,
    events,
    noDateTickets,
    dateRange: { start, end },
    stats: { total: tickets.size, done, active },
  };
}
