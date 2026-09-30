import { type AttachmentData, type CommentData, type IssueData, type IssueLinkData, getObj, getStr } from "./parser";
import { type HistoryData } from "./history";
import { customFields } from "./config";

export const DEFAULT_BOT_AUTHORS = [
  "Continuous Integration",
  "Automation for Jira",
  "GitHub",
  "Jira Service Management",
  "Zapier",
];

export type ExportSprint = {
  id: number;
  name: string;
  state: string;
  startDate: string;
  endDate: string;
  goal?: string;
};

export type ExportInput = {
  issue: IssueData;
  raw: unknown;
  links: IssueLinkData[];
  comments: CommentData[];
  history?: HistoryData | null;
  availableTransitions?: string[];
};

export type ExportOptions = {
  jiraBase: string;
  capturedAt: string;
  /** Relative directory the attachment links point at; omit to link only the Jira URL. */
  attachmentDir?: string | null;
  botAuthors?: string[];
  /** Render bot comments in full instead of collapsing them to one line each. */
  keepBots?: boolean;
  teamLabel?: string | null;
};

export function isBotAuthor(author: string, botAuthors: string[] = DEFAULT_BOT_AUTHORS): boolean {
  const lower = author.toLowerCase();
  return botAuthors.some((bot) => lower.includes(bot.toLowerCase()));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Keeps embedded bodies from breaking the document outline by pushing their headings below `floor`. */
export function demoteHeadings(markdown: string, floor: number): string {
  const levels = [...markdown.matchAll(/^(#{1,6}) /gm)].map((m) => m[1].length);
  if (levels.length === 0) return markdown;
  const shift = Math.max(0, floor - Math.min(...levels));
  if (shift === 0) return markdown;
  return markdown.replace(/^(#{1,6}) /gm, (_, hashes: string) =>
    "#".repeat(Math.min(6, hashes.length + shift)) + " "
  );
}

function cell(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim() || "—";
}

function section(title: string, body: string | null | undefined): string[] {
  return [`## ${title}`, "", body?.trim() ? demoteHeadings(body.trim(), 3) : "_(empty)_", ""];
}

function extractSprints(raw: unknown): ExportSprint[] {
  const fields = getObj(raw, "fields");
  const sprints = getObj(fields, customFields.sprint);
  if (!Array.isArray(sprints)) return [];
  return sprints.map((s) => ({
    id: typeof (s as Record<string, unknown>)?.id === "number" ? ((s as Record<string, unknown>).id as number) : 0,
    name: getStr(s, "name"),
    state: getStr(s, "state"),
    startDate: getStr(s, "startDate"),
    endDate: getStr(s, "endDate"),
    goal: getStr(s, "goal") || undefined,
  }));
}

function issueId(raw: unknown): string {
  return getStr(raw, "id");
}

function fieldTable(input: ExportInput, opts: ExportOptions): string[] {
  const { issue, raw } = input;
  const sprints = extractSprints(raw);
  const currentSprint = sprints.find((s) => s.state === "active") ?? sprints[sprints.length - 1] ?? null;
  const id = issueId(raw);
  const epic = issue.parentKey
    ? `${issue.parentKey}${issue.epicName ? ` — ${issue.epicName}` : ""}`
    : issue.epicKey;

  const rows: [string, string | null | undefined][] = [
    ["Key", id ? `${issue.key} (issue id \`${id}\`)` : issue.key],
    ["Summary", issue.summary],
    ["Type", issue.issueType],
    ["Status", issue.statusCategory ? `${issue.status} (category: ${issue.statusCategory})` : issue.status],
    ["Priority", issue.priority],
    ["Assignee", issue.assignee],
    ["Reporter", issue.reporter ?? null],
    ["Creator", issue.creator ?? null],
    ["Story points", issue.storyPoints === null ? null : String(issue.storyPoints)],
    ["Labels", issue.labels.length ? issue.labels.join(", ") : null],
    ["Team", issue.teamName ?? opts.teamLabel ?? issue.teamId],
    ["Epic / Parent", epic],
    ["Sprint", currentSprint ? `${currentSprint.name}${currentSprint.state ? ` (${currentSprint.state})` : ""}` : null],
    ["Created", issue.created],
    ["Updated", issue.updated],
    ["Due", issue.dueDate ?? null],
    ["Resolution", issue.resolution ?? null],
    ["Resolved", issue.resolutionDate ?? null],
  ];

  const lines = ["## Fields", "", "| Field | Value |", "|---|---|"];
  for (const [label, value] of rows) {
    lines.push(`| ${label} | ${cell(value)} |`);
  }
  lines.push("");

  if (sprints.length > 1) {
    lines.push(`Previous sprints: ${sprints.slice(0, -1).map((s) => s.name).join(", ")}`, "");
  }
  if (currentSprint?.goal) {
    lines.push("<details><summary>Sprint goal</summary>", "", currentSprint.goal.trim(), "", "</details>", "");
  }
  return lines;
}

function linkTable(links: IssueLinkData[]): string[] {
  if (links.length === 0) return [];
  const lines = ["### Links", "", "| Relation | Key | Summary | Status |", "|---|---|---|---|"];
  for (const link of links) {
    lines.push(
      `| ${cell(link.type)} | ${cell(link.linkedIssue.key)} | ${cell(link.linkedIssue.summary)} | ${cell(link.linkedIssue.status)} |`
    );
  }
  lines.push("");
  return lines;
}

function attachmentTable(attachments: AttachmentData[], opts: ExportOptions): string[] {
  if (attachments.length === 0) return [];
  const lines = ["### Attachments", "", "| Id | Filename | Size | Type | Uploaded by | Created | Local copy |", "|---|---|---|---|---|---|---|"];
  for (const att of attachments) {
    const local = opts.attachmentDir
      ? `[${att.filename}](${encodeURI(`${opts.attachmentDir}/${att.filename}`)})`
      : `[remote](${att.url})`;
    lines.push(
      `| ${att.id} | \`${att.filename}\` | ${formatBytes(att.size)} | ${cell(att.mimeType)} | ${cell(att.author)} | ${cell(att.created)} | ${local} |`
    );
  }
  lines.push("");
  return lines;
}

function commentSections(input: ExportInput, opts: ExportOptions): string[] {
  const { comments } = input;
  const bots = opts.botAuthors ?? DEFAULT_BOT_AUTHORS;
  const lines = [`## Comments (${comments.length})`, ""];
  if (comments.length === 0) {
    lines.push("_No comments._", "");
    return lines;
  }

  const collapsed = opts.keepBots ? [] : comments.filter((c) => isBotAuthor(c.author, bots));
  const expanded = comments.filter((c) => !collapsed.includes(c));

  if (collapsed.length > 0) {
    lines.push(`${collapsed.length} automated comment${collapsed.length === 1 ? "" : "s"} collapsed:`, "");
    for (const c of collapsed) {
      const firstLine = c.body.split("\n").find((l) => l.trim()) ?? "";
      lines.push(`- **${c.author}** ${c.created} — ${cell(firstLine)}`);
    }
    lines.push("");
  }

  for (const c of expanded) {
    lines.push(`### ${c.author} — ${c.created}${c.updated && c.updated !== c.created ? ` (edited ${c.updated})` : ""}`, "");
    lines.push(c.body.trim() ? demoteHeadings(c.body.trim(), 4) : "_(empty)_", "");
  }
  return lines;
}

const HISTORY_VALUE_LIMIT = 200;

function changeValue(value: string | null): string {
  if (!value) return "—";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > HISTORY_VALUE_LIMIT ? `${flat.slice(0, HISTORY_VALUE_LIMIT)}…` : flat;
}

function historyTable(history: HistoryData): string[] {
  const lines = [
    "## History",
    "",
    "| When | Who | Field | From | To |",
    "|---|---|---|---|---|",
    `| ${history.created.toISOString()} | ${cell(history.creator)} | Created | — | — |`,
  ];
  for (const event of history.events) {
    for (const change of event.changes) {
      lines.push(
        `| ${event.date.toISOString()} | ${cell(event.author)} | ${cell(change.field)} | ${cell(changeValue(change.from))} | ${cell(changeValue(change.to))} |`
      );
    }
  }
  lines.push("");
  return lines;
}

export function buildTicketMarkdown(input: ExportInput, opts: ExportOptions): string {
  const { issue } = input;
  const lines: string[] = [
    `# ${issue.key} — ${issue.summary}`,
    "",
    `Local copy of ${opts.jiraBase}/browse/${issue.key}`,
    `Captured ${opts.capturedAt} with \`tik export ${issue.key}\`.`,
    "",
    ...fieldTable(input, opts),
    ...linkTable(input.links),
    ...attachmentTable(issue.attachments, opts),
  ];

  if (input.availableTransitions?.length) {
    lines.push("### Available transitions", "", input.availableTransitions.join(", "), "");
  }

  lines.push(...section("Description", issue.description));
  lines.push(...section("Acceptance Criteria", issue.acceptanceCriteria));
  lines.push(...section("Testing Instructions", issue.testingInstructions));
  lines.push(...commentSections(input, opts));

  if (input.history) {
    lines.push(...historyTable(input.history));
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
