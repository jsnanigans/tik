import React from "react";
import { Box, Text } from "ink";
import { C, formatRelativeDate, abbreviateName, progressBar, truncate, stripAnsi } from "../lib";
import { highlightTerms, findExcerpts } from "../lib/fuzzy";
import { isStopWord } from "../lib/search";
import type { IssueData, SprintData, CommentData, IssueLinkData } from "../lib";
import type { PRMap, PRData } from "../github";
import { Table, type TableColumn } from "./table";
import {
  StatusCategory,
  getStatusColor,
  formatProjectKey,
  formatPriority,
  formatTypeIcon,
  formatPoints,
  formatPRStatus,
  formatEpicParent,
  fitAnsi,
} from "./format";

type LineBlockProps = {
  lines: string[];
};

function LineBlock({ lines }: LineBlockProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
    </Box>
  );
}


type IssueRow = {
  typeIcon: string;
  key: string;
  hier: string;
  summary: string;
  assignee: string;
  updated: string;
  points: string;
  priority: string;
  pr?: string;
  status?: string;
};

function buildIssueRow(
  issue: IssueData,
  width: number,
  options: {
    currentUserId?: string;
    prMap?: PRMap;
    showStatus?: boolean;
    rowIndex?: number;
    showPR?: boolean;
  }
): IssueRow {
  const keyWidth = 12;
  const typeWidth = 2;
  const hierWidth = 10;
  const assigneeWidth = 10;
  const dateWidth = 4;
  const pointsWidth = 2;
  const prioWidth = 2;
  const prWidth = options.showPR ? 5 : 0;
  const statusWidth = options.showStatus ? 14 : 0;
  const rightColWidth = assigneeWidth + dateWidth + pointsWidth + prioWidth + prWidth + statusWidth + 4;
  const summaryWidth = Math.max(10, width - keyWidth - typeWidth - hierWidth - rightColWidth - 5);

  const typeIcon = formatTypeIcon(issue.issueType);
  const key = formatProjectKey(issue.key);
  const hier = fitAnsi(formatEpicParent(issue, hierWidth), hierWidth);

  const summaryText = truncate(issue.summary, summaryWidth);
  const isAltRow = options.rowIndex !== undefined && options.rowIndex % 2 === 1;
  const summary = isAltRow ? `${C.dim}${summaryText}${C.reset}` : summaryText;

  const assignee = abbreviateName(issue.assignee);
  const isMe = options.currentUserId && issue.assigneeId === options.currentUserId;
  const assigneeDisplay = isMe
    ? `${C.brightGreen}@${assignee}${C.reset}`
    : assignee
      ? `${C.dim}@${assignee}${C.reset}`
      : `${C.dim}──${C.reset}`;

  const updated = `${C.dim}${formatRelativeDate(issue.updated)}${C.reset}`;
  const points = formatPoints(issue.storyPoints);
  const prio = formatPriority(issue.priorityId);

  let prStatus: string | undefined;
  if (options.showPR) {
    prStatus = formatPRStatus(options.prMap?.get(issue.key));
  }

  let statusCol: string | undefined;
  if (options.showStatus) {
    const statusColor = getStatusColor(issue.status);
    const statusAbbrev = truncate(issue.status, statusWidth - 1);
    statusCol = `${statusColor}${statusAbbrev}${C.reset}`;
  }

  return {
    typeIcon,
    key,
    hier,
    summary,
    assignee: assigneeDisplay,
    updated,
    points,
    priority: prio,
    pr: prStatus,
    status: statusCol,
  };
}

function issueColumns(width: number, showPR: boolean, showStatus: boolean): TableColumn<IssueRow>[] {
  const keyWidth = 12;
  const typeWidth = 2;
  const hierWidth = 10;
  const assigneeWidth = 10;
  const dateWidth = 4;
  const pointsWidth = 2;
  const prioWidth = 2;
  const prWidth = showPR ? 5 : 0;
  const statusWidth = showStatus ? 14 : 0;
  const rightColWidth = assigneeWidth + dateWidth + pointsWidth + prioWidth + prWidth + statusWidth + 4;
  const summaryWidth = Math.max(10, width - keyWidth - typeWidth - hierWidth - rightColWidth - 5);

  const cols: TableColumn<IssueRow>[] = [
    { key: "type", width: typeWidth, render: row => row.typeIcon },
    { key: "key", width: keyWidth, render: row => row.key },
    { key: "hier", width: hierWidth, render: row => row.hier },
    { key: "summary", width: summaryWidth, render: row => row.summary },
    { key: "assignee", width: assigneeWidth, align: "right", render: row => row.assignee },
    { key: "updated", width: dateWidth, align: "right", render: row => row.updated },
    { key: "points", width: pointsWidth, align: "right", render: row => row.points },
    { key: "prio", width: prioWidth, render: row => row.priority },
  ];

  if (showPR) {
    cols.push({ key: "pr", width: prWidth, render: row => row.pr ?? "" });
  }

  if (showStatus) {
    cols.push({ key: "status", width: statusWidth, render: row => row.status ?? "" });
  }

  return cols;
}

