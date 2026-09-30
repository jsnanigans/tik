import { C, stripAnsi } from "../lib";
import { localConfig } from "../lib/config";
import type { IssueData } from "../lib";
import type { PRData, PRCheckRun, PRReview, PRMergeStatus } from "../github";

const { statuses } = localConfig;

export const StatusCategory = {
  inProgress: { label: "IN PROGRESS", color: C.yellow, statuses: statuses.inProgress },
  review: { label: "REVIEW", color: C.cyan, statuses: statuses.review },
  ready: { label: "READY", color: C.green, statuses: statuses.ready },
  todo: { label: "TO DO", color: C.white, subgroups: statuses.todo },
  done: { label: "DONE", color: C.gray, statuses: statuses.done },
};

export function getStatusColor(status: string): string {
  if (StatusCategory.inProgress.statuses.includes(status)) return C.yellow;
  if (StatusCategory.review.statuses.includes(status)) return C.cyan;
  if (StatusCategory.ready.statuses.includes(status)) return C.green;
  if (StatusCategory.done.statuses.includes(status)) return C.gray;
  return C.white;
}

const projectPalette = [C.brightBlue, C.brightCyan, C.brightMagenta, C.yellow, C.green, C.white];

export function formatProjectKey(key: string): string {
  const project = key.split("-")[0];
  const index = localConfig.syncProjects.indexOf(project);
  const color = index >= 0 ? projectPalette[index % projectPalette.length] : C.white;
  return `${color}${key}${C.reset}`;
}

export function formatPoints(points: number | null): string {
  if (points === null) return `${C.dim}·${C.reset}`;
  return `${C.dim}${points}${C.reset}`;
}

export function formatPriority(priorityId: string): string {
  const icons: Record<string, string> = {
    "1": `${C.brightRed}▲${C.reset}`,
    "2": `${C.yellow}▲${C.reset}`,
    "3": "",
    "4": `${C.dim}▽${C.reset}`,
    "5": `${C.dim}▽${C.reset}`,
  };
  return icons[priorityId] || "";
}

export function formatTypeIcon(issueType: string): string {
  switch (issueType.toLowerCase()) {
    case "bug": return `${C.red}●${C.reset}`;
    case "task": return `${C.blue}■${C.reset}`;
    case "story": return `${C.green}◆${C.reset}`;
    case "spike": return `${C.magenta}◇${C.reset}`;
    case "epic": return `${C.brightMagenta}⚡${C.reset}`;
    case "sub-task": return `${C.cyan}∘${C.reset}`;
    default: return `${C.dim}○${C.reset}`;
  }
}

export function formatPRStatus(pr: PRData | undefined): string {
  if (!pr) return `${C.dim}──${C.reset}`;

  const reviewIcon = pr.reviewDecision === "CHANGES_REQUESTED"
    ? `${C.red}×${C.reset}`
    : pr.reviewDecision === "APPROVED"
      ? `${C.green}✓${C.reset}`
      : pr.reviewDecision === "REVIEW_REQUIRED"
        ? `${C.yellow}…${C.reset}`
        : `${C.dim}·${C.reset}`;

  const checksIcon = pr.checksStatus === "FAILURE"
    ? `${C.red}✗${C.reset}`
    : pr.checksStatus === "SUCCESS"
      ? `${C.green}✓${C.reset}`
      : pr.checksStatus === "PENDING"
        ? `${C.yellow}◌${C.reset}`
        : `${C.dim}·${C.reset}`;

  if (pr.state === "OPEN") return `${reviewIcon} ${checksIcon}`;
  if (pr.state === "MERGED") return `${C.magenta}●${C.reset} ${checksIcon}`;
  if (pr.state === "CLOSED") return `${C.red}○${C.reset} ${checksIcon}`;
  return `${C.dim}○${C.reset} ${checksIcon}`;
}

const keyColors = [
  C.magenta,
  C.cyan,
  C.yellow,
  C.green,
  C.blue,
  C.brightMagenta,
  C.brightCyan,
  C.brightYellow,
  C.brightGreen,
  C.brightBlue,
];

