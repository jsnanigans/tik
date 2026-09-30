import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { C, truncate, stripAnsi } from "../lib";
import type { Credentials } from "../lib";
import { jiraGet, jiraPost, jiraPut } from "../lib";
import type { IssueData } from "../lib";
import { formatProjectKey, getStatusColor, formatTypeIcon } from "./format";
import { renderInteractive } from "./render";
import { requireCustomField } from "../lib/config";

type Sprint = { id: number; name: string };

export type TriageIssue = IssueData & {
  sprint?: Sprint | null;
  teamId?: string | null;
  teamName?: string | null;
};

type FetchIssuesResult = {
  issues: TriageIssue[];
  sprints: Sprint[];
};

type EditableField = "status" | "type" | "sprint" | "points" | "team" | "assignee";

type OptionItem = {
  value: string | null;
  label: string;
  hint?: string;
};

type TriageAppProps = {
  creds: Credentials;
  myTeamId: string;
  myTeamName: string;
  fetchIssues: () => Promise<FetchIssuesResult>;
  showAll: boolean;
  onExit: () => void;
};

const SIDE_PANEL_MIN_WIDTH = 130;
const SIDE_PANEL_WIDTH = 30;

function abbreviateSprint(name: string): string {
  const match = name.match(/Sprint\s*(\d+)/i);
  if (match) return `S${match[1]}`;
  if (name.length <= 5) return name;
  return name.slice(0, 4) + "…";
}

function statusDot(status: string): string {
  const color = getStatusColor(status);
  return `${color}●${C.reset}`;
}

function formatTeamShort(teamId: string | null | undefined, myTeamId: string): string {
  if (!teamId) return `${C.dim}·${C.reset}`;
  if (teamId === myTeamId) return `${C.green}M${C.reset}`;
  return `${C.dim}?${C.reset}`;
}

function formatPointsShort(pts: number | null | undefined): string {
  if (pts === null || pts === undefined) return `${C.dim}·${C.reset}`;
  return `${C.dim}${pts}${C.reset}`;
}

function formatAssigneeShort(name: string | null | undefined, maxLen: number): string {
  if (!name) return `${C.dim}──${C.reset}`;
  const first = name.split(" ")[0];
  if (first.length <= maxLen) return first;
  return first.slice(0, maxLen - 1) + "…";
}

export function filterIssues(issues: TriageIssue[], showAll: boolean): TriageIssue[] {
  if (showAll) return issues;
  return issues.filter((issue) => {
    const missingSprint = !issue.sprint?.id;
    const missingPoints = issue.storyPoints === null || issue.storyPoints === undefined;
    const missingTeam = !issue.teamId;
    const missingType = !issue.issueType;
    return missingSprint || missingPoints || missingTeam || missingType;
  });
}

function visLen(s: string): number {
  return stripAnsi(s).length;
}

function padCell(value: string, width: number, align: "left" | "right" = "left"): string {
  const len = visLen(value);
  if (len >= width) return value;
  const gap = width - len;
  return align === "right" ? " ".repeat(gap) + value : value + " ".repeat(gap);
}

type RowData = {
  key: string;
  cells: string[];
};

function buildRow(
  row: TriageIssue,
  summaryWidth: number,
  assigneeWidth: number,
  sprintWidth: number,
  myTeamId: string,
): string[] {
  return [
    padCell(formatProjectKey(row.key), 10),
    padCell(formatTypeIcon(row.issueType), 2),
    padCell(truncate(row.summary, summaryWidth), summaryWidth),
    padCell(row.sprint?.name ? abbreviateSprint(row.sprint.name) : `${C.dim}──${C.reset}`, sprintWidth),
    padCell(formatPointsShort(row.storyPoints), 2, "right"),
    padCell(formatTeamShort(row.teamId, myTeamId), 2),
    padCell(formatAssigneeShort(row.assignee, assigneeWidth), assigneeWidth),
    padCell(statusDot(row.status), 2),
  ];
}

function computeLayout(termWidth: number) {
  const showSidePanel = termWidth >= SIDE_PANEL_MIN_WIDTH;
  const tableWidth = showSidePanel ? termWidth - SIDE_PANEL_WIDTH - 4 : termWidth;
  const pointerWidth = 2;

  const keyW = 10;
  const typeW = 2;
  const sprintW = 5;
  const ptsW = 2;
  const teamW = 2;
  const statusW = 2;
  const seps = 7;

  let assigneeW = 8;
  if (tableWidth < 90) assigneeW = 6;

  const fixedW = keyW + typeW + sprintW + ptsW + teamW + assigneeW + statusW + seps + pointerWidth;
  const summaryW = Math.max(12, tableWidth - fixedW);

  return { showSidePanel, tableWidth, summaryW, assigneeW, sprintW };
}