type SectionHeaderProps = {
  label: string;
  count: number;
  color: string;
};

function SectionHeader({ label, count, color }: SectionHeaderProps): JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{` ${color}${C.bold}${label}${C.reset} ${C.dim}(${count})${C.reset}`}</Text>
    </Box>
  );
}

type IssueListViewProps = {
  title?: string;
  issues: IssueData[];
  grouped?: boolean;
  expandDone?: boolean;
  prMap?: PRMap;
  currentUserId?: string;
  showPR?: boolean;
  showStatus?: boolean;
};

export function IssueListView({
  title,
  issues,
  grouped = true,
  expandDone = false,
  prMap,
  currentUserId,
  showPR = false,
  showStatus = false,
}: IssueListViewProps): JSX.Element {
  const width = process.stdout.columns || 100;

  if (issues.length === 0) {
    return <Text>{`${C.dim}No issues found${C.reset}`}</Text>;
  }

  const rowsFor = (items: IssueData[]) => {
    let rowIndex = 0;
    return items.map(issue => buildIssueRow(issue, width, {
      currentUserId,
      prMap,
      showStatus,
      rowIndex: rowIndex++,
      showPR,
    }));
  };

  if (!grouped) {
    const rows = rowsFor(issues);
    return (
      <Box flexDirection="column">
        {title && <Text>{` ${C.bold}${title}${C.reset} ${C.dim}(${issues.length})${C.reset}`}</Text>}
        <Table columns={issueColumns(width, showPR, true)} rows={rows} showHeader={false} />
      </Box>
    );
  }

  const categorized = new Map<string, IssueData[]>();
  for (const issue of issues) {
    const status = issue.status;
    let category = "other";
    if (StatusCategory.inProgress.statuses.includes(status)) {
      category = "inProgress";
    } else if (StatusCategory.review.statuses.includes(status)) {
      category = "review";
    } else if (StatusCategory.ready.statuses.includes(status)) {
      category = "ready";
    } else if (StatusCategory.done.statuses.includes(status)) {
      category = "done";
    } else {
      for (const [subgroup, statuses] of Object.entries(StatusCategory.todo.subgroups)) {
        if (statuses.includes(status)) {
          category = `todo:${subgroup}`;
          break;
        }
      }
      if (category === "other") {
        category = "todo:Other";
      }
    }
    if (!categorized.has(category)) {
      categorized.set(category, []);
    }
    categorized.get(category)!.push(issue);
  }

  const byUpdated = (items: IssueData[]) =>
    [...items].sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());

  for (const [key, groupIssues] of categorized) {
    categorized.set(key, byUpdated(groupIssues));
  }

  const todoGroups = [...Object.keys(StatusCategory.todo.subgroups), "Other"];

  return (
    <Box flexDirection="column">
      {title && <Text>{` ${C.bold}${title}${C.reset} ${C.dim}(${issues.length} issues)${C.reset}`}</Text>}

      {(() => {
        const group = categorized.get("inProgress") || [];
        return group.length ? (
          <Box flexDirection="column">
            <SectionHeader label={StatusCategory.inProgress.label} count={group.length} color={StatusCategory.inProgress.color} />
            <Table columns={issueColumns(width, showPR, false)} rows={rowsFor(group)} showHeader={false} />
          </Box>
        ) : null;
      })()}

      {(() => {
        const group = categorized.get("review") || [];
        return group.length ? (
          <Box flexDirection="column">
            <SectionHeader label={StatusCategory.review.label} count={group.length} color={StatusCategory.review.color} />
            <Table columns={issueColumns(width, showPR, false)} rows={rowsFor(group)} showHeader={false} />
          </Box>
        ) : null;
      })()}

      {(() => {
        const group = categorized.get("ready") || [];
        return group.length ? (
          <Box flexDirection="column">
            <SectionHeader label={StatusCategory.ready.label} count={group.length} color={StatusCategory.ready.color} />
            <Table columns={issueColumns(width, showPR, false)} rows={rowsFor(group)} showHeader={false} />
          </Box>
        ) : null;
      })()}

      {(() => {
        const todoIssues: IssueData[] = [];
        for (const group of todoGroups) {
          const groupIssues = categorized.get(`todo:${group}`) || [];
          todoIssues.push(...groupIssues);
        }

        if (!todoIssues.length) return null;

        return (
          <Box flexDirection="column">
            <SectionHeader label={StatusCategory.todo.label} count={todoIssues.length} color={StatusCategory.todo.color} />
            {todoGroups.map(group => {
              const groupIssues = categorized.get(`todo:${group}`) || [];
              if (!groupIssues.length) return null;
              return (
                <Box key={group} flexDirection="column" marginLeft={2}>
                  <Text>{`${C.dim}▸ ${group} (${groupIssues.length})${C.reset}`}</Text>
                  <Table columns={issueColumns(width, showPR, false)} rows={rowsFor(groupIssues)} showHeader={false} />
                </Box>
              );
            })}
          </Box>
        );
      })()}

      {(() => {
        const done = categorized.get("done") || [];
        if (!done.length) return null;
        if (expandDone) {
          return (
            <Box flexDirection="column">
              <SectionHeader label={StatusCategory.done.label} count={done.length} color={StatusCategory.done.color} />
              <Table columns={issueColumns(width, showPR, false)} rows={rowsFor(done)} showHeader={false} />
            </Box>
          );
        }

        const statusCounts = new Map<string, number>();
        for (const issue of done) {
          statusCounts.set(issue.status, (statusCounts.get(issue.status) || 0) + 1);
        }
        const summary = Array.from(statusCounts.entries())
          .map(([status, count]) => `${status}: ${count}`)
          .join("  ·  ");

        return (
          <Box flexDirection="column" marginTop={1}>
            <Text>{` ${C.dim}${C.bold}DONE${C.reset} ${C.dim}✓ ${done.length} ollapsed${C.reset}`}</Text>
            <Text>{`   ${C.dim}└─ ${summary}${C.reset}`}</Text>
          </Box>
        );
      })()}
    </Box>
  );
}

