import React from "react";
import { Box, Text } from "ink";
import { C, abbreviateName, renderMarkdown, jiraWikiToMarkdown } from "../lib";
import type { HistoryData } from "../lib";
import { getStatusColor, formatProjectKey } from "./format";

const TEXT_FIELDS = new Set(["Description", "AC", "TI"]);

function looksLikeWikiMarkup(value: string | null): boolean {
  if (!value) return false;
  if (value.includes("\n") && value.length > 100) return true;
  if (/\{color[^}]*\}/.test(value)) return true;
  if (/^h[1-6]\.\s/m.test(value)) return true;
  if (/\{code[^}]*\}/.test(value)) return true;
  if (/\{noformat\}/.test(value)) return true;
  if (/\{panel[^}]*\}/.test(value)) return true;
  if (/\[([^|\]]+)\|([^|\]]+?)(?:\|[^\]]*?)?\]/.test(value)) return true;
  if (/!([^!\s]+?)(?:\|[^!]*)?!/.test(value)) return true;
  return false;
}

function diffLines(oldText: string | null, newText: string | null): string[] {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");

  // LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
  const result: string[] = [];
  let i = m, j = n;
  const parts: Array<{ type: "keep" | "del" | "add"; line: string }> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      parts.push({ type: "keep", line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      parts.push({ type: "add", line: newLines[j - 1] });
      j--;
    } else {
      parts.push({ type: "del", line: oldLines[i - 1] });
      i--;
    }
  }
  parts.reverse();

  for (const part of parts) {
    if (part.type === "del") {
      result.push(`  ${C.red}- ${part.line}${C.reset}`);
    } else if (part.type === "add") {
      result.push(`  ${C.green}+ ${part.line}${C.reset}`);
    }
  }

  return result;
}

function formatEventDate(date: Date): string {
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getMonth()];
  const day = date.getDate();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  const time = `${hours}:${minutes}${ampm}`;
  const year = date.getFullYear() !== now.getFullYear() ? ` ${date.getFullYear()}` : "";
  return `${month} ${day}${year}  ${time}`;
}