function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash = hash & hash;
  }
  return keyColors[Math.abs(hash) % keyColors.length];
}

export function formatEpicParent(issue: IssueData, maxWidth: number): string {
  const issueProject = issue.key.split("-")[0];

  const showEpic = issue.epicKey && issue.epicKey !== issue.parentKey;
  const showParent = issue.parentKey;

  let epicStr = "";
  let epicColor = "";
  if (showEpic && issue.epicKey) {
    const [epicProj, epicNum] = issue.epicKey.split("-");
    epicStr = issueProject === epicProj ? epicNum : issue.epicKey;
    epicColor = colorForKey(issue.epicKey);
  }

  let parentStr = "";
  let parentColor = "";
  if (showParent && issue.parentKey) {
    const [parentProj, parentNum] = issue.parentKey.split("-");
    parentStr = issueProject === parentProj ? parentNum : issue.parentKey;
    parentColor = colorForKey(issue.parentKey);
  }

  let result = "";
  if (epicStr && parentStr) {
    const combined = `←${epicStr} ↑${parentStr}`;
    if (combined.length <= maxWidth) {
      result = `${C.dim}${epicColor}←${epicStr}${C.reset} ${C.dim}${parentColor}↑${parentStr}${C.reset}`;
    } else {
      result = `${C.dim}${parentColor}↑${parentStr}${C.reset}`;
    }
  } else if (epicStr) {
    result = `${C.dim}${epicColor}←${epicStr}${C.reset}`;
  } else if (parentStr) {
    result = `${C.dim}${parentColor}↑${parentStr}${C.reset}`;
  }

  if (!result) return "";
  return result;
}

// ─── PR Detail Formatting ───────────────────────────────────────────

export function formatCheckRunIcon(run: PRCheckRun): string {
  if (run.status === "COMPLETED") {
    const c = (run.conclusion || "").toUpperCase();
    if (c === "SUCCESS") return `${C.green}✓${C.reset} ${run.name}`;
    if (c === "FAILURE") return `${C.red}✗${C.reset} ${run.name}`;
    if (c === "TIMED_OUT") return `${C.yellow}⚠${C.reset} ${run.name}`;
    if (c === "CANCELLED" || c === "SKIPPED") return `${C.dim}−${C.reset} ${run.name}`;
    return `${C.dim}?${C.reset} ${run.name}`;
  }
  if (run.status === "IN_PROGRESS") return `${C.yellow}◌${C.reset} ${run.name}`;
  // QUEUED
  return `${C.dim}…${C.reset} ${run.name}`;
}

export function formatCheckRunSummary(runs: PRCheckRun[]): string {
  let pass = 0, fail = 0, prog = 0, skip = 0;
  for (const r of runs) {
    if (r.status !== "COMPLETED") { prog++; continue; }
    const c = (r.conclusion || "").toUpperCase();
    if (c === "SUCCESS") pass++;
    else if (c === "FAILURE") fail++;
    else if (c === "SKIPPED" || c === "CANCELLED") skip++;
    else if (c === "TIMED_OUT") fail++;
    else prog++;
  }
  const parts: string[] = [];
  if (pass > 0) parts.push(`${C.green}${pass} ✓${C.reset}`);
  if (fail > 0) parts.push(`${C.red}${fail} ✗${C.reset}`);
  if (prog > 0) parts.push(`${C.yellow}${prog} ◌${C.reset}`);
  if (skip > 0) parts.push(`${C.dim}${skip} −${C.reset}`);
  return parts.join("  ") || `${C.dim}0 checks${C.reset}`;
}

export function formatReviewIcon(review: PRReview): string {
  const state = review.state;
  if (state === "APPROVED") return `${C.green}✓${C.reset} ${review.author}`;
  if (state === "CHANGES_REQUESTED") return `${C.red}✗${C.reset} ${review.author}`;
  if (state === "COMMENTED") return `${C.dim}💬${C.reset} ${review.author}`;
  if (state === "PENDING") return `${C.yellow}…${C.reset} ${review.author}`;
  if (state === "DISMISSED") return `${C.dim}−${C.reset} ${review.author}`;
  return `${C.dim}·${C.reset} ${review.author}`;
}

