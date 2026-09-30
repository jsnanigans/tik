import { customFields } from "./config";
import { adfToMarkdown, type AdfNode } from "./markdown";

export type IssueData = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  assignee: string | null;
  assigneeId: string | null;
  priority: string;
  priorityId: string;
  issueType: string;
  storyPoints: number | null;
  created: string;
  updated: string;
  epicKey: string | null;
  epicName: string | null;
  parentKey: string | null;
  description: string | null;
  acceptanceCriteria: string | null;
  testingInstructions: string | null;
  labels: string[];
  teamId: string | null;
  teamName?: string | null;
  sprintName: string | null;
  reporter?: string | null;
  creator?: string | null;
  resolution?: string | null;
  resolutionDate?: string | null;
  dueDate?: string | null;
  attachments: AttachmentData[];
};

export type AttachmentData = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
  author: string;
  url: string;
  thumbnailUrl?: string;
  /** Media-service UUID, needed for inline embedding via ADF media nodes. */
  mediaId?: string;
};

export type SprintData = {
  id: number;
  name: string;
  state: string;
  startDate: string;
  endDate: string;
  goal?: string;
};

export type CommentData = {
  id: string;
  author: string;
  authorId: string;
  created: string;
  updated: string;
  body: string;
};

export type IssueLinkData = {
  id: string;
  type: string;
  inward: boolean;
  linkedIssue: {
    key: string;
    summary: string;
    status: string;
  };
};

export function getStr(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    return typeof val === "string" ? val : "";
  }
  return "";
}