function diffList(from: string | null, to: string | null): { added: string[]; removed: string[] } | null {
  if (!from && !to) return null;
  const fromItems = from ? from.split(", ").map(s => s.trim()).filter(Boolean) : [];
  const toItems = to ? to.split(", ").map(s => s.trim()).filter(Boolean) : [];
  if (fromItems.length <= 1 && toItems.length <= 1) return null;
  const fromSet = new Set(fromItems);
  const toSet = new Set(toItems);
  const added = toItems.filter(i => !fromSet.has(i));
  const removed = fromItems.filter(i => !toSet.has(i));
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

function formatChangeValue(field: string, value: string | null): string {
  if (!value) return `${C.dim}—${C.reset}`;
  if (field === "Status") {
    const color = getStatusColor(value);
    return `${color}${value}${C.reset}`;
  }
  return value;
}

async function renderMdSection(label: string, md: string): Promise<string[]> {
  const rendered = await renderMarkdown(md);
  const lines: string[] = [];
  lines.push(" ");
  lines.push(`  ${C.bold}${label}:${C.reset}`);
  for (const line of rendered.split("\n")) {
    lines.push(`  ${line}`);
  }
  return lines;
}

export async function buildHistoryLines(data: HistoryData): Promise<string[]> {
  const lines: string[] = [];

  // Header
  lines.push(`\n${formatProjectKey(data.issue.key)}  ${C.bold}${data.issue.summary}${C.reset}`);
  lines.push(`${C.dim}${"━".repeat(Math.min(60, (data.issue.key + "  " + data.issue.summary).length))}${C.reset}`);

  // Creation event
  const createdDate = formatEventDate(data.created);
  lines.push(" ");
  lines.push(`${C.bold}${C.cyan}◆ Created  ${createdDate}  ${abbreviateName(data.creator)}${C.reset}`);
  lines.push(" ");

  // Reconstruct original values from changelog
  const originalValues: Record<string, string | null> = {};
  for (const event of data.events) {
    for (const change of event.changes) {
      if (!(change.field in originalValues)) {
        originalValues[change.field] = change.from;
      }
    }
  }

  const origStatus = originalValues["Status"] ?? data.issue.status;
  const origPriority = originalValues["Priority"] ?? data.issue.priority;
  const origAssignee = originalValues["Assignee"] ?? data.issue.assignee;
  const origPoints = originalValues["Points"] ?? (data.issue.storyPoints !== null ? String(data.issue.storyPoints) : null);
  const origSprint = originalValues["Sprint"] ?? null;
  const origType = originalValues["Type"] ?? data.issue.issueType;

  const origStatusColor = getStatusColor(origStatus);
  lines.push(`  ${C.dim}Type:${C.reset} ${origType}    ${C.dim}Priority:${C.reset} ${origPriority}    ${C.dim}Status:${C.reset} ${origStatusColor}${origStatus}${C.reset}`);
  lines.push(`  ${C.dim}Assignee:${C.reset} ${origAssignee || "—"}    ${C.dim}Sprint:${C.reset} ${origSprint || "—"}    ${C.dim}Points:${C.reset} ${origPoints || "—"}`);

  // Initial description, AC, TI — changelog values are wiki markup, issue values are already markdown
  const origDescription = originalValues["Description"] !== undefined
    ? (originalValues["Description"] ? jiraWikiToMarkdown(originalValues["Description"]) : null)
    : data.issue.description;
  const origAC = originalValues["AC"] !== undefined
    ? (originalValues["AC"] ? jiraWikiToMarkdown(originalValues["AC"]) : null)
    : data.issue.acceptanceCriteria;
  const origTI = originalValues["TI"] !== undefined
    ? (originalValues["TI"] ? jiraWikiToMarkdown(originalValues["TI"]) : null)
    : data.issue.testingInstructions;

  if (origDescription) lines.push(...await renderMdSection("Description", origDescription));
  if (origAC) lines.push(...await renderMdSection("Acceptance Criteria", origAC));
  if (origTI) lines.push(...await renderMdSection("Testing Instructions", origTI));

  // Render any other rich text fields found in original values
  const KNOWN_FIELDS = new Set(["Status", "Priority", "Assignee", "Points", "Sprint", "Type", "Description", "AC", "TI"]);
  for (const [field, value] of Object.entries(originalValues)) {
    if (KNOWN_FIELDS.has(field) || !value || !looksLikeWikiMarkup(value)) continue;
    lines.push(...await renderMdSection(field, jiraWikiToMarkdown(value)));
  }

  // Changelog events
  for (const event of data.events) {
    lines.push(" ");
    lines.push(" ");
    const eventDate = formatEventDate(event.date);
    lines.push(`${C.bold}${C.cyan}◆ ${eventDate}  ${abbreviateName(event.author)}${C.reset}`);
    lines.push(" ");

    const maxFieldLen = Math.max(...event.changes.map(c => c.field.length));

    for (const change of event.changes) {
      const padded = change.field.padEnd(maxFieldLen);

      if (change.field === "Comment") {
        const rawBody = change.from || change.to || "";
        const body = jiraWikiToMarkdown(rawBody).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        const maxLen = Math.min(120, (process.stdout.columns || 100) - 10);
        const excerpt = body.length > maxLen ? body.slice(0, maxLen - 1) + "…" : body;
        lines.push(`  ${C.dim}💬  ${C.italic}${excerpt}${C.reset}`);
        continue;
      }

      const isTextField = TEXT_FIELDS.has(change.field)
        || looksLikeWikiMarkup(change.from)
        || looksLikeWikiMarkup(change.to);

      if (isTextField) {
        lines.push(`  ${C.dim}${padded}${C.reset}`);
        const fromMd = change.from ? jiraWikiToMarkdown(change.from) : change.from;
        const toMd = change.to ? jiraWikiToMarkdown(change.to) : change.to;
        lines.push(...diffLines(fromMd, toMd));
      } else {
        const listDiff = diffList(change.from, change.to);
        if (listDiff) {
          lines.push(`  ${C.dim}${padded}${C.reset}`);
          for (const item of listDiff.removed) {
            lines.push(`  ${C.red}- ${item}${C.reset}`);
          }
          for (const item of listDiff.added) {
            lines.push(`  ${C.green}+ ${item}${C.reset}`);
          }
        } else {
          const from = formatChangeValue(change.field, change.from);
          const to = formatChangeValue(change.field, change.to);
          lines.push(`  ${C.dim}${padded}${C.reset}  ${from}  →  ${to}`);
        }
      }
    }
  }

  lines.push(" ");
  return lines;
}

type HistoryViewProps = {
  lines: string[];
};

export function HistoryView({ lines }: HistoryViewProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
    </Box>
  );
}