export function formatReviewSummary(reviews: PRReview[], requests: string[]): string {
  const total = reviews.length + requests.length;
  let approved = 0, changesRequested = 0, pending = 0;
  for (const r of reviews) {
    if (r.state === "APPROVED") approved++;
    else if (r.state === "CHANGES_REQUESTED") changesRequested++;
    else if (r.state === "PENDING") pending++;
  }
  pending += requests.length;

  const parts: string[] = [];
  if (approved > 0) parts.push(`${C.green}${approved} approved${C.reset}`);
  if (changesRequested > 0) parts.push(`${C.red}${changesRequested} changes requested${C.reset}`);
  if (pending > 0) parts.push(`${C.yellow}${pending} pending${C.reset}`);
  return parts.join(", ") || `${C.dim}no reviews${C.reset}`;
}

export function formatMergeStatusLabel(ms: PRMergeStatus): string {
  if (ms.mergeable === "CONFLICTING") return `${C.red}merge conflicts${C.reset}`;
  if (ms.mergeable === "UNKNOWN") return `${C.dim}checking...${C.reset}`;

  switch (ms.mergeStateStatus) {
    case "CLEAN": return `${C.green}ready to merge${C.reset}`;
    case "BEHIND": return `${C.yellow}N commits behind base${C.reset}`;
    case "BLOCKED": return `${C.dim}blocked by requirements${C.reset}`;
    case "DIRTY": return `${C.yellow}merge commit required${C.reset}`;
    case "UNSTABLE": return `${C.yellow}checks failing${C.reset}`;
    case "HAS_HOOKS": return `${C.yellow}pending required checks${C.reset}`;
    default: return `${C.dim}unknown${C.reset}`;
  }
}

export function formatMergeStatusIcon(ms: PRMergeStatus): string {
  if (ms.mergeable === "CONFLICTING") return `${C.red}✗${C.reset}`;
  if (ms.mergeable === "UNKNOWN") return `${C.dim}◌${C.reset}`;
  if (ms.mergeStateStatus === "CLEAN") return `${C.green}✓${C.reset}`;
  if (ms.mergeStateStatus === "BEHIND" || ms.mergeStateStatus === "DIRTY" || ms.mergeStateStatus === "UNSTABLE") return `${C.yellow}⚠${C.reset}`;
  return `${C.dim}○${C.reset}`;
}

export function formatDiffStats(additions: number, deletions: number, changedFiles?: number): string {
  const addStr = `${C.green}+${additions}${C.reset}`;
  const delStr = `${C.red}-${deletions}${C.reset}`;
  const filesStr = changedFiles !== undefined ? ` in ${changedFiles} ${changedFiles === 1 ? "file" : "files"}` : "";
  return `${addStr} / ${delStr}${filesStr}`;
}

export function formatCheckRunDuration(run: PRCheckRun): string {
  if (run.status === "QUEUED") return `${C.dim}queued${C.reset}`;
  if (run.status === "IN_PROGRESS" && run.startedAt) {
    const elapsed = Date.now() - new Date(run.startedAt).getTime();
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    return `${C.yellow}running (${mins}m${secs}s)${C.reset}`;
  }
  if (run.status === "COMPLETED" && run.startedAt && run.completedAt) {
    const dur = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    const mins = Math.floor(dur / 60000);
    const secs = Math.floor((dur % 60000) / 1000);
    return `${C.dim}${mins}m${secs}s${C.reset}`;
  }
  return `${C.dim}—${C.reset}`;
}

export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

export function fitAnsi(str: string, width: number): string {
  if (!str) return " ".repeat(width);
  const visible = stripAnsi(str).length;
  if (visible === width) return str;
  if (visible < width) return str + " ".repeat(width - visible);
  const plain = stripAnsi(str);
  const truncated = plain.slice(0, width - 1) + "…";
  return `${C.dim}${truncated}${C.reset}`;
}