const EDITABLE_FIELDS: EditableField[] = ["status", "type", "sprint", "points", "team", "assignee"];

function TriageApp({
  creds,
  myTeamId,
  myTeamName,
  fetchIssues,
  showAll,
  onExit,
}: TriageAppProps): JSX.Element {
  const { exit } = useApp();
  const [issues, setIssues] = useState<TriageIssue[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"list" | "field" | "options">("list");
  const [field, setField] = useState<EditableField | null>(null);
  const [options, setOptions] = useState<OptionItem[]>([]);
  const [optionIndex, setOptionIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [myself, setMyself] = useState<{ accountId: string; displayName: string } | null>(null);

  const width = process.stdout.columns || 120;
  const layout = useMemo(() => computeLayout(width), [width]);
  const visibleIssues = useMemo(() => filterIssues(issues, showAll), [issues, showAll]);
  const activeIssue = visibleIssues[selected];

  const rows: RowData[] = useMemo(() =>
    visibleIssues.map((issue) => ({
      key: issue.key,
      cells: buildRow(issue, layout.summaryW, layout.assigneeW, layout.sprintW, myTeamId),
    })),
    [visibleIssues, layout, myTeamId],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { issues: nextIssues, sprints: nextSprints } = await fetchIssues();
      setIssues(nextIssues);
      setSprints(nextSprints);
      setSelected(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetchIssues]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (selected >= visibleIssues.length) setSelected(Math.max(0, visibleIssues.length - 1));
  }, [visibleIssues.length, selected]);

  const openOptions = useCallback(async (nextField: EditableField) => {
    if (!activeIssue) return;
    setBusy("Loading options...");
    try {
      let nextOptions: OptionItem[] = [];
      switch (nextField) {
        case "type":
          nextOptions = [
            { value: "Task", label: "Task" },
            { value: "Bug", label: "Bug" },
            { value: "Story", label: "Story" },
            { value: "Sub-task", label: "Sub-task" },
          ];
          break;
        case "sprint":
          nextOptions = [
            { value: null, label: "(none) Remove from sprint" },
            ...sprints.map((s) => ({ value: String(s.id), label: s.name })),
          ];
          break;
        case "points":
          nextOptions = [
            { value: null, label: "(none) Clear points" },
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
            { value: "5", label: "5" },
            { value: "8", label: "8" },
          ];
          break;
        case "team":
          nextOptions = [
            { value: null, label: "(none) Remove team" },
            ...(myTeamId ? [{ value: "mine", label: myTeamName }] : []),
          ];
          break;
        case "assignee": {
          let me = myself;
          if (!me) {
            me = await jiraGet(creds, "/rest/api/3/myself") as { accountId: string; displayName: string };
            setMyself(me);
          }
          const label = `Assign to me (${me.displayName})`;
          nextOptions = [
            { value: "_keep", label: "Keep current" },
            { value: "_unassign", label: "Unassign" },
            { value: "_me", label },
          ];
          break;
        }
        case "status": {
          const transitionsResp = (await jiraGet(creds, `/rest/api/3/issue/${activeIssue.key}/transitions`)) as {
            transitions?: { id: string; name: string }[];
          };
          const transitions = transitionsResp.transitions || [];
          nextOptions = transitions.map((t) => ({ value: t.id, label: t.name }));
          break;
        }
      }
      setField(nextField);
      setOptions(nextOptions);
      setOptionIndex(0);
      setMode("options");
    } catch (err) {
      setMessage(`${C.red}Failed to load options${C.reset}`);
      setMode("field");
      setField(null);
    } finally {
      setBusy(null);
    }
  }, [activeIssue, sprints, myself, creds]);

  const applyFieldUpdate = useCallback(async (issue: TriageIssue, editField: EditableField, option: OptionItem) => {
    setBusy("Updating ticket...");
    setMessage(null);
    try {
      const updates: Partial<TriageIssue> = {};

      if (editField === "status" && option.value) {
        await jiraPost(creds, `/rest/api/3/issue/${issue.key}/transitions`, {
          transition: { id: option.value },
        });
        updates.status = option.label;
      } else {
        const fields: Record<string, unknown> = {};
        if (editField === "type" && option.value) {
          fields.issuetype = { name: option.value };
          updates.issueType = option.value;
        }
        if (editField === "sprint") {
          fields[requireCustomField("sprint")] = option.value ? parseInt(option.value, 10) : null;
          updates.sprint = option.value
            ? sprints.find((s) => s.id === parseInt(option.value!, 10)) || null
            : null;
        }
        if (editField === "points") {
          fields[requireCustomField("storyPoints")] = option.value ? parseInt(option.value, 10) : null;
          updates.storyPoints = option.value ? parseInt(option.value, 10) : null;
        }
        if (editField === "team") {
          fields[requireCustomField("team")] = option.value === "mine" ? myTeamId : null;
          updates.teamId = option.value === "mine" ? myTeamId : null;
          updates.teamName = option.value === "mine" ? myTeamName : null;
        }
        if (editField === "assignee") {
          if (option.value === "_unassign") {
            fields.assignee = null;
            updates.assignee = null;
            updates.assigneeId = null;
          } else if (option.value === "_me") {
            const me = myself || (await jiraGet(creds, "/rest/api/3/myself") as { accountId: string; displayName: string });
            setMyself(me);
            fields.assignee = { accountId: me.accountId };
            updates.assignee = me.displayName;
            updates.assigneeId = me.accountId;
          } else {
            setBusy(null);
            setMode("list");
            return;
          }
        }
        if (Object.keys(fields).length > 0) {
          const result = await jiraPut(creds, `/rest/api/3/issue/${issue.key}`, { fields });
          if (!result.ok) throw new Error(result.error || "Update failed");
        }
      }
      setIssues((prev) =>
        prev.map((i) => (i.key === issue.key ? { ...i, ...updates } : i))
      );
      setMessage(`${C.green}✓${C.reset} Updated ${issue.key}`);
    } catch (err) {
      setMessage(`${C.red}✗${C.reset} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
      setMode("list");
      setField(null);
      setOptions([]);
      setOptionIndex(0);
    }
  }, [creds, sprints, myself, myTeamId]);

  useInput((input, key) => {
    if (busy) return;
    if (mode === "list") {
      if (input === "q") {
        onExit();
        exit();
        return;
      }
      if (input === "r") {
        void refresh();
        return;
      }
      if (input === "j" || key.downArrow) {
        setSelected((idx) => Math.min(visibleIssues.length - 1, idx + 1));
        return;
      }
      if (input === "k" || key.upArrow) {
        setSelected((idx) => Math.max(0, idx - 1));
        return;
      }
      if (input === "g") {
        setSelected(0);
        return;
      }
      if (input === "G") {
        setSelected(Math.max(0, visibleIssues.length - 1));
        return;
      }
      if (input === "e" || key.return) {
        setOptionIndex(0);
        setMode("field");
        return;
      }
    } else if (mode === "field") {
      if (key.escape || input === "q") {
        setMode("list");
        setField(null);
        return;
      }
      if (input === "j" || key.downArrow) {
        setOptionIndex((idx) => Math.min(EDITABLE_FIELDS.length - 1, idx + 1));
        return;
      }
      if (input === "k" || key.upArrow) {
        setOptionIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (key.return) {
        void openOptions(EDITABLE_FIELDS[optionIndex]);
        return;
      }
    } else if (mode === "options") {
      if (key.escape || input === "q") {
        setMode("field");
        setField(null);
        setOptions([]);
        setOptionIndex(0);
        return;
      }
      if (input === "j" || key.downArrow) {
        setOptionIndex((idx) => Math.min(options.length - 1, idx + 1));
        return;
      }
      if (input === "k" || key.upArrow) {
        setOptionIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (key.return) {
        const option = options[optionIndex];
        if (option && activeIssue && field) {
          void applyFieldUpdate(activeIssue, field, option);
        }
      }
    }
  });

  const formatTeamFull = (teamId: string | null | undefined): string => {
    if (!teamId) return "-";
    if (teamId === myTeamId) return myTeamName;
    return "Other";
  };

  const detailLines = activeIssue ? [
    `${formatProjectKey(activeIssue.key)} ${C.dim}${activeIssue.status}${C.reset}`,
    truncate(activeIssue.summary, SIDE_PANEL_WIDTH - 4),
    `${C.dim}Type:${C.reset}     ${activeIssue.issueType}`,
    `${C.dim}Sprint:${C.reset}   ${activeIssue.sprint?.name ?? "-"}`,
    `${C.dim}Points:${C.reset}   ${activeIssue.storyPoints ?? "-"}`,
    `${C.dim}Team:${C.reset}     ${formatTeamFull(activeIssue.teamId)}`,
    `${C.dim}Assignee:${C.reset} ${activeIssue.assignee ?? "-"}`,
  ] : [`${C.dim}No tickets${C.reset}`];

  const detailBar = activeIssue ? (
    `${formatProjectKey(activeIssue.key)} ${getStatusColor(activeIssue.status)}●${C.reset} ${C.dim}${activeIssue.status}${C.reset}` +
    ` ${C.dim}│${C.reset} ${activeIssue.issueType}` +
    ` ${C.dim}│${C.reset} ${activeIssue.sprint?.name ?? `${C.dim}no sprint${C.reset}`}` +
    ` ${C.dim}│${C.reset} ${activeIssue.storyPoints != null ? `${activeIssue.storyPoints} pts` : `${C.dim}no pts${C.reset}`}` +
    ` ${C.dim}│${C.reset} ${formatTeamFull(activeIssue.teamId)}` +
    ` ${C.dim}│${C.reset} ${activeIssue.assignee ?? `${C.dim}unassigned${C.reset}`}`
  ) : null;

  const fieldOptions: OptionItem[] = [
    { value: "status", label: "Status" },
    { value: "type", label: "Type" },
    { value: "sprint", label: "Sprint" },
    { value: "points", label: "Points" },
    { value: "team", label: "Team" },
    { value: "assignee", label: "Assignee" },
  ];

  const renderTable = () => (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => {
        const isActive = rowIndex === selected;
        const isDim = !isActive && rowIndex % 2 === 1;
        const pointer = isActive ? `${C.cyan}▸${C.reset} ` : "  ";
        const line = pointer + row.cells.join(" ");
        return (
          <Text key={row.key} inverse={isActive} dimColor={isDim}>{line}</Text>
        );
      })}
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Text>{`${C.bold}Triage${C.reset} ${C.dim}(${visibleIssues.length} tickets)${C.reset}`}</Text>
      {loading ? (
        <Text>{`${C.dim}Loading tickets...${C.reset}`}</Text>
      ) : error ? (
        <Text>{`${C.red}Error:${C.reset} ${error}`}</Text>
      ) : visibleIssues.length === 0 ? (
        <Text>{`${C.dim}No tickets to triage${C.reset}`}</Text>
      ) : layout.showSidePanel ? (
        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column" marginRight={2}>
            {renderTable()}
          </Box>
          <Box width={SIDE_PANEL_WIDTH} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
            <Text>{`${C.bold}Details${C.reset}`}</Text>
            {detailLines.map((line, idx) => (
              <Text key={idx} wrap="truncate">{line}</Text>
            ))}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {renderTable()}
          {detailBar && (
            <Box marginTop={1}>
              <Text wrap="truncate">{detailBar}</Text>
            </Box>
          )}
        </Box>
      )}

      {mode === "field" && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text>{`${C.bold}Edit Field${C.reset} ${C.dim}(j/k, Enter, Esc)${C.reset}`}</Text>
          {fieldOptions.map((opt, idx) => (
            <Text key={opt.value} inverse={idx === optionIndex}>
              {` ${opt.label} `}
            </Text>
          ))}
        </Box>
      )}

      {mode === "options" && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text>{`${C.bold}Select ${field}${C.reset} ${C.dim}(j/k, Enter, Esc)${C.reset}`}</Text>
          {options.map((opt, idx) => (
            <Text key={`${opt.label}-${idx}`} inverse={idx === optionIndex}>
              {` ${opt.label} `}
            </Text>
          ))}
        </Box>
      )}

      {busy && <Text>{`${C.dim}${busy}${C.reset}`}</Text>}
      {message && <Text>{message}</Text>}
      <Text>{`${C.dim}j/k${C.reset} move ${C.dim}g/G${C.reset} top/end ${C.dim}e/⏎${C.reset} edit ${C.dim}r${C.reset} refresh ${C.dim}q${C.reset} quit`}</Text>
    </Box>
  );
}

export async function runTriageInk(
  creds: Credentials,
  fetchIssues: () => Promise<FetchIssuesResult>,
  myTeamId: string,
  myTeamName: string,
  showAll: boolean
): Promise<void> {
  let resolved = false;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const { waitUntilExit } = renderInteractive(
      <TriageApp
        creds={creds}
        myTeamId={myTeamId}
        myTeamName={myTeamName}
        fetchIssues={fetchIssues}
        showAll={showAll}
        onExit={done}
      />
    );
    void waitUntilExit().then(done);
  });
}