export function getObj(obj: unknown, key: string): unknown {
  if (typeof obj === "object" && obj !== null && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return null;
}

/**
 * Jira returns the Team field either as a bare id string or as a team object;
 * reading only the string form silently drops the team on newer instances.
 */
export function extractTeam(fields: unknown): { teamId: string | null; teamName: string | null } {
  const raw = getObj(fields, customFields.team);
  if (typeof raw === "string") return { teamId: raw || null, teamName: null };
  if (raw && typeof raw === "object") {
    return { teamId: getStr(raw, "id") || null, teamName: getStr(raw, "name") || null };
  }
  return { teamId: null, teamName: null };
}

export function getNested(obj: unknown, ...keys: string[]): string {
  let current = obj;
  for (const key of keys.slice(0, -1)) {
    current = getObj(current, key);
    if (current === null) return "";
  }
  return getStr(current, keys[keys.length - 1]);
}

export function parseIssue(issue: unknown): IssueData {
  const key = getStr(issue, "key");
  const fields = getObj(issue, "fields");
  const summary = getStr(fields, "summary");
  const status = getNested(fields, "status", "name");
  const statusCategory = getNested(fields, "status", "statusCategory", "name");
  const assigneeObj = getObj(fields, "assignee");
  const assignee = assigneeObj ? getStr(assigneeObj, "displayName") : null;
  const assigneeId = assigneeObj ? getStr(assigneeObj, "accountId") : null;
  const priority = getNested(fields, "priority", "name");
  const priorityId = getNested(fields, "priority", "id");
  const issueType = getNested(fields, "issuetype", "name");
  const storyPointsRaw = getObj(fields, customFields.storyPoints);
  const storyPoints = typeof storyPointsRaw === "number" ? storyPointsRaw : null;
  const created = getStr(fields, "created");
  const updated = getStr(fields, "updated");
  const epicKey = getStr(fields, customFields.epicLink) || null;
  const parentObj = getObj(fields, "parent");
  const parentKey = parentObj ? getStr(parentObj, "key") : null;
  const epicName = parentObj ? getStr(getObj(parentObj, "fields"), "summary") : null;

  const descriptionAdf = getObj(fields, "description") as AdfNode | null;
  const description = descriptionAdf ? adfToMarkdown(descriptionAdf) : null;

  const acAdf = getObj(fields, customFields.acceptanceCriteria) as AdfNode | null;
  const acceptanceCriteria = acAdf ? adfToMarkdown(acAdf) : null;

  const tiAdf = getObj(fields, customFields.testingInstructions) as AdfNode | null;
  const testingInstructions = tiAdf ? adfToMarkdown(tiAdf) : null;

  const labelsRaw = getObj(fields, "labels") as string[] | null;
  const labels = Array.isArray(labelsRaw) ? labelsRaw : [];

  const { teamId, teamName } = extractTeam(fields);

  const reporterObj = getObj(fields, "reporter");
  const reporter = reporterObj ? getStr(reporterObj, "displayName") : null;
  const creatorObj = getObj(fields, "creator");
  const creator = creatorObj ? getStr(creatorObj, "displayName") : null;
  const resolution = getNested(fields, "resolution", "name") || null;
  const resolutionDate = getStr(fields, "resolutiondate") || null;
  const dueDate = getStr(fields, "duedate") || null;

  const sprintsRaw = getObj(fields, customFields.sprint) as Array<Record<string, unknown>> | null;
  const activeSprint = Array.isArray(sprintsRaw)
    ? sprintsRaw.find(s => s?.state === "active") ?? sprintsRaw[sprintsRaw.length - 1]
    : null;
  const sprintName = activeSprint ? getStr(activeSprint, "name") || null : null;

  const attachmentsRaw = (getObj(fields, "attachment") as Array<Record<string, unknown>>) || [];
  const attachments: AttachmentData[] = Array.isArray(attachmentsRaw)
    ? attachmentsRaw.map((att) => {
        const authorObj = getObj(att, "author");
        return {
          id: getStr(att, "id"),
          filename: getStr(att, "filename"),
          mimeType: getStr(att, "mimeType"),
          size: typeof att.size === "number" ? (att.size as number) : 0,
          created: getStr(att, "created"),
          author: authorObj ? getStr(authorObj, "displayName") : "",
          url: getStr(att, "content"),
          thumbnailUrl: getStr(att, "thumbnail") || undefined,
          mediaId: getStr(att, "mediaId") || undefined,
        };
      })
    : [];

  return {
    key,
    summary,
    status,
    statusCategory,
    assignee,
    assigneeId,
    priority,
    priorityId,
    issueType,
    storyPoints,
    created,
    updated,
    epicKey,
    epicName,
    parentKey,
    description,
    acceptanceCriteria,
    testingInstructions,
    labels,
    teamId,
    teamName,
    sprintName,
    reporter,
    creator,
    resolution,
    resolutionDate,
    dueDate,
    attachments,
  };
}

export function parseIssues(result: unknown): IssueData[] {
  const issues = (getObj(result, "issues") as unknown[]) || [];
  return issues.map(parseIssue);
}

export function parseSprint(sprint: unknown): SprintData {
  return {
    id: (getObj(sprint, "id") as number) || 0,
    name: getStr(sprint, "name"),
    state: getStr(sprint, "state"),
    startDate: getStr(sprint, "startDate"),
    endDate: getStr(sprint, "endDate"),
    goal: getStr(sprint, "goal") || undefined,
  };
}

export function parseComments(result: unknown): CommentData[] {
  const comments = (getObj(result, "comments") as unknown[]) || [];
  return comments.map((comment) => {
    const authorObj = getObj(comment, "author");
    const bodyAdf = getObj(comment, "body") as AdfNode | null;
    return {
      id: getStr(comment, "id"),
      author: authorObj ? getStr(authorObj, "displayName") : "Unknown",
      authorId: authorObj ? getStr(authorObj, "accountId") : "",
      created: getStr(comment, "created"),
      updated: getStr(comment, "updated"),
      body: bodyAdf ? adfToMarkdown(bodyAdf) : "",
    };
  });
}

export function parseIssueLinks(issue: unknown): IssueLinkData[] {
  const fields = getObj(issue, "fields");
  const linksRaw = (getObj(fields, "issuelinks") as unknown[]) || [];
  const links: IssueLinkData[] = [];

  for (const link of linksRaw) {
    const typeObj = getObj(link, "type");
    const typeName = getStr(typeObj, "name");
    const inwardName = getStr(typeObj, "inward");
    const outwardName = getStr(typeObj, "outward");

    const inwardIssue = getObj(link, "inwardIssue");
    const outwardIssue = getObj(link, "outwardIssue");

    if (inwardIssue) {
      const inwardFields = getObj(inwardIssue, "fields");
      links.push({
        id: getStr(link, "id"),
        type: inwardName || typeName,
        inward: true,
        linkedIssue: {
          key: getStr(inwardIssue, "key"),
          summary: getStr(inwardFields, "summary"),
          status: getNested(inwardFields, "status", "name"),
        },
      });
    }

    if (outwardIssue) {
      const outwardFields = getObj(outwardIssue, "fields");
      links.push({
        id: getStr(link, "id"),
        type: outwardName || typeName,
        inward: false,
        linkedIssue: {
          key: getStr(outwardIssue, "key"),
          summary: getStr(outwardFields, "summary"),
          status: getNested(outwardFields, "status", "name"),
        },
      });
    }
  }

  return links;
}