type SprintHeaderViewProps = {
  sprint: SprintData;
  issues: IssueData[];
};

function SprintHeaderView({ sprint, issues }: SprintHeaderViewProps): JSX.Element {
  const width = process.stdout.columns || 100;
  const start = new Date(sprint.startDate);
  const end = new Date(sprint.endDate);
  const now = new Date();
  const totalDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  const elapsedDays = Math.max(0, Math.ceil((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
  const percent = Math.min(100, Math.round((elapsedDays / totalDays) * 100));

  const categorized = new Map<string, IssueData[]>();
  for (const issue of issues) {
    const status = issue.status;
    let category = "other";
    if (StatusCategory.inProgress.statuses.includes(status)) category = "inProgress";
    else if (StatusCategory.review.statuses.includes(status)) category = "review";
    else if (StatusCategory.ready.statuses.includes(status)) category = "ready";
    else if (StatusCategory.done.statuses.includes(status)) category = "done";
    if (!categorized.has(category)) categorized.set(category, []);
    categorized.get(category)!.push(issue);
  }

  const inProgressCount = (categorized.get("inProgress") || []).length;
  const reviewCount = (categorized.get("review") || []).length;
  const readyCount = (categorized.get("ready") || []).length;
  const doneCount = (categorized.get("done") || []).length;
  const todoCount = issues.length - inProgressCount - reviewCount - readyCount - doneCount;

  const startStr = sprint.startDate.slice(5, 10).replace("-", "/");
  const endStr = sprint.endDate.slice(5, 10).replace("-", "/");

  const statsLine = `  ${progressBar(percent, 20)}  ${percent}%  ·  ${C.yellow}${inProgressCount} active${C.reset}  ·  ${C.green}${doneCount} done${C.reset}  ·  ${todoCount} todo`;
  const statsLineLen = stripAnsi(statsLine).length;

  const lines = [
    "",
    `${C.dim}╭${"─".repeat(width - 2)}╮${C.reset}`,
    `${C.dim}│${C.reset}  ${C.bold}🏃 ${sprint.name}${C.reset}${" ".repeat(Math.max(0, width - sprint.name.length - 7))}${C.dim}│${C.reset}`,
    `${C.dim}│${C.reset}  ${C.gray}${startStr} → ${endStr}  ·  Day ${elapsedDays} of ${totalDays}${C.reset}${" ".repeat(Math.max(0, width - 30 - String(elapsedDays).length - String(totalDays).length))}${C.dim}│${C.reset}`,
    `${C.dim}│${C.reset}${statsLine}${" ".repeat(Math.max(0, width - statsLineLen - 1))}${C.dim}│${C.reset}`,
    `${C.dim}╰${"─".repeat(width - 2)}╯${C.reset}`,
    "",
  ];

  return <LineBlock lines={lines} />;
}

export function SprintSummaryView({ sprint }: { sprint: SprintData }): JSX.Element {
  return <SprintHeaderView sprint={sprint} issues={[]} />;
}

type SprintViewProps = {
  sprint: SprintData;
  issues: IssueData[];
  allIssues?: IssueData[];
  expandDone?: boolean;
  mineOnly?: boolean;
  currentUserId?: string;
  prMap?: PRMap;
  wasMineKeys?: Set<string>;
  qaAccountIds?: Set<string>;
  showPR?: boolean;
};

export function SprintView({
  sprint,
  issues,
  allIssues,
  expandDone = false,
  mineOnly = false,
  currentUserId,
  prMap,
  wasMineKeys,
  qaAccountIds,
  showPR = false,
}: SprintViewProps): JSX.Element {
  let filteredIssues = issues;
  if (mineOnly && currentUserId) {
    filteredIssues = filteredIssues.filter(i =>
      i.assigneeId === currentUserId ||
      (wasMineKeys?.has(i.key) && i.assigneeId && qaAccountIds?.has(i.assigneeId))
    );
  }

  return (
    <Box flexDirection="column">
      <SprintHeaderView sprint={sprint} issues={allIssues ?? issues} />
      {filteredIssues.length === 0 && mineOnly ? (
        <Box flexDirection="column">
          <Text>{`   ${C.dim}No issues assigned to you in this sprint${C.reset}`}</Text>
          <Text>{`   ${C.dim}Use${C.reset} jira sprint -a ${C.dim}to see all team issues${C.reset}`}</Text>
        </Box>
      ) : (
        <IssueListView
          issues={filteredIssues}
          grouped
          expandDone={expandDone}
          currentUserId={currentUserId}
          prMap={prMap}
          showPR={showPR}
        />
      )}
    </Box>
  );
}

type SprintGoalsViewProps = {
  sprint: SprintData;
};

export function SprintGoalsView({ sprint }: SprintGoalsViewProps): JSX.Element {
  const width = process.stdout.columns || 100;
  const lines: string[] = [];

  lines.push("");
  lines.push(`${C.dim}╭${"─".repeat(width - 2)}╮${C.reset}`);
  lines.push(`${C.dim}│${C.reset}  ${C.bold}🎯 Sprint Goals${C.reset}  ${C.dim}${sprint.name}${C.reset}`);
  lines.push(`${C.dim}├${"─".repeat(width - 2)}┤${C.reset}`);

  if (!sprint.goal) {
    lines.push(`${C.dim}│${C.reset}  ${C.dim}No goals set for this sprint${C.reset}`);
    lines.push(`${C.dim}╰${"─".repeat(width - 2)}╯${C.reset}`);
    lines.push("");
    return <LineBlock lines={lines} />;
  }

  const goalLines = sprint.goal.split("\n");
  for (const line of goalLines) {
    if (!line.trim()) {
      lines.push(`${C.dim}│${C.reset}`);
      continue;
    }

    let formatted = line;

    if (/^[🚀🛠️🐞🧠🎯✨📋🔥⚡️💡🎉]/.test(line.trim())) {
      formatted = `${C.bold}${line}${C.reset}`;
    } else if (line.trim().startsWith("-")) {
      const indent = line.match(/^(\s*)/)?.[1] || "";
      const content = line.trim().slice(1).trim();
      const highlighted = content.replace(/([A-Z]+-\d+)/g, `${C.cyan}$1${C.reset}`);
      const withNames = highlighted.replace(/\(([^)]+)\)/g, `${C.dim}($1)${C.reset}`);
      formatted = `${indent}${C.dim}•${C.reset} ${withNames}`;
    }

    const displayLine = formatted.length > width - 4
      ? formatted.slice(0, width - 5) + "…"
      : formatted;

    lines.push(`${C.dim}│${C.reset}  ${displayLine}`);
  }

  lines.push(`${C.dim}╰${"─".repeat(width - 2)}╯${C.reset}`);
  lines.push("");

  return <LineBlock lines={lines} />;
}

type LinksViewProps = {
  ticketKey: string;
  links: IssueLinkData[];
};

export function LinksView({ ticketKey, links }: LinksViewProps): JSX.Element {
  const width = process.stdout.columns || 100;

  const rows = links.map(link => ({
    type: `${C.dim}${link.type}${C.reset}`,
    key: formatProjectKey(link.linkedIssue.key),
    status: `${getStatusColor(link.linkedIssue.status)}●${C.reset}`,
    summary: truncate(link.linkedIssue.summary, Math.max(10, width - 60)),
  }));

  const columns: TableColumn<typeof rows[number]>[] = [
    { key: "type", width: 20, render: row => row.type },
    { key: "key", width: 14, render: row => row.key },
    { key: "status", width: 2, render: row => row.status },
    { key: "summary", render: row => row.summary },
  ];

  return (
    <Box flexDirection="column">
      <Text>{` ${C.bold}Links on ${formatProjectKey(ticketKey)}${C.reset} ${C.dim}(${links.length})${C.reset}`}</Text>
      {links.length === 0 ? (
        <Text>{`   ${C.dim}No links${C.reset}`}</Text>
      ) : (
        <Table columns={columns} rows={rows} showHeader={false} />
      )}
    </Box>
  );
}

type RenderedComment = CommentData & { renderedBody?: string };

type CommentsViewProps = {
  ticketKey: string;
  comments: RenderedComment[];
  full?: boolean;
};

const COMMENT_PREVIEW_LINES = 15;

export function CommentsView({ ticketKey, comments, full }: CommentsViewProps): JSX.Element {
  if (comments.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>{` ${C.bold}Comments on ${formatProjectKey(ticketKey)}${C.reset} ${C.dim}(0)${C.reset}`}</Text>
        <Text>{`   ${C.dim}No comments${C.reset}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{` ${C.bold}Comments on ${formatProjectKey(ticketKey)}${C.reset} ${C.dim}(${comments.length})${C.reset}`}</Text>
      {comments.map((comment, idx) => {
        const bodyLines = (comment.renderedBody || comment.body).split("\n");
        const relDate = formatRelativeDate(comment.created);
        const shownLines = full ? bodyLines : bodyLines.slice(0, COMMENT_PREVIEW_LINES);
        const hiddenCount = bodyLines.length - shownLines.length;
        return (
          <Box key={`${comment.author}-${idx}`} flexDirection="column" marginTop={1}>
            <Text>{`${C.dim}╭${"─".repeat(70)}╮${C.reset}`}</Text>
            <Text>{`${C.dim}│${C.reset}  ${C.bold}${comment.author}${C.reset}  ${C.dim}${relDate}${C.reset}`}</Text>
            <Text>{`${C.dim}├${"─".repeat(70)}┤${C.reset}`}</Text>
            {shownLines.map((line, lineIdx) => (
              <Text key={lineIdx}>{`${C.dim}│${C.reset}  ${line}`}</Text>
            ))}
            {hiddenCount > 0 && (
              <Text>{`${C.dim}│${C.reset}  ${C.dim}... (${hiddenCount} more lines — use ${C.reset}${C.cyan}--full${C.reset}${C.dim})${C.reset}`}</Text>
            )}
            <Text>{`${C.dim}╰${"─".repeat(70)}╯${C.reset}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

type SearchResultsViewProps = {
  issues: IssueData[];
  query: string;
  expandDone?: boolean;
  currentUserId?: string;
  showPR?: boolean;
  prMap?: PRMap;
};

const HL_ON = "\x1b[4m\x1b[1m"; // underline + bold
const HL_OFF = C.reset;
const HL_DIM_OFF = C.reset + C.dim; // restore dim after highlight in excerpt

export function SearchResultsView({
  issues,
  query,
  expandDone = false,
  currentUserId,
  showPR = false,
  prMap,
}: SearchResultsViewProps): JSX.Element {
  const width = process.stdout.columns || 100;

  if (issues.length === 0) {
    return <Text>{`${C.dim}No issues found${C.reset}`}</Text>;
  }

  const terms = query.toLowerCase().split(/\s+/).filter(t => t && !isStopWord(t));

  // Separate done issues
  const doneIssues: IssueData[] = [];
  const activeIssues: IssueData[] = [];
  for (const issue of issues) {
    if (StatusCategory.done.statuses.includes(issue.status)) {
      doneIssues.push(issue);
    } else {
      activeIssues.push(issue);
    }
  }

  const buildResultLines = (items: IssueData[]): string[] => {
    const lines: string[] = [];

    for (const issue of items) {
      const typeIcon = formatTypeIcon(issue.issueType);
      const key = formatProjectKey(issue.key);
      const statusColor = getStatusColor(issue.status);

      // Right-side metadata
      const assignee = abbreviateName(issue.assignee);
      const isMe = currentUserId && issue.assigneeId === currentUserId;
      const assigneeStr = isMe
        ? `${C.brightGreen}@${assignee}${C.reset}`
        : assignee
          ? `${C.dim}@${assignee}${C.reset}`
          : `${C.dim}──${C.reset}`;
      const dateStr = `${C.dim}${formatRelativeDate(issue.updated)}${C.reset}`;
      const prioStr = formatPriority(issue.priorityId);
      const statusStr = `${statusColor}${issue.status}${C.reset}`;
      const prStr = showPR ? ` ${formatPRStatus(prMap?.get(issue.key))}` : "";

      const rightParts = [assigneeStr, dateStr, prioStr, statusStr].filter(Boolean);
      if (prStr) rightParts.push(prStr);
      const rightSide = rightParts.join(`${C.dim}  ${C.reset}`);
      const rightVisibleLen = stripAnsi(rightSide).length;

      // Summary gets remaining space
      const leftFixedLen = stripAnsi(typeIcon).length + 2 + issue.key.length + 2; // "icon  KEY  "
      const summaryWidth = Math.max(10, width - leftFixedLen - rightVisibleLen - 2);
      const rawSummary = truncate(issue.summary, summaryWidth);
      const highlightedSummary = highlightTerms(rawSummary, terms, HL_ON, HL_OFF, true);
      const summaryPad = " ".repeat(Math.max(1, summaryWidth - rawSummary.length));

      lines.push(`${typeIcon}  ${key}  ${highlightedSummary}${summaryPad}${rightSide}`);

      // Excerpt lines — search across description, AC, TI
      const excerptFields: Array<{ text: string; label?: string }> = [];
      if (issue.description) excerptFields.push({ text: issue.description });
      if (issue.acceptanceCriteria) excerptFields.push({ text: issue.acceptanceCriteria, label: "AC" });
      if (issue.testingInstructions) excerptFields.push({ text: issue.testingInstructions, label: "TI" });

      const excerpts = findExcerpts(terms, excerptFields, 5, 120);
      for (const { excerpt, label } of excerpts) {
        const maxExcerptWidth = width - 6 - (label ? label.length + 2 : 0);
        const highlighted = highlightTerms(
          truncate(excerpt, maxExcerptWidth),
          terms,
          HL_ON,
          HL_DIM_OFF,
          true,
        );
        const prefix = label ? `${C.dim}[${label}] ` : `${C.dim}`;
        lines.push(`   ${prefix}${highlighted}${C.reset}`);
      }

      lines.push(" ");
    }
    return lines;
  };

  const activeLines = buildResultLines(activeIssues);

  let doneLines: string[] = [];
  if (doneIssues.length > 0) {
    if (expandDone) {
      doneLines = buildResultLines(doneIssues);
    } else {
      const statusCounts = new Map<string, number>();
      for (const issue of doneIssues) {
        statusCounts.set(issue.status, (statusCounts.get(issue.status) || 0) + 1);
      }
      const summary = Array.from(statusCounts.entries())
        .map(([status, count]) => `${status}: ${count}`)
        .join("  ·  ");
      doneLines = [
        "",
        ` ${C.dim}${C.bold}DONE${C.reset} ${C.dim}✓ ${doneIssues.length} collapsed [--e to show]${C.reset}`,
        `   ${C.dim}└─ ${summary}${C.reset}`,
      ];
    }
  }

  const allLines = [
    ` ${C.bold}Search Results${C.reset}${query ? ` ${C.dim}for '${query}'${C.reset}` : ""} ${C.dim}(${issues.length})${C.reset}`,
    "",
    ...activeLines,
    ...doneLines,
  ];

  return <LineBlock lines={allLines} />;
}

type HelpViewProps = {
  help: string;
};

export function HelpView({ help }: HelpViewProps): JSX.Element {
  return <LineBlock lines={help.split("\n")} />;
}
