import { type Credentials } from "./credentials";
import { jiraGet } from "./api";
import { type IssueData, parseIssue, getObj, getStr } from "./parser";

export type HistoryChange = {
  field: string;
  from: string | null;
  to: string | null;
};

export type HistoryEvent = {
  date: Date;
  author: string;
  changes: HistoryChange[];
};

export type HistoryData = {
  issue: IssueData;
  created: Date;
  creator: string;
  events: HistoryEvent[];
};

type FullChangelogEntry = {
  created: string;
  author: { displayName: string };
  items: Array<{ field: string; fromString: string | null; toString: string | null }>;
};

type ChangelogPage = {
  values?: FullChangelogEntry[];
  startAt?: number;
  maxResults?: number;
  total?: number;
  isLast?: boolean;
};

const SKIP_FIELDS = new Set([
  "Workflow", "WorklogId", "timeestimate", "timespent",
  "Rank", "RemoteIssueLink", "RemoteWorkItemLink", "IssueParentAssociation",
]);

const FIELD_LABELS: Record<string, string> = {
  "status": "Status",
  "assignee": "Assignee",
  "priority": "Priority",
  "summary": "Summary",
  "Story Points": "Points",
  "Sprint": "Sprint",
  "labels": "Labels",
  "issuetype": "Type",
  "description": "Description",
  "Acceptance Criteria": "AC",
  "Testing Instructions": "TI",
  "resolution": "Resolution",
  "Fix Version": "Fix Version",
  "Component": "Component",
  "Epic Link": "Epic",
  "Team": "Team",
  "Parent": "Parent",
};

function labelForField(field: string): string {
  return FIELD_LABELS[field] || field;
}

export async function fetchFullChangelog(creds: Credentials, key: string): Promise<FullChangelogEntry[]> {
  const entries: FullChangelogEntry[] = [];
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

export function parseHistory(
  rawIssue: unknown,
  changelog: FullChangelogEntry[],
): HistoryData {
  const issue = parseIssue(rawIssue);
  const fields = getObj(rawIssue, "fields");
  const creatorObj = getObj(fields, "creator") || getObj(fields, "reporter");
  const creator = creatorObj ? getStr(creatorObj, "displayName") : "Unknown";
  const created = new Date(getStr(fields, "created"));

  const events: HistoryEvent[] = [];

  for (const entry of changelog) {
    const filteredItems = entry.items.filter(item => !SKIP_FIELDS.has(item.field));
    if (filteredItems.length === 0) continue;

    events.push({
      date: new Date(entry.created),
      author: entry.author?.displayName || "Unknown",
      changes: filteredItems.map(item => ({
        field: labelForField(item.field),
        from: item.fromString || null,
        to: item.toString || null,
      })),
    });
  }

  return { issue, created, creator, events };
}
