#!/usr/bin/env bun
import React from "react";
import { defineCommand, runMain } from "citty";
import packageJson from "./package.json";
import {
  C,
  truncate,
  showLoading,
  clearLoading,
  clearScreen,
  setQuietProgress,
  flushStdout,
  renderMarkdown,
  type Credentials,
  loadCredentials,
  jiraGet,
  jiraPost,
  jiraPut,
  jiraDelete,
  jiraUpload,
  resolveMediaId,
  makeAuthHeader,
  jiraSearch,
  jiraSearchPaginated,
  type IssueData,
  type SprintData,
  type IssueLinkData,
  type AttachmentData,
  parseIssue,
  parseIssues,
  parseSprint,
  parseComments,
  parseIssueLinks,
  getObj,
  getStr,
  markdownToAdf,
  jiraWikiToMarkdown,
  decodeMediaPlaceholder,
  makeMediaPlaceholder,
  readFileArg,
  formatRelativeDate,
  abbreviateName,
  PriorityMap,
  PriorityNames,
  cacheIssues,
  diffAndCacheIssues,
  type SyncChange,
  type FieldChange,
  cacheSingleIssue,
  cacheUserMapping,
  getUserAccountId,
  searchCache,
  getCachedIssuesRaw,
  findIssuesContaining,
  getTimelineDates,
  type CacheSearchOpts,
  resolveKey,
  isValidKey,
  type KeyResolveResult,
  getLocalMineIssues,
  getLocalSprintData,
  getWasMineKeys,
  getBackfillKeys,
  getRecentCachedKeys,
  getLastSyncTime,
  setLastSyncTime,
  getCacheStats,
  getCachedIssue,
  getFlowState,
  getFlowStateForBranch,
  getCachedKeys,
  fetchTimelineDates,
  extractTimelineDates,
  syncTimelineDates,
  expandRelatedTickets,
  buildGraph,
  buildTimeline,
  type TimelineTicket,
  fetchFullChangelog,
  parseHistory,
  DEFAULT_BOT_AUTHORS,
  isBotAuthor,
  demoteHeadings,
  buildTicketMarkdown,
  type UserRecord,
  getAllUsers,
  getUser,
  getMainUser as getMainUserFromDb,
  getUsersByRole,
  upsertUsersFromSync,
  updateUserFields,
  findUserByNameOrId,
  type PRData,
  type PRMap,
  type PRAuthorActivity,
  type PRDetail,
  type PRCheckRun,
  type PRReview,
  type PRMergeStatus,
  runCommand,
  runCommandResult,
  fetchPRsForTickets,
  getPRForTicket,
  getPRForBranch,
  fetchPRDetail,
  fetchPRDetailForBranch,
  ensureInsideGitRepo,
  ticketFromBranch,
  getCurrentBranch,
  gitBranchExists,
  gitRemoteBranchExists,
  listGitWorktrees,
  findWorktreeByName,
  validateReviewGate,
  formatPRReviewLabel,
  formatPRChecksLabel,
  getAllMappedRepos,
  fetchRecentPRAuthorActivity,
  type MyPRSummary,
  fetchMyPRs,
  getRepoForProject,
  createPullRequest,
  openPullRequest,
  getChangelogEntries,
  resetChangelogSynced,
  searchCacheHybrid,
  type HybridSearchOpts,
  isOllamaAvailable,
  isModelAvailable,
  syncEmbeddings,
  getEmbeddingStats,
  invalidateEmbeddingCache,
  upsertFlowState,
  resolveSpaceId,
  resolveSpaceKey,
  getConfluencePage,
  createConfluencePage,
  updateConfluencePage,
  getPagesInSpace,
  searchConfluence,
  cachePages,
  getPageFromCache,
  searchPagesInCache,
  cachePRs,
  getCachedPRs,
} from "./lib";
import { invalidateSearchIndex } from "./lib/search";
import { renderStatic } from "./ui/render";
import { IssueListView, SearchResultsView, SprintGoalsView, SprintView, SprintSummaryView, LinksView, CommentsView, HelpView } from "./ui/views";
import { TimelineView } from "./ui/timeline";
import { HistoryView, buildHistoryLines } from "./ui/history";
import { promptSelect } from "./ui/prompts";
import { StatusCategory, formatProjectKey, formatPriority, formatTypeIcon, getStatusColor, formatCheckRunIcon, formatCheckRunSummary, formatCheckRunDuration, formatReviewIcon, formatReviewSummary, formatMergeStatusIcon, formatMergeStatusLabel, formatDiffStats, formatRelativeTime } from "./ui/format";
import { SyncProgress } from "./ui/sync";
import { runTriageInk, filterIssues } from "./ui/triage";
import { customFields, localConfig, requireCustomField, requireSetting } from "./lib/config";
import * as os from "node:os";
import * as path from "node:path";
import { mkdir } from "node:fs/promises";

const TeamBoardMap: Record<string, number> = localConfig.teamBoardMap;

const Config = {
  jiraBase: localConfig.jiraBase,
  defaultProject: localConfig.defaultProject,
  syncProjects: localConfig.syncProjects,
  confluence: localConfig.confluence,
  get myTeamId() { return requireSetting("myTeamId"); },
  get myBoardId() { return String(requireSetting("myBoardId")); },
  get inProgressTransitionId() { return requireSetting("inProgressTransitionId"); },
  get reviewTransitionId() { return requireSetting("reviewTransitionId"); },
};

const MyTeamName = localConfig.teamName || "my team";
const DoneStatusesJql = localConfig.statuses.done.map((status) => `"${status.replace(/"/g, '\\"')}"`).join(", ");
const TeamNamesHint = Object.keys(localConfig.teamBoardMap).join(", ");

function getPackageVersion(): string {
  return packageJson.version || "unknown";
}

const TeamIdNames: Record<string, string> = localConfig.teamIdNames;

function resolveTeamName(teamId: string | undefined): string | null {
  if (!teamId) return null;
  return TeamIdNames[teamId] ?? "other";
}

/**
 * Convenience keys alongside the raw Jira fields. description/AC/TI are the ADF custom
 * fields pre-converted to markdown so consumers never have to walk the ADF tree.
 */
function buildIssueJsonFields(data: IssueData): Record<string, unknown> {
  return {
    statusCategory: data.statusCategory,
    sprint: data.sprintName,
    storyPoints: data.storyPoints,
    epicKey: data.epicKey,
    epicName: data.epicName,
    teamId: data.teamId,
    team: data.teamName ?? resolveTeamName(data.teamId ?? undefined),
    labels: data.labels,
    parentKey: data.parentKey,
    attachments: data.attachments,
    description: data.description,
    acceptanceCriteria: data.acceptanceCriteria,
    testingInstructions: data.testingInstructions,
    reporter: data.reporter ?? null,
    creator: data.creator ?? null,
    resolution: data.resolution ?? null,
    resolutionDate: data.resolutionDate ?? null,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getQaAccountIds(): Set<string> {
  return new Set(getUsersByRole("QA").map(u => u.accountId));
}

function getMyBoardId(): number {
  const mainUser = getMainUserFromDb();
  return (mainUser?.team && TeamBoardMap[mainUser.team.toUpperCase()]) || Number(Config.myBoardId);
}

type OutputFormat = "table" | "json" | "plain";

let globalFormat: OutputFormat = "table";
let globalShowPR = false;
let globalExpandDone = false;
let subCommandExecuted = false;
let globalGrepFilter: RegExp | null = null;
let globalTypeFilter: string[] | null = null;
/**
 * console.log silently drops everything past the 64KB pipe buffer when the reader is
 * slow (large --json payloads), so all stdout goes through the stream instead.
 */
const out = (...args: unknown[]) => {
  const text = args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ");
  process.stdout.write(`${text}\n`);
};

function emitError(code: string, message: string, extra?: Record<string, unknown>): never {
  if (globalFormat === "json") {
    out(JSON.stringify({ error: code, message, ...extra }, null, 2));
    process.exit(1);
  }
  console.error(`${C.red}✗${C.reset} ${message}`);
  if (Array.isArray(extra?.validTransitions)) {
    console.error(`${C.dim}Available transitions:${C.reset}`);
    for (const t of extra.validTransitions as { id: string; name: string }[]) {
      console.error(`   ${C.dim}[${t.id}]${C.reset}  ${t.name}`);
    }
  }
  process.exit(1);
}

async function printSyncAge(): Promise<void> {
  if (globalFormat !== "table") return;
  const lastSync = await getLastSyncTime();
  if (!lastSync) {
    out(`\n${C.red}⚠ Never synced${C.reset} — run ${C.cyan}tik sync${C.reset}`);
    return;
  }
  const diffMs = Date.now() - new Date(lastSync).getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const age = formatRelativeDate(lastSync);
  if (diffHours > 48) {
    out(`\n${C.red}⚠ Last sync: ${age} ago${C.reset} — run ${C.cyan}tik sync${C.reset} or use ${C.cyan}-F${C.reset}`);
  } else if (diffHours > 14) {
    out(`\n${C.yellow}Last sync: ${age} ago — data may be outdated${C.reset}`);
  } else {
    out(`${C.dim}Synced ${age} ago${C.reset}`);
  }
}

type GitCommitActivity = {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
  repo: string | null;
  url: string | null;
  ticketKeys: string[];
};

type StandupTicketGroup = {
  key: string;
  issue: IssueData | null;
  ticketChanged: boolean;
  ticketUpdatedAt: string | null;
  commits: GitCommitActivity[];
  prs: PRAuthorActivity[];
};

type StandupData = {
  hours: number;
  since: string;
  now: string;
  gitScope: "account" | "local";
  ticketChanges: IssueData[];
  commits: GitCommitActivity[];
  prs: PRAuthorActivity[];
  matchedTickets: StandupTicketGroup[];
  unmatchedCommits: GitCommitActivity[];
  unmatchedPRs: PRAuthorActivity[];
};

function extractTicketKeys(text: string): string[] {
  const matches = text.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/g) || [];
  return [...new Set(matches)];
}

async function fetchRecentTicketChanges(creds: Credentials, hours: number): Promise<IssueData[]> {
  const runQuery = async (jql: string): Promise<IssueData[]> => {
    const issues: unknown[] = [];
    let nextPageToken: string | null = null;
    do {
      const page = await jiraSearchPaginated(creds, jql, 100, nextPageToken);
      issues.push(...page.issues);
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    if (issues.length > 0) await cacheIssues(issues);
    return parseIssues({ issues });
  };

  try {
    const byUpdatedBy = `issue in updatedBy(currentUser(), "-${hours}h") ORDER BY updated DESC`;
    return await runQuery(byUpdatedBy);
  } catch {
    const fallback = `assignee = currentUser() AND updated >= -${hours}h ORDER BY updated DESC`;
    return await runQuery(fallback);
  }
}

type GhCommitSearchItem = {
  sha?: string;
  url?: string;
  repository?: {
    nameWithOwner?: string;
    name?: string;
    owner?: { login?: string };
  };
  commit?: {
    messageHeadline?: string;
    message?: string;
    committedDate?: string;
    authoredDate?: string;
    committer?: { date?: string };
    author?: { date?: string };
  };
};

async function fetchRecentAccountGitCommits(cutoff: Date): Promise<GitCommitActivity[] | null> {
  const sinceDate = cutoff.toISOString().slice(0, 10);
  const output = await runCommand([
    "gh", "search", "commits", "--author=@me", `--committer-date=>=${sinceDate}`,
    "--sort=committer-date", "--order=desc", "--limit=300",
    "--json", "sha,url,repository,commit",
  ]);
  if (!output) return null;

  try {
    const rows = JSON.parse(output) as GhCommitSearchItem[];
    const cutoffMs = cutoff.getTime();
    const dedup = new Map<string, GitCommitActivity>();

    for (const row of rows) {
      const sha = row.sha || "";
      if (!sha) continue;

      const commit = row.commit || {};
      const commitDate = commit.committedDate || commit.committer?.date || commit.authoredDate || commit.author?.date || "";
      if (!commitDate) continue;
      const commitMs = new Date(commitDate).getTime();
      if (!Number.isFinite(commitMs) || commitMs < cutoffMs) continue;

      const subject = commit.messageHeadline || commit.message?.split("\n")[0] || "";
      const repo = row.repository?.nameWithOwner
        || (row.repository?.owner?.login && row.repository?.name
          ? `${row.repository.owner.login}/${row.repository.name}`
          : null);
      const ticketKeys = extractTicketKeys(`${subject}`);
      dedup.set(sha, {
        hash: sha,
        shortHash: sha.slice(0, 8),
        date: commitDate,
        subject,
        repo,
        url: row.url || null,
        ticketKeys,
      });
    }

    return [...dedup.values()].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch {
    return null;
  }
}

async function fetchRecentLocalGitCommits(hours: number, authorEmail: string): Promise<GitCommitActivity[]> {
  if (!(await ensureInsideGitRepo())) return [];

  const output = await runCommand([
    "git", "log", "--all", `--since=${hours} hours ago`, `--author=${authorEmail}`,
    "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s%x09%D",
  ]);
  if (!output) return [];

  try {
    return output
      .split("\n")
      .map((line) => {
        const [hash, date, subject] = line.split("\t");
        const text = `${subject || ""}`;
        const ticketKeys = extractTicketKeys(text);
        return {
          hash: hash || "",
          shortHash: (hash || "").slice(0, 8),
          date: date || "",
          subject: subject || "",
          repo: null,
          url: null,
          ticketKeys,
        };
      })
      .filter(c => !!c.hash);
  } catch {
    return [];
  }
}

async function buildStandupData(creds: Credentials, hours: number): Promise<StandupData> {
  const now = new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const [ticketChanges, accountCommits, prs] = await Promise.all([
    fetchRecentTicketChanges(creds, hours),
    fetchRecentAccountGitCommits(since),
    fetchRecentPRAuthorActivity(getAllMappedRepos(), since),
  ]);
  const commits = accountCommits ?? await fetchRecentLocalGitCommits(hours, creds.email);
  const gitScope: "account" | "local" = accountCommits ? "account" : "local";

  const ticketGroups = new Map<string, StandupTicketGroup>();

  const ensureGroup = (key: string): StandupTicketGroup => {
    let group = ticketGroups.get(key);
    if (group) return group;
    group = {
      key,
      issue: null,
      ticketChanged: false,
      ticketUpdatedAt: null,
      commits: [],
      prs: [],
    };
    ticketGroups.set(key, group);
    return group;
  };

  for (const issue of ticketChanges) {
    const group = ensureGroup(issue.key);
    group.issue = issue;
    group.ticketChanged = true;
    group.ticketUpdatedAt = issue.updated || null;
  }

  for (const commit of commits) {
    for (const key of commit.ticketKeys) {
      ensureGroup(key).commits.push(commit);
    }
  }

  for (const pr of prs) {
    if (pr.ticketKey) {
      ensureGroup(pr.ticketKey).prs.push(pr);
    }
  }

  const keysNeedingIssue = [...ticketGroups.values()].filter(g => !g.issue).map(g => g.key);
  if (keysNeedingIssue.length > 0) {
    const raws = getCachedIssuesRaw(keysNeedingIssue);
    for (const key of keysNeedingIssue) {
      const raw = raws.get(key);
      if (!raw) continue;
      const parsed = parseIssue(raw);
      const group = ticketGroups.get(key);
      if (group) group.issue = parsed;
    }
  }

  const matchedTickets = [...ticketGroups.values()]
    .filter(g => g.ticketChanged || g.commits.length > 0 || g.prs.length > 0)
    .sort((a, b) => {
      const aTime = Math.max(
        a.ticketUpdatedAt ? new Date(a.ticketUpdatedAt).getTime() : 0,
        a.commits[0]?.date ? new Date(a.commits[0].date).getTime() : 0,
        a.prs[0]?.activityAt ? new Date(a.prs[0].activityAt).getTime() : 0,
      );
      const bTime = Math.max(
        b.ticketUpdatedAt ? new Date(b.ticketUpdatedAt).getTime() : 0,
        b.commits[0]?.date ? new Date(b.commits[0].date).getTime() : 0,
        b.prs[0]?.activityAt ? new Date(b.prs[0].activityAt).getTime() : 0,
      );
      return bTime - aTime;
    });

  const unmatchedCommits = commits.filter(c => c.ticketKeys.length === 0);
  const unmatchedPRs = prs.filter(p => !p.ticketKey);

  return {
    hours,
    since: since.toISOString(),
    now: now.toISOString(),
    gitScope,
    ticketChanges,
    commits,
    prs,
    matchedTickets,
    unmatchedCommits,
    unmatchedPRs,
  };
}

async function cmdStandup(creds: Credentials, hours: number): Promise<void> {
  if (globalFormat === "table") showLoading(`Collecting standup activity (last ${hours}h)...`);
  const data = await buildStandupData(creds, hours);
  clearLoading();

  if (globalFormat === "json") {
    out(JSON.stringify(data, null, 2));
    return;
  }

  if (globalFormat === "plain") {
    for (const ticket of data.matchedTickets) {
      const summary = ticket.issue?.summary || "";
      const status = ticket.issue?.status || "";
      out(`${ticket.key}\t${status}\t${summary}\tcommits:${ticket.commits.length}\tprs:${ticket.prs.length}\tticketChanged:${ticket.ticketChanged ? "yes" : "no"}`);
    }
    for (const commit of data.unmatchedCommits) {
      out(`(no-ticket)\tcommit\t${commit.shortHash}\t${commit.subject}`);
    }
    for (const pr of data.unmatchedPRs) {
      out(`(no-ticket)\tpr\t#${pr.number}\t${pr.title}`);
    }
    return;
  }

  out(`\n${C.bold}Standup${C.reset} ${C.dim}(last ${hours}h)${C.reset}`);
  out(`${C.dim}${new Date(data.since).toLocaleString()} → ${new Date(data.now).toLocaleString()}${C.reset}`);
  out(`${C.dim}Git scope: ${data.gitScope === "account" ? "GitHub account-wide" : "local repo fallback"}${C.reset}`);

  if (data.matchedTickets.length === 0) {
    out(`\n${C.dim}No activity found.${C.reset}`);
    return;
  }

  out(`\n${C.bold}Tickets (${data.matchedTickets.length})${C.reset}`);
  for (const t of data.matchedTickets) {
    const status = t.issue ? `${getStatusColor(t.issue.status)}●${C.reset} ${t.issue.status}` : `${C.dim}unknown${C.reset}`;
    const summary = t.issue?.summary || `${C.dim}(not in cache)${C.reset}`;
    out(`\n${formatProjectKey(t.key)}  ${status}  ${summary}`);
    if (t.ticketChanged) out(`  ${C.cyan}jira${C.reset} updated in window`);
    for (const commit of t.commits.slice(0, 5)) {
      const repoLabel = commit.repo ? `${C.dim}${commit.repo}${C.reset} ` : "";
      out(`  ${C.yellow}git${C.reset} ${repoLabel}${C.dim}${commit.shortHash}${C.reset} ${commit.subject}`);
    }
    if (t.commits.length > 5) {
      out(`  ${C.dim}...and ${t.commits.length - 5} more commits${C.reset}`);
    }
    for (const pr of t.prs.slice(0, 5)) {
      out(`  ${C.magenta}pr${C.reset} #${pr.number} ${pr.activityType} ${C.dim}(${pr.state.toLowerCase()})${C.reset} ${pr.title}`);
    }
    if (t.prs.length > 5) {
      out(`  ${C.dim}...and ${t.prs.length - 5} more PRs${C.reset}`);
    }
  }

  if (data.unmatchedCommits.length > 0) {
    out(`\n${C.bold}Git Without Ticket (${data.unmatchedCommits.length})${C.reset}`);
    for (const commit of data.unmatchedCommits.slice(0, 10)) {
      const repoLabel = commit.repo ? `${commit.repo} ` : "";
      out(`  ${repoLabel}${C.dim}${commit.shortHash}${C.reset} ${commit.subject}`);
    }
    if (data.unmatchedCommits.length > 10) {
      out(`  ${C.dim}...and ${data.unmatchedCommits.length - 10} more${C.reset}`);
    }
  }

  if (data.unmatchedPRs.length > 0) {
    out(`\n${C.bold}PRs Without Ticket (${data.unmatchedPRs.length})${C.reset}`);
    for (const pr of data.unmatchedPRs.slice(0, 10)) {
      out(`  #${pr.number} ${pr.title}`);
    }
    if (data.unmatchedPRs.length > 10) {
      out(`  ${C.dim}...and ${data.unmatchedPRs.length - 10} more${C.reset}`);
    }
  }
}

type FormatIssueOpts = {
  showDescription?: boolean;
  showAC?: boolean;
  showTI?: boolean;
  extraJson?: Record<string, unknown>;
};

async function formatIssue(issue: unknown, pr?: PRData, links?: IssueLinkData[], opts: FormatIssueOpts = {}): Promise<void> {
  const data = parseIssue(issue);
  const { showDescription, showAC, showTI } = opts;

  switch (globalFormat) {
    case "json":
      out(JSON.stringify({ ...(issue as Record<string, unknown>), ...buildIssueJsonFields(data), ...opts.extraJson }, null, 2));
      return;
    case "plain":
      out(`${data.key}\t${data.status}\t${data.summary}\t${data.assignee || ""}\t${data.storyPoints ?? ""}`);
      return;
    case "table": {
      const statusColor = getStatusColor(data.status);
      const prioIcon = formatPriority(data.priorityId);
      const typeIcon = formatTypeIcon(data.issueType);

      // Header
      out(`\n${formatProjectKey(data.key)}  ${C.bold}${data.summary}${C.reset}`);
      out(`${statusColor}●${C.reset} ${data.status}  ${typeIcon} ${data.issueType}  ${prioIcon} ${data.priority}  ${C.dim}${data.assignee || "Unassigned"}${C.reset}  ${data.storyPoints !== null ? `${data.storyPoints} pts` : ""}`);

      if (data.sprintName) {
        out(`${C.dim}Sprint:${C.reset} ${data.sprintName}`);
      }
      if (data.epicKey || data.epicName) {
        out(`${C.dim}Epic:${C.reset} ${data.epicName || data.epicKey}`);
      }
      if (data.labels.length > 0) {
        out(`${C.dim}Labels:${C.reset} ${data.labels.join(", ")}`);
      }
      out(`${C.dim}Created:${C.reset} ${formatRelativeDate(data.created)} ago  ${C.dim}Updated:${C.reset} ${formatRelativeDate(data.updated)} ago`);

      if (globalShowPR && pr) {
        const stateColor = pr.state === "OPEN" ? C.green : pr.state === "MERGED" ? C.magenta : C.red;
        const review = formatPRReviewLabel(pr);
        const checks = formatPRChecksLabel(pr);
        const draft = pr.isDraft ? ` ${C.yellow}[draft]${C.reset}` : "";
        out(`${C.dim}PR:${C.reset} ${stateColor}#${pr.number}${C.reset}${draft} ${pr.state.toLowerCase()} ${C.blue}${C.underline}${pr.url}${C.reset}`);
        out(`    ${C.dim}review:${C.reset} ${review}   ${C.dim}ci:${C.reset} ${checks}`);
      } else if (globalShowPR) {
        out(`${C.dim}PR:${C.reset} none found`);
      }

      if (links && links.length > 0) {
        out(`${C.dim}Links:${C.reset}`);
        for (const link of links) {
          const linkedStatusColor = getStatusColor(link.linkedIssue.status);
          out(`  ${C.dim}${link.type}${C.reset} ${formatProjectKey(link.linkedIssue.key)} ${linkedStatusColor}●${C.reset} ${link.linkedIssue.summary}`);
        }
      }

      if (data.attachments.length > 0) {
        out(`${C.dim}Attachments:${C.reset}`);
        for (const att of data.attachments) {
          const mediaLabel = att.mediaId ? `${C.dim}media:${att.mediaId.slice(0, 8)}…${C.reset}` : `${C.dim}(no media id)${C.reset}`;
          out(`  ${C.dim}${att.id}${C.reset}  ${att.filename}  ${C.dim}${formatFileSize(att.size)}${C.reset}  ${mediaLabel}`);
          out(`       ${C.blue}${C.underline}${att.url}${C.reset}`);
          if (!att.mediaId) {
            out(`       ${C.dim}Use${C.reset} ${C.cyan}tik attach embed ${data.key} ${att.id}${C.reset} ${C.dim}to get embed token${C.reset}`);
          }
        }
      }

      out(`${C.dim}${Config.jiraBase}/browse/${data.key}${C.reset}`);

      if (showDescription && data.description) {
        out(`\n${C.bold}## Description${C.reset}\n`);
        out(await renderMarkdown(data.description));
      }
      if (showAC && data.acceptanceCriteria) {
        out(`\n${C.bold}## Acceptance Criteria${C.reset}\n`);
        out(await renderMarkdown(data.acceptanceCriteria));
      }
      if (showTI && data.testingInstructions) {
        out(`\n${C.bold}## Testing Instructions${C.reset}\n`);
        out(await renderMarkdown(data.testingInstructions));
      }
      out("");
      return;
    }
  }
}


async function formatIssues(result: unknown, title?: string, grouped: boolean = true, prMap?: PRMap): Promise<void> {
  let issues = parseIssues(result);
  if (globalGrepFilter) issues = issues.filter(i => globalGrepFilter!.test(i.summary));
  if (globalTypeFilter) issues = issues.filter(i => globalTypeFilter!.includes(i.issueType.toLowerCase()));

  switch (globalFormat) {
    case "json":
      if (globalGrepFilter) {
        out(JSON.stringify({ issues: issues.map(i => ({ key: i.key, summary: i.summary, status: i.status })) }, null, 2));
      } else {
        const rawIssues = ((result as { issues?: unknown[] }).issues || []);
        const byKey = new Map(issues.map(d => [d.key, d]));
        const doneAtByKey = new Map(getTimelineDates(issues.map(d => d.key)).map(d => [d.key, d.doneAt]));
        const augmented = rawIssues.map(raw => {
          const key = (raw as { key?: string }).key;
          const data = key ? byKey.get(key) : undefined;
          return data ? { ...(raw as Record<string, unknown>), ...buildIssueJsonFields(data), doneAt: doneAtByKey.get(data.key) ?? null } : raw;
        });
        out(JSON.stringify({ ...(result as object), issues: augmented }, null, 2));
      }
      return;
    case "plain":
      for (const issue of issues) {
        out(`${issue.key}\t${issue.status}\t${issue.summary}\t${issue.assignee || ""}\t${issue.storyPoints ?? ""}`);
      }
      return;
    case "table":
      await renderStatic(React.createElement(IssueListView, {
        title,
        issues,
        grouped,
        expandDone: globalExpandDone,
        prMap,
        showPR: globalShowPR,
        showStatus: !grouped,
      }));
      return;
  }
}


async function formatSprintView(
  sprint: SprintData,
  issues: IssueData[],
  options: { expandDone?: boolean; mineOnly?: boolean; currentUserId?: string; prMap?: PRMap; wasMineKeys?: Set<string> }
): Promise<void> {
  let filteredIssues = globalGrepFilter ? issues.filter(i => globalGrepFilter!.test(i.summary)) : issues;
  if (globalTypeFilter) filteredIssues = filteredIssues.filter(i => globalTypeFilter!.includes(i.issueType.toLowerCase()));

  if (globalFormat === "table") {
    await renderStatic(React.createElement(SprintView, {
      sprint,
      issues: filteredIssues,
      allIssues: issues,
      expandDone: options.expandDone,
      mineOnly: options.mineOnly,
      currentUserId: options.currentUserId,
      prMap: options.prMap,
      wasMineKeys: options.wasMineKeys,
      qaAccountIds: getQaAccountIds(),
      showPR: globalShowPR,
    }));
    return;
  }

  if (globalFormat === "json") {
    out(JSON.stringify({ sprint, issues: filteredIssues }, null, 2));
    return;
  }

  for (const issue of filteredIssues) {
    out(`${issue.key}\t${issue.status}\t${issue.summary}\t${issue.assignee || ""}\t${issue.storyPoints ?? ""}`);
  }
}

async function formatSprint(sprint: unknown): Promise<void> {
  const s = parseSprint(sprint);
  switch (globalFormat) {
    case "json":
      out(JSON.stringify(sprint, null, 2));
      return;
    case "plain":
      out(s.name);
      return;
    case "table":
      await renderStatic(React.createElement(SprintSummaryView, { sprint: s }));
      return;
  }
}

async function formatSprintGoals(sprint: SprintData): Promise<void> {
  if (globalFormat === "json") {
    out(JSON.stringify({ name: sprint.name, goal: sprint.goal }, null, 2));
    return;
  }

  if (globalFormat === "plain") {
    out(sprint.goal || "No goals set");
    return;
  }

  await renderStatic(React.createElement(SprintGoalsView, { sprint }));
}

async function requireTicket(args: string[]): Promise<string> {
  if (args.length > 0 && args[0] && !args[0].startsWith("-")) {
    return resolveTicketKey(args[0]);
  }

  const ticket = await ticketFromBranch();
  if (ticket) return ticket;

  console.error("Error: No ticket specified and couldn't extract from branch name");
  console.error("Usage: tik <command> <TICKET-KEY>");
  process.exit(1);
}

async function resolveTicketKey(input: string): Promise<string> {
  const result = await resolveKey(input);

  switch (result.type) {
    case "valid":
      return result.key;

    case "resolved":
      out(`${C.dim}Resolved${C.reset} ${result.original} ${C.dim}→${C.reset} ${formatProjectKey(result.key)}`);
      return result.key;

    case "multiple": {
      if (globalFormat === "table") {
        const selected = await promptSelect(
          `${C.yellow}Multiple matches for '${result.original}':${C.reset}`,
          result.matches.map(match => ({
            value: match.key,
            label: formatProjectKey(match.key),
            description: truncate(match.summary, 60),
          }))
        );
        if (selected) return selected;
        console.error(`${C.red}Invalid selection${C.reset}`);
        process.exit(1);
      } else {
        out(`${C.yellow}Multiple matches for '${result.original}':${C.reset}`);
        for (let i = 0; i < result.matches.length; i++) {
          const m = result.matches[i];
          out(`  ${C.dim}[${i + 1}]${C.reset} ${formatProjectKey(m.key)}  ${C.dim}${truncate(m.summary, 50)}${C.reset}`);
        }

        const readline = await import("readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(`${C.dim}Select [1-${result.matches.length}]:${C.reset} `, resolve);
        });
        rl.close();

        const choice = parseInt(answer.trim(), 10);
        if (choice >= 1 && choice <= result.matches.length) {
          return result.matches[choice - 1].key;
        }

        console.error(`${C.red}Invalid selection${C.reset}`);
        process.exit(1);
      }
    }

    case "invalid":
      console.error(`${C.red}Invalid ticket key:${C.reset} ${result.original}`);
      console.error(`${C.dim}Expected format: PROJECT-NUMBER (e.g., PROJ-123)${C.reset}`);
      process.exit(1);
  }
}

async function maybeResolveTicketKey(input: string): Promise<string | null> {
  const result = await resolveKey(input);

  switch (result.type) {
    case "valid":
      return result.key;

    case "resolved":
      out(`${C.dim}Resolved${C.reset} ${result.original} ${C.dim}→${C.reset} ${formatProjectKey(result.key)}`);
      return result.key;

    case "multiple": {
      if (globalFormat === "table") {
        const selected = await promptSelect(
          `${C.yellow}Multiple matches for '${result.original}':${C.reset}`,
          result.matches.map(match => ({
            value: match.key,
            label: formatProjectKey(match.key),
            description: truncate(match.summary, 60),
          }))
        );
        return selected || null;
      }

      out(`${C.yellow}Multiple matches for '${result.original}':${C.reset}`);
      for (let i = 0; i < result.matches.length; i++) {
        const m = result.matches[i];
        out(`  ${C.dim}[${i + 1}]${C.reset} ${formatProjectKey(m.key)}  ${C.dim}${truncate(m.summary, 50)}${C.reset}`);
      }
      return null;
    }

    case "invalid":
      return null;
  }
}

type CreatedTicket = {
  key: string;
  summary: string;
  status: string;
  url: string;
};

async function confirmAction(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(`${prompt} [y/N] `, resolve);
  });
  rl.close();

  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function createTicketRecord(creds: Credentials, options: {
  summary: string;
  project?: string;
  description?: string;
  issueType?: string;
  assignToMe?: boolean;
  inProgress?: boolean;
  team?: boolean;
  sprint?: boolean | string;
  priority?: string;
  points?: string;
  acceptanceCriteria?: string;
  testingInstructions?: string;
}): Promise<CreatedTicket> {
  const summaryText = await readFileArg(options.summary);
  const summary = summaryText.trim().split("\n")[0];
  const project = options.project || Config.defaultProject;
  const issueType = options.issueType || "Task";

  const myself = (await jiraGet(creds, "/rest/api/3/myself")) as { accountId?: string };
  const accountId = myself.accountId || "";

  const fields: Record<string, unknown> = {
    project: { key: project },
    summary,
    issuetype: { name: issueType },
  };

  if (options.description) {
    const description = await readFileArg(options.description);
    fields.description = markdownToAdf(description);
  }

  if (options.assignToMe && accountId) {
    fields.assignee = { accountId };
  }

  if (options.team) {
    fields[requireCustomField("team")] = Config.myTeamId;
  }

  if (typeof options.priority === "string") {
    const priorityId = PriorityMap[options.priority.toLowerCase()];
    if (priorityId) fields.priority = { id: priorityId };
  }

  if (typeof options.points === "string") {
    const pts = parseFloat(options.points);
    if (!isNaN(pts)) fields[requireCustomField("storyPoints")] = pts;
  }

  if (typeof options.acceptanceCriteria === "string") {
    const ac = await readFileArg(options.acceptanceCriteria);
    fields[requireCustomField("acceptanceCriteria")] = markdownToAdf(ac);
  }

  if (typeof options.testingInstructions === "string") {
    const ti = await readFileArg(options.testingInstructions);
    fields[requireCustomField("testingInstructions")] = markdownToAdf(ti);
  }

  if (typeof options.sprint === "string") {
    const sprintId = parseInt(options.sprint, 10);
    if (!isNaN(sprintId)) fields[requireCustomField("sprint")] = sprintId;
  } else if (options.sprint) {
    const sprintResp = (await jiraGet(
      creds,
      `/rest/agile/1.0/board/${Config.myBoardId}/sprint?state=active`
    )) as { values?: { id: number }[] };
    const activeSprint = sprintResp.values?.[0];
    if (activeSprint) fields[requireCustomField("sprint")] = activeSprint.id;
  }

  const result = (await jiraPost(creds, "/rest/api/3/issue", { fields })) as {
    key?: string;
    errors?: unknown;
  };

  const newKey = result.key;
  if (!newKey) {
    throw new Error(`Error creating issue: ${JSON.stringify(result.errors || result)}`);
  }

  if (options.inProgress) {
    await jiraPost(creds, `/rest/api/3/issue/${newKey}/transitions`, {
      transition: { id: Config.inProgressTransitionId },
    });
  }

  const createdIssue = await jiraGet(creds, `/rest/api/3/issue/${newKey}`);
  await cacheSingleIssue(createdIssue);

  return {
    key: newKey,
    summary,
    status: parseIssue(createdIssue).status,
    url: `${Config.jiraBase}/browse/${newKey}`,
  };
}

async function runCheckedCommand(cmd: string[], cwd?: string, failureContext?: string): Promise<string> {
  const result = await runCommandResult(cmd, cwd);
  if (!result.ok) {
    const context = failureContext ? `${failureContext}: ` : "";
    console.error(`${C.red}✗${C.reset} ${context}${result.stderr || result.stdout || cmd.join(" ")}`);
    process.exit(1);
  }
  return result.stdout;
}

async function getRepoRoot(): Promise<string> {
  const root = await runCommand(["git", "rev-parse", "--show-toplevel"]);
  if (!root) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }
  return root;
}

function branchNameForTicket(key: string, prefix = "feature"): string {
  return `${prefix}/${key}`;
}

function ticketKeyFromBranchName(branchName: string): string | null {
  const match = branchName.match(/[A-Za-z][A-Za-z0-9]+-\d+/);
  return match ? match[0].toUpperCase() : null;
}

function prTitleForTicket(key: string, summary: string): string {
  return `[${key}] ${summary}`;
}

function prBodyForTicket(key: string): string {
  return `${Config.jiraBase}/browse/${key}`;
}

function flowStateToPR(state: Awaited<ReturnType<typeof getFlowState>>): PRData | undefined {
  if (!state || !state.prNumber || !state.prTitle || !state.prUrl || !state.prState) return undefined;
  return {
    number: state.prNumber,
    title: state.prTitle,
    url: state.prUrl,
    headRefName: state.branchName || "",
    state: state.prState as PRData["state"],
    isDraft: state.prIsDraft,
    updatedAt: state.updatedAt,
    reviewDecision: (state.prReviewDecision || null) as PRData["reviewDecision"],
    checksStatus: (state.prChecksStatus || null) as PRData["checksStatus"],
  };
}

function defaultBaseBranchForProject(project: string): string {
  return localConfig.prBaseBranches?.[project.toUpperCase()] || "release";
}

function isOpenPRForBranch(pr: PRData | undefined, branchName: string): pr is PRData {
  return !!pr && pr.headRefName === branchName && pr.state === "OPEN";
}

async function syncBaseBranch(repoRoot: string, baseBranch: string): Promise<void> {
  await runCheckedCommand(["git", "fetch", "origin", baseBranch], repoRoot, `Failed to fetch ${baseBranch}`);
  await runCheckedCommand(["git", "switch", baseBranch], repoRoot, `Failed to switch to ${baseBranch}`);
  await runCheckedCommand(["git", "pull", "--ff-only", "origin", baseBranch], repoRoot, `Failed to pull ${baseBranch}`);
}

async function prepareFeatureBranch(repoRoot: string, ticketKey: string, baseBranch: string, branchPrefix: string): Promise<string> {
  const branchName = branchNameForTicket(ticketKey, branchPrefix);
  const exists = await gitBranchExists(branchName, repoRoot);
  if (!exists) {
    await runCheckedCommand(["git", "branch", branchName, baseBranch], repoRoot, `Failed to create ${branchName}`);
  }
  await runCheckedCommand(["git", "switch", baseBranch], repoRoot, `Failed to return to ${baseBranch}`);
  return branchName;
}

async function switchWorktreeToBranch(repoRoot: string, worktreeName: string, branchName: string): Promise<string> {
  const worktree = await findWorktreeByName(worktreeName, repoRoot);
  if (!worktree) {
    console.error(`${C.red}✗${C.reset} Could not find worktree '${worktreeName}'`);
    process.exit(1);
  }

  if (worktree.branch === branchName) {
    return worktree.path;
  }

  const holder = (await listGitWorktrees(repoRoot)).find(wt => wt.branch === branchName);
  if (holder && holder.path !== worktree.path) {
    console.error(`${C.red}✗${C.reset} ${branchName} is already checked out in ${holder.path}`);
    process.exit(1);
  }

  await runCheckedCommand(["git", "switch", branchName], worktree.path, `Failed to switch worktree ${worktreeName} to ${branchName}`);
  return worktree.path;
}

async function cmdFlowStart(creds: Credentials, args: {
  target?: string;
  worktree?: string;
  yes?: boolean;
  base?: string;
  force?: boolean;
  project?: string;
  "branch-prefix"?: string;
}): Promise<void> {
  if (!(await ensureInsideGitRepo())) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }

  const target = args.target?.trim();
  if (!target) {
    console.error("Error: Provide a ticket key or a title");
    process.exit(1);
  }

  const repoRoot = await getRepoRoot();
  const worktreeName = typeof args.worktree === "string" ? args.worktree : "quick";
  const project = typeof args.project === "string" ? args.project.toUpperCase() : Config.defaultProject;
  const branchPrefix = typeof args["branch-prefix"] === "string" ? args["branch-prefix"] : "feature";
  const force = !!args.force;

  let ticketKey: string;
  let summary: string;
  let ticketStatus: string | null = null;

  const resolvedTicket = await maybeResolveTicketKey(target);
  if (resolvedTicket) {
    ticketKey = resolvedTicket;
    const cached = !force ? await getCachedIssue(ticketKey) : null;
    if (cached) {
      const parsed = parseIssue(cached.raw);
      summary = parsed.summary;
      ticketStatus = parsed.status;
    } else {
      const issue = await jiraGet(creds, `/rest/api/3/issue/${ticketKey}`);
      await cacheSingleIssue(issue);
      const parsed = parseIssue(issue);
      summary = parsed.summary;
      ticketStatus = parsed.status;
    }
  } else {
    if (!args.yes) {
      const confirmed = await confirmAction(`Create ticket "${target}"?`);
      if (!confirmed) {
        out(`${C.dim}Cancelled${C.reset}`);
        return;
      }
    }

    showLoading("Creating ticket...");
    try {
      const created = await createTicketRecord(creds, {
        summary: target,
        project,
        assignToMe: true,
      });
      ticketKey = created.key;
      summary = created.summary;
      ticketStatus = created.status;
    } finally {
      clearLoading();
    }
  }

  const ticketProject = ticketKey.split("-")[0] || project;
  const baseBranch = typeof args.base === "string" ? args.base : defaultBaseBranchForProject(ticketProject);

  showLoading(`Preparing ${ticketKey}...`);
  let branchName = "";
  let worktreePath = "";
  try {
    await syncBaseBranch(repoRoot, baseBranch);
    branchName = await prepareFeatureBranch(repoRoot, ticketKey, baseBranch, branchPrefix);
    worktreePath = await switchWorktreeToBranch(repoRoot, worktreeName, branchName);
    await upsertFlowState({
      ticketKey,
      branchName,
      worktreeName,
      worktreePath,
      jiraSummary: summary,
      jiraStatus: ticketStatus,
    });
  } finally {
    clearLoading();
  }

  if (globalFormat === "json") {
    out(JSON.stringify({
      key: ticketKey,
      summary,
      branch: branchName,
      base: baseBranch,
      worktree: worktreeName,
      worktreePath,
      jiraUrl: `${Config.jiraBase}/browse/${ticketKey}`,
    }, null, 2));
    return;
  }

  if (globalFormat === "plain") {
    out(`${ticketKey}\t${branchName}\t${worktreePath}`);
    return;
  }

  out();
  out(`${C.green}✓${C.reset} Ready ${formatProjectKey(ticketKey)}  ${C.dim}${truncate(summary, 60)}${C.reset}`);
  out(`  ${C.dim}Branch:${C.reset} ${branchName}`);
  out(`  ${C.dim}Base:${C.reset} ${baseBranch}`);
  out(`  ${C.dim}Worktree:${C.reset} ${worktreeName}  ${C.dim}${worktreePath}${C.reset}`);
  out(`  ${C.dim}Jira:${C.reset} ${Config.jiraBase}/browse/${ticketKey}`);
}

async function cmdFlowPR(creds: Credentials, args: {
  key?: string;
  open?: boolean;
  draft?: boolean;
  base?: string;
  force?: boolean;
}): Promise<void> {
  if (!(await ensureInsideGitRepo())) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }

  const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);
  const branchName = await getCurrentBranch();
  if (!branchName) {
    console.error("Error: Could not determine current branch");
    process.exit(1);
  }

  const project = key.split("-")[0];
  const repo = getRepoForProject(project);
  if (!repo) {
    console.error(`${C.red}✗${C.reset} No GitHub repo mapping for project ${project}`);
    process.exit(1);
  }

  const force = !!args.force;
  const cachedIssue = !force ? await getCachedIssue(key) : null;
  const flowState = !force ? await getFlowStateForBranch(key, branchName) : null;
  let parsed: IssueData;
  if (cachedIssue) {
    parsed = parseIssue(cachedIssue.raw);
  } else if (flowState?.jiraSummary) {
    parsed = {
      key,
      summary: flowState.jiraSummary,
      status: flowState.jiraStatus || "",
    } as IssueData;
  } else {
    const issue = await jiraGet(creds, `/rest/api/3/issue/${key}`);
    await cacheSingleIssue(issue);
    parsed = parseIssue(issue);
  }
  const title = prTitleForTicket(key, parsed.summary);
  const body = prBodyForTicket(key);
  const baseBranch = typeof args.base === "string" ? args.base : defaultBaseBranchForProject(project);

  showLoading(`Preparing PR for ${key}...`);
  try {
    let existing: PRData | undefined;
    const branchPR = await getPRForBranch(repo, branchName);
    if (branchPR) {
      await upsertFlowState({
        ticketKey: key,
        branchName,
        repo,
        jiraSummary: parsed.summary,
        jiraStatus: parsed.status || null,
        prNumber: branchPR.number,
        prTitle: branchPR.title,
        prUrl: branchPR.url,
        prState: branchPR.state,
        prIsDraft: branchPR.isDraft,
        prReviewDecision: branchPR.reviewDecision,
        prChecksStatus: branchPR.checksStatus,
      });
      existing = isOpenPRForBranch(branchPR, branchName) ? branchPR : undefined;
    }

    if (existing) {
      await upsertFlowState({
        ticketKey: key,
        branchName,
        repo,
        jiraSummary: parsed.summary,
        jiraStatus: parsed.status || null,
        prNumber: existing.number,
        prTitle: existing.title,
        prUrl: existing.url,
        prState: existing.state,
        prIsDraft: existing.isDraft,
        prReviewDecision: existing.reviewDecision,
        prChecksStatus: existing.checksStatus,
      });
      clearLoading();
      if (globalFormat === "json") {
        out(JSON.stringify({ key, pr: existing }, null, 2));
      } else if (globalFormat === "plain") {
        out(`${key}\t${existing.number}\t${existing.url}`);
      } else {
        out(`${C.yellow}PR already exists${C.reset} ${C.blue}${C.underline}${existing.url}${C.reset}`);
      }
      if (args.open) {
        if (existing.url) Bun.spawn(["open", existing.url]);
        else await openPullRequest(repo, branchName);
      }
      return;
    }

    const hasUpstream = (await runCommand(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) !== null;
    if (hasUpstream) {
      await runCheckedCommand(["git", "push"], undefined, "Failed to push branch");
    } else {
      await runCheckedCommand(["git", "push", "-u", "origin", branchName], undefined, "Failed to push branch");
    }

    const created = await createPullRequest({
      repo,
      base: baseBranch,
      head: branchName,
      title,
      body,
      assignee: "@me",
      draft: !!args.draft,
    });

    clearLoading();
    if (!created.ok) {
      console.error(`${C.red}✗${C.reset} ${created.error}`);
      process.exit(1);
    }

    const createdNumberMatch = created.url?.match(/\/pull\/(\d+)(?:\/|$)/);
    await upsertFlowState({
      ticketKey: key,
      branchName,
      repo,
      jiraSummary: parsed.summary,
      jiraStatus: parsed.status || null,
      prNumber: createdNumberMatch ? parseInt(createdNumberMatch[1], 10) : null,
      prTitle: title,
      prUrl: created.url || null,
      prState: "OPEN",
      prIsDraft: !!args.draft,
      prReviewDecision: null,
      prChecksStatus: null,
    });

    if (globalFormat === "json") {
      out(JSON.stringify({ key, title, url: created.url || null }, null, 2));
    } else if (globalFormat === "plain") {
      out(`${key}\t${created.url || ""}`);
    } else {
      out(`${C.green}✓${C.reset} Created PR for ${formatProjectKey(key)}`);
      if (created.url) out(`  ${C.dim}${created.url}${C.reset}`);
    }

    if (args.open) {
      if (created.url) Bun.spawn(["open", created.url]);
      else await openPullRequest(repo, branchName);
    }
  } finally {
    clearLoading();
  }
}

async function cmdFlowStatus(creds: Credentials, args: { key?: string; force?: boolean }): Promise<void> {
  if (!(await ensureInsideGitRepo())) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }

  const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);
  const repoRoot = await getRepoRoot();
  const currentBranch = await getCurrentBranch();
  const branchName = currentBranch && ticketKeyFromBranchName(currentBranch) === key ? currentBranch : branchNameForTicket(key);
  const localBranch = await gitBranchExists(branchName, repoRoot);
  const remoteBranch = await gitRemoteBranchExists(branchName, "origin", repoRoot);
  const worktrees = await listGitWorktrees(repoRoot);
  const attachedWorktree = worktrees.find(wt => wt.branch === branchName) || null;
  const project = key.split("-")[0];
  const repo = getRepoForProject(project);
  const force = !!args.force;
  const flowState = !force ? await getFlowStateForBranch(key, branchName) : null;
  const cachedIssue = !force ? await getCachedIssue(key) : null;
  const cachedPR = flowStateToPR(flowState);
  const pr = repo
    ? (isOpenPRForBranch(cachedPR, branchName) ? cachedPR : await getPRForBranch(repo, branchName))
    : undefined;
  let parsed: IssueData;
  if (cachedIssue) {
    parsed = parseIssue(cachedIssue.raw);
  } else if (flowState?.jiraSummary) {
    parsed = {
      key,
      summary: flowState.jiraSummary,
      status: flowState.jiraStatus || "",
    } as IssueData;
  } else {
    const issue = await jiraGet(creds, `/rest/api/3/issue/${key}`);
    await cacheSingleIssue(issue);
    parsed = parseIssue(issue);
  }

  await upsertFlowState({
    ticketKey: key,
    branchName,
    repo: repo || null,
    worktreeName: attachedWorktree?.path.split("/").filter(Boolean).pop() || null,
    worktreePath: attachedWorktree?.path || null,
    jiraSummary: parsed.summary,
    jiraStatus: parsed.status || null,
    prNumber: pr?.number ?? null,
    prTitle: pr?.title ?? null,
    prUrl: pr?.url ?? null,
    prState: pr?.state ?? null,
    prIsDraft: pr?.isDraft ?? false,
    prReviewDecision: pr?.reviewDecision ?? null,
    prChecksStatus: pr?.checksStatus ?? null,
  });

  if (globalFormat === "json") {
    out(JSON.stringify({
      key,
      summary: parsed.summary,
      ticketStatus: parsed.status,
      currentBranch,
      branch: branchName,
      localBranch,
      remoteBranch,
      worktree: attachedWorktree?.path || null,
      pr: pr || null,
    }, null, 2));
    return;
  }

  if (globalFormat === "plain") {
    out([
      key,
      parsed.status,
      branchName,
      localBranch ? "local" : "",
      remoteBranch ? "remote" : "",
      attachedWorktree?.path || "",
      pr?.state || "",
      pr?.reviewDecision || "",
      pr?.checksStatus || "",
    ].join("\t"));
    return;
  }

  out();
  out(`${formatProjectKey(key)}  ${C.bold}${parsed.summary}${C.reset}`);
  out(`${C.dim}Ticket:${C.reset} ${getStatusColor(parsed.status)}${parsed.status}${C.reset}`);
  out(`${C.dim}Current branch:${C.reset} ${currentBranch || "unknown"}`);
  out(`${C.dim}Feature branch:${C.reset} ${branchName}`);
  out(`${C.dim}Local branch:${C.reset} ${localBranch ? `${C.green}yes${C.reset}` : `${C.red}no${C.reset}`}`);
  out(`${C.dim}Remote branch:${C.reset} ${remoteBranch ? `${C.green}yes${C.reset}` : `${C.red}no${C.reset}`}`);
  out(`${C.dim}Worktree:${C.reset} ${attachedWorktree ? attachedWorktree.path : `${C.dim}not checked out${C.reset}`}`);
  if (!repo) {
    out(`${C.dim}PR:${C.reset} ${C.dim}no repo mapping${C.reset}`);
    return;
  }
  if (!pr) {
    out(`${C.dim}PR:${C.reset} ${C.dim}none${C.reset}`);
    return;
  }
  out(`${C.dim}PR:${C.reset} ${pr.state} ${C.blue}${C.underline}${pr.url}${C.reset}`);
  out(`${C.dim}Review:${C.reset} ${formatPRReviewLabel(pr)}`);
  out(`${C.dim}CI:${C.reset} ${formatPRChecksLabel(pr)}`);
}

async function buildSearchOpts(args: Record<string, unknown>, creds: Credentials, defaultLimit = 50): Promise<CacheSearchOpts> {
  const opts: CacheSearchOpts = {
    currentUserEmail: creds.email,
  };

  // Text search - positional query and --summary both use FTS in local mode
  if (typeof args.q === "string") {
    opts.text = args.q;
  }
  if (typeof args.summary === "string") {
    opts.text = args.summary;
  }

  if (typeof args.contains === "string") {
    opts.contains = args.contains;
  }

  // Fuzzy search mode (enabled by default, can be disabled with --no-fuzzy)
  opts.fuzzy = args["no-fuzzy"] ? false : true;
  opts.minScore = typeof args["min-score"] === "string" ? parseInt(args["min-score"], 10) : 30;

  // Project filter
  if (typeof args.p === "string") {
    opts.project = args.p.split(",").map(p => p.trim().toUpperCase());
  }

  // Status filter
  if (typeof args.s === "string") {
    opts.status = args.s.split(",").map(s => s.trim());
  }

  // Assignee filter - for "me", we need to resolve the account ID
  if (typeof args.a === "string") {
    if (args.a === "me") {
      let accountId = await getUserAccountId(creds.email);
      if (!accountId) {
        const me = await jiraGet(creds, "/rest/api/3/myself") as { accountId?: string };
        if (me.accountId) {
          accountId = me.accountId;
          await cacheUserMapping(creds.email, accountId);
        }
      }
      opts.assignee = accountId ? accountId : "me";
    } else {
      opts.assignee = args.a;
    }
  }

  // Issue type filter (from -t or --type) - title-case for DB match
  const typeArg = typeof args.t === "string" ? args.t : typeof args.type === "string" ? args.type : null;
  if (typeArg) {
    opts.issueType = typeArg.split(",").map(t => {
      const s = t.trim();
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    });
  }

  // Priority filter
  if (typeof args.priority === "string") {
    const prioMap: Record<string, string> = {
      "1": "Highest", "2": "High", "3": "Medium", "4": "Low", "5": "Lowest",
      highest: "Highest", high: "High", medium: "Medium", low: "Low", lowest: "Lowest",
    };
    const prio = prioMap[args.priority.toLowerCase()] || args.priority;
    opts.priority = [prio];
  }

  // Story points filter
  if (typeof args.points === "string") {
    const pts = args.points.toLowerCase();
    if (pts === "none") {
      opts.storyPoints = "none";
    } else if (pts === "any") {
      opts.storyPoints = "any";
    } else if (pts.startsWith(">=")) {
      opts.storyPoints = { op: ">=", value: parseFloat(pts.slice(2)) };
    } else if (pts.startsWith("<=")) {
      opts.storyPoints = { op: "<=", value: parseFloat(pts.slice(2)) };
    } else if (pts.startsWith(">")) {
      opts.storyPoints = { op: ">", value: parseFloat(pts.slice(1)) };
    } else if (pts.startsWith("<")) {
      opts.storyPoints = { op: "<", value: parseFloat(pts.slice(1)) };
    } else {
      opts.storyPoints = { op: "=", value: parseFloat(pts) };
    }
  }

  // Epic filter
  if (typeof args.epic === "string") {
    opts.epicKey = args.epic;
  }

  // Labels filter
  if (typeof args.l === "string") {
    opts.labels = args.l.split(",").map(l => l.trim());
  }

  // Updated date filter (convert relative dates to ISO)
  if (typeof args.updated === "string") {
    const val = args.updated;
    if (val.startsWith("-")) {
      const match = val.match(/^-(\d+)([dhwm])$/);
      if (match) {
        const num = parseInt(match[1], 10);
        const unit = match[2];
        const now = new Date();
        switch (unit) {
          case "d": now.setDate(now.getDate() - num); break;
          case "h": now.setHours(now.getHours() - num); break;
          case "w": now.setDate(now.getDate() - num * 7); break;
          case "m": now.setMonth(now.getMonth() - num); break;
        }
        opts.updatedAfter = now.toISOString().slice(0, 10);
      }
    } else if (val.includes("..")) {
      const [start, end] = val.split("..");
      opts.updatedAfter = start;
      opts.updatedBefore = end;
    } else {
      opts.updatedAfter = val;
    }
  }

  // Sorting
  if (typeof args.sort === "string") {
    const sortMap: Record<string, "updated" | "created" | "key" | "priority"> = {
      updated: "updated",
      created: "created",
      key: "key",
      priority: "priority",
    };
    opts.orderBy = sortMap[args.sort.toLowerCase()] || "updated";
  }
  opts.orderDir = args.asc ? "asc" : "desc";

  // Limit
  const fallbackLimit = opts.contains ? Number.MAX_SAFE_INTEGER : defaultLimit;
  opts.limit = typeof args.m === "string" ? parseInt(args.m, 10) || fallbackLimit : fallbackLimit;

  return opts;
}

async function runContainsAny(source: string): Promise<void> {
  const input = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  const tokens = [...new Set(input.split("\n").map(line => line.trim()).filter(Boolean))];
  out(JSON.stringify(Object.fromEntries(findIssuesContaining(tokens)), null, 2));
}

async function runLocalSearch(args: Record<string, unknown>, creds: Credentials, localOnly = true): Promise<void> {
  const opts = await buildSearchOpts(args, creds);

  const noSemantic = !!args["no-semantic"];
  const hybridOpts: HybridSearchOpts = { ...opts, noSemantic };

  const loadingMsg = localOnly ? "Searching local cache..." : "Ranking results...";
  const showSpinner = globalFormat === "table" && !args.keys && !args.count;
  if (showSpinner) showLoading(loadingMsg);
  let cachedIssues = opts.text && !noSemantic
    ? await searchCacheHybrid(hybridOpts)
    : await searchCache(opts);
  if (globalGrepFilter) cachedIssues = cachedIssues.filter(c => globalGrepFilter!.test(c.summary));
  if (showSpinner) clearLoading();

  // Output: keys only
  if (args.keys) {
    for (const issue of cachedIssues) {
      out(issue.key);
    }
    return;
  }

  // Output: count only
  if (args.count) {
    out(cachedIssues.length);
    return;
  }

  // Build result in same format as jiraSearch for formatIssues
  const result = { issues: cachedIssues.map(c => c.raw) };

  const title = localOnly ? "Local Search Results" : "Search Results";

  // Detailed view for text searches (unless --compact or non-table format)
  if (opts.text && globalFormat === "table" && !args.compact) {
    const issues = parseIssues(result);
    let currentUserId: string | undefined;
    const accountId = await getUserAccountId(creds.email);
    if (accountId) currentUserId = accountId;

    await renderStatic(React.createElement(SearchResultsView, {
      issues,
      query: opts.text,
      expandDone: globalExpandDone,
      currentUserId,
      showPR: globalShowPR,
    }));
    await printSyncAge();
    return;
  }

  await formatIssues(result, title, false);
  await printSyncAge();
}

function compactTextDiff(oldText?: string, newText?: string, maxWidth?: number): string {
  if (!oldText && newText) return `${C.green}(added)${C.reset}`;
  if (oldText && !newText) return `${C.red}(removed)${C.reset}`;
  if (!oldText || !newText) return "";
  const oldMd = jiraWikiToMarkdown(oldText);
  const newMd = jiraWikiToMarkdown(newText);
  const oldLines = oldMd.split("\n").map(l => l.trim()).filter(Boolean);
  const newLines = newMd.split("\n").map(l => l.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter(l => !oldSet.has(l));
  const removed = oldLines.filter(l => !newSet.has(l));
  if (added.length === 0 && removed.length === 0) return `${C.dim}(reformatted)${C.reset}`;
  const halfWidth = maxWidth ? Math.floor((maxWidth - 5) / 2) : 60;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`${C.green}+ ${truncate(added[0], halfWidth)}${C.reset}`);
  if (removed.length > 0) parts.push(`${C.red}- ${truncate(removed[0], halfWidth)}${C.reset}`);
  return parts.join(" / ");
}

function formatFieldChange(fc: FieldChange, availWidth: number): string {
  if (fc.field === "comment") {
    const body = jiraWikiToMarkdown(fc.newValue || "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    const maxLen = Math.max(20, availWidth - 10);
    const excerpt = body.length > maxLen ? body.slice(0, maxLen - 1) + "…" : body;
    return `      ${C.dim}💬  ${C.italic}${excerpt}${C.reset}`;
  }
  const label = fc.field.padEnd(12);
  if (fc.isText) {
    const diff = compactTextDiff(fc.oldValue, fc.newValue, Math.max(20, availWidth - 20));
    return `      ${C.dim}${label}${C.reset}${diff}`;
  }
  let oldVal = fc.oldValue || "none";
  let newVal = fc.newValue || "none";
  if (fc.field === "labels") {
    try { oldVal = JSON.parse(fc.oldValue || "[]").join(", ") || "none"; } catch {}
    try { newVal = JSON.parse(fc.newValue || "[]").join(", ") || "none"; } catch {}
  }
  if (fc.field === "status") {
    return `      ${C.dim}${label}${C.reset}${getStatusColor(oldVal)}${oldVal}${C.reset} → ${getStatusColor(newVal)}${newVal}${C.reset}`;
  }
  return `      ${C.dim}${label}${C.reset}${C.dim}${oldVal}${C.reset} → ${newVal}`;
}

const TeamPalette = [C.yellow, C.cyan, C.brightBlue, C.magenta];

function getTeamLabel(teamId: string | undefined): { text: string; color: string } {
  const name = resolveTeamName(teamId);
  if (!name) return { text: "none", color: C.red };
  const index = Object.values(TeamIdNames).indexOf(name);
  return { text: name, color: index >= 0 ? TeamPalette[index % TeamPalette.length] : C.dim };
}

function formatChangeSummary(changes: SyncChange[], maxItems: number = 150): string {
  const newChanges = changes.filter(c => c.changeType === "new");
  const changed = changes.filter(c => c.changeType === "changed");
  const lines: string[] = [];
  const termWidth = process.stdout.columns || 100;

  // Split changed into: status-only, assignee-only, multi-field
  const statusOnly: SyncChange[] = [];
  const assigneeOnly: SyncChange[] = [];
  const modified: SyncChange[] = [];
  for (const c of changed) {
    if (c.fields.length === 1 && c.fields[0].field === "status") statusOnly.push(c);
    else if (c.fields.length === 1 && c.fields[0].field === "assignee") assigneeOnly.push(c);
    else modified.push(c);
  }

  const namePad = 16;
  const formatLine = (c: SyncChange, detail: string) => {
    const icon = formatTypeIcon(c.issueType);
    const colorKey = formatProjectKey(c.key);
    const abbrev = abbreviateName(c.assignee ?? null);
    const { text: teamText, color: teamColor } = getTeamLabel(c.teamId);
    let assigneePart: string;
    if (abbrev) {
      const visibleLen = 1 + abbrev.length + 1 + teamText.length;
      const pad = " ".repeat(Math.max(1, namePad - visibleLen));
      assigneePart = `${C.dim}@${abbrev}${C.reset} ${teamColor}${teamText}${C.reset}${pad}`;
    } else {
      const pad = " ".repeat(Math.max(1, namePad - teamText.length));
      assigneePart = `${teamColor}${teamText}${C.reset}${pad}`;
    }
    const prefix = `  ${icon} ${colorKey}  ${assigneePart}${detail}`;
    const prefixLen = c.key.length + namePad + detail.length + 6;
    const availWidth = termWidth - prefixLen - 4;
    const truncSummary = availWidth > 10 ? truncate(c.summary, availWidth) : "";
    return truncSummary
      ? `${prefix}  ${C.dim}${truncSummary}${C.reset}`
      : prefix;
  };

  let shown = 0;

  const showSection = (items: SyncChange[], label: string, icon: string, formatDetail: (c: SyncChange) => string, showFields?: boolean) => {
    if (items.length === 0) return;
    lines.push(`  ${icon} ${C.bold}${items.length} ${label}${C.reset}`);
    const toShow = Math.min(items.length, Math.max(0, maxItems - shown));
    for (const c of items.slice(0, toShow)) {
      lines.push(formatLine(c, formatDetail(c)));
      if (showFields) {
        for (const fc of c.fields) {
          lines.push(formatFieldChange(fc, termWidth));
        }
      }
      shown++;
    }
    if (items.length > toShow) {
      const hidden = items.slice(toShow);
      const hiddenKeys = hidden.map(c => c.key).join(", ");
      lines.push(`${C.dim}    ...and ${hidden.length} more: ${hiddenKeys}${C.reset}`);
    }
  };

  showSection(newChanges, "new", `${C.green}+${C.reset}`, (c) => {
    const statusField = c.fields.find(f => f.field === "status");
    return `${C.dim}${statusField?.newValue ?? ""}${C.reset}`;
  });
  showSection(statusOnly, "moved", `${C.yellow}→${C.reset}`, (c) => {
    const f = c.fields[0];
    return `${getStatusColor(f.oldValue!)}${f.oldValue}${C.reset} → ${getStatusColor(f.newValue!)}${f.newValue}${C.reset}`;
  });
  showSection(assigneeOnly, "reassigned", `${C.cyan}~${C.reset}`, (c) => {
    const f = c.fields[0];
    return `${C.dim}${f.oldValue || "unassigned"}${C.reset} → ${f.newValue || "unassigned"}`;
  });
  showSection(modified, "modified", `${C.magenta}Δ${C.reset}`, () => "", true);

  return lines.join("\n");
}

function normalizeChangelogField(field: string): string {
  return field === "story points" ? "points" :
    field === "acceptance criteria" ? "ac" :
    field === "testing instructions" ? "ti" :
    field === "issue type" ? "type" :
    field;
}

function changelogEntriesToSyncChanges(
  entries: Array<{ key: string; created: number; field: string; fromString: string | null; toString: string | null }>,
  issueMetaMap: Map<string, { summary: string; issueType: string; assignee?: string; teamId?: string }>,
): SyncChange[] {
  const byKey = new Map<string, FieldChange[]>();
  for (const e of entries) {
    if (!issueMetaMap.has(e.key)) continue;
    const field = e.field.toLowerCase();
    if (field.startsWith("remoteworkitemlink")) continue;
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    if (field === "comment") {
      // Jira stores comment body in fromString for changelog entries
      const body = e.fromString || e.toString || "";
      if (body) {
        byKey.get(e.key)!.push({ field: "comment", newValue: body });
      }
      continue;
    }
    const fieldName = normalizeChangelogField(field);
    const isText = ["description", "ac", "ti"].includes(fieldName);
    byKey.get(e.key)!.push({
      field: fieldName,
      oldValue: e.fromString ?? undefined,
      newValue: e.toString ?? undefined,
      isText,
    });
  }

  const changes: SyncChange[] = [];
  for (const [key, fields] of byKey) {
    const meta = issueMetaMap.get(key)!;
    changes.push({
      key,
      summary: meta.summary,
      issueType: meta.issueType,
      assignee: meta.assignee,
      teamId: meta.teamId,
      changeType: "changed",
      fields,
    });
  }
  return changes;
}

function changelogEntriesToLogJson(
  entries: Array<{ key: string; created: number; field: string; fromString: string | null; toString: string | null; author: string | null }>,
  issueMetaMap: Map<string, unknown>,
) {
  return entries
    .filter(e => issueMetaMap.has(e.key) && !e.field.toLowerCase().startsWith("remoteworkitemlink"))
    .map(e => {
      const field = e.field.toLowerCase();
      if (field === "comment") {
        return { key: e.key, field: "comment", from: null, to: e.fromString || e.toString || "", author: e.author, date: new Date(e.created).toISOString() };
      }
      return { key: e.key, field: normalizeChangelogField(field), from: e.fromString, to: e.toString, author: e.author, date: new Date(e.created).toISOString() };
    });
}

async function cmdLog(creds: Credentials, args: Record<string, unknown>): Promise<void> {
  const hours = Number(args.h) || 30;
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;
  const isSprint = args.scope === "sprint";
  const showAll = !!args.a;

  const accountId = await requireAccountId(creds.email);

  let rawIssues: unknown[];
  let label: string;

  if (isSprint) {
    const localData = getLocalSprintData(getMyBoardId());
    if (!localData) {
      out(`${C.yellow}No active sprint found in cache.${C.reset} Run ${C.bold}tik sync${C.reset} first.`);
      return;
    }
    rawIssues = localData.rawIssues;
    label = showAll ? "Sprint (all)" : "Sprint (mine)";
  } else if (showAll) {
    const allKeys = await getCachedKeys();
    const rawMap = getCachedIssuesRaw(allKeys);
    rawIssues = [...rawMap.values()];
    label = "All tickets";
  } else {
    rawIssues = getLocalMineIssues(accountId, getQaAccountIds());
    label = "My tickets";
  }

  const issues = parseIssues({ issues: rawIssues });

  let filteredIssues = issues;
  if (isSprint && !showAll) {
    const wasMine = getWasMineKeys(accountId, issues.map(i => i.key));
    filteredIssues = issues.filter(i =>
      i.assigneeId === accountId ||
      (wasMine.has(i.key) && i.assigneeId && getQaAccountIds()?.has(i.assigneeId))
    );
  }

  const keys = filteredIssues.map(i => i.key);
  if (keys.length === 0) {
    out(`${C.dim}No tickets found.${C.reset}`);
    return;
  }

  const issueMetaMap = new Map<string, { summary: string; issueType: string; assignee?: string; teamId?: string }>();
  for (const i of filteredIssues) {
    issueMetaMap.set(i.key, { summary: i.summary, issueType: i.issueType, assignee: i.assignee ?? undefined, teamId: i.teamId ?? undefined });
  }
  const entries = getChangelogEntries(keys, sinceMs);

  if (globalFormat === "json") {
    out(JSON.stringify(changelogEntriesToLogJson(entries, issueMetaMap), null, 2));
    return;
  }

  const changes = changelogEntriesToSyncChanges(entries, issueMetaMap);

  if (changes.length === 0) {
    out(`${C.dim}No changes in the last ${hours}h.${C.reset}`);
    return;
  }

  out(`${C.bold}${label}${C.reset} — changes in the last ${hours}h\n`);
  out(formatChangeSummary(changes));
}

function extractUsersFromIssues(rawIssues: unknown[]): Array<{ accountId: string; displayName: string; email?: string | null; active?: boolean }> {
  const seen = new Map<string, { accountId: string; displayName: string; email?: string | null; active?: boolean }>();
  for (const raw of rawIssues) {
    const fields = (raw as Record<string, unknown>)?.fields as Record<string, unknown> | undefined;
    if (!fields) continue;
    for (const field of ["assignee", "reporter", "creator"] as const) {
      const person = fields[field] as Record<string, unknown> | undefined;
      if (person?.accountId && typeof person.accountId === "string" && !seen.has(person.accountId)) {
        seen.set(person.accountId, {
          accountId: person.accountId,
          displayName: (person.displayName as string) || "Unknown",
          email: (person.emailAddress as string) || null,
          active: person.active !== false,
        });
      }
    }
  }
  return [...seen.values()];
}

async function runSync(creds: Credentials, opts?: {
  projects?: string[];
  fullSync?: boolean;
  includeDone?: boolean;
}): Promise<void> {
  const projects = opts?.projects ?? [...Config.syncProjects];
  const fullSync = opts?.fullSync ?? false;
  const includeDone = opts?.includeDone ?? true;
  const lastSync = fullSync ? null : await getLastSyncTime();

  const conditions: string[] = [];
  conditions.push(`project IN (${projects.join(", ")})`);
  if (lastSync) {
    const date = new Date(lastSync);
    const jiraDate = date.toISOString().replace("T", " ").replace("Z", "").slice(0, 16);
    conditions.push(`updated >= "${jiraDate}"`);
  }
  if (!includeDone) {
    conditions.push(`status NOT IN (${DoneStatusesJql})`);
  }

  const jql = `${conditions.join(" AND ")} ORDER BY updated DESC`;
  const syncStartTime = new Date().toISOString();
  const batchSize = 100;
  let nextPageToken: string | null = null;
  let totalFetched = 0;
  let totalIssues = 0;
  const syncedKeys: string[] = [];
  const syncedRawIssues: unknown[] = [];
  const isIncremental = !!lastSync && !fullSync;
  const allChanges: SyncChange[] = [];

  const modeLabel = lastSync
    ? `Incremental since ${formatRelativeDate(lastSync)}`
    : `Full sync${includeDone ? "" : " (open only)"}`;

  const progress = new SyncProgress(modeLabel);
  progress.startPhase("tickets");

  try {
    do {
      const result = await jiraSearchPaginated(creds, jql, batchSize, nextPageToken);
      totalIssues = result.total;
      if (result.issues.length > 0) {
        if (isIncremental) {
          const batchChanges = await diffAndCacheIssues(result.issues);
          allChanges.push(...batchChanges);
        } else {
          await cacheIssues(result.issues);
        }
        syncedRawIssues.push(...result.issues);
        for (const raw of result.issues) {
          const key = parseIssue(raw).key;
          if (key) syncedKeys.push(key);
        }
        totalFetched += result.issues.length;
      }
      progress.update(totalFetched, totalIssues);
      nextPageToken = result.nextPageToken;
    } while (nextPageToken);

    try {
      const me = await jiraGet(creds, "/rest/api/3/myself") as { accountId?: string };
      if (me.accountId) await cacheUserMapping(creds.email, me.accountId);
    } catch {}

    upsertUsersFromSync(extractUsersFromIssues(syncedRawIssues));

    const timelineKeys = fullSync ? await getCachedKeys() : syncedKeys;
    if (timelineKeys.length > 0) {
      progress.startPhase("changelogs");
      await syncTimelineDates(creds, timelineKeys, (fetched, total) => {
        progress.update(fetched, total);
      });
    }

    // Embedding phase (best-effort, skipped if Ollama unavailable)
    let embeddedCount = 0;
    try {
      const ollamaUp = await isOllamaAvailable();
      if (ollamaUp) {
        progress.startPhase("embeddings");
        embeddedCount = await syncEmbeddings((done, total) => {
          progress.update(done, total);
        });
        if (embeddedCount > 0) invalidateEmbeddingCache();
      }
    } catch {
      // Silently skip embedding errors
    }

    const parts: string[] = [`${totalFetched} tickets`];
    const tlCount = timelineKeys.length;
    if (tlCount > 0) parts.push(`${tlCount} changelogs`);
    if (embeddedCount > 0) parts.push(`${embeddedCount} embeddings`);
    const doneMsg = totalFetched === 0
      ? `${C.green}✓${C.reset} ${C.dim}No changes${C.reset}`
      : `${C.green}✓${C.reset} Synced ${parts.join(", ")}`;

    await setLastSyncTime(syncStartTime);
    invalidateSearchIndex();
    await progress.done(doneMsg);
  } catch (err) {
    const errorMsg = `${C.red}Error:${C.reset} ${err instanceof Error ? err.message : String(err)}`;
    await progress.error(errorMsg);
    process.exit(1);
  }

  if (isIncremental) {
    if (allChanges.length > 0) {
      const unchanged = totalFetched - allChanges.length;
      out(formatChangeSummary(allChanges));
      if (unchanged > 0) {
        out(`${C.dim}    ${unchanged} unchanged${C.reset}`);
      }
    } else if (totalFetched > 0) {
      out(`${C.dim}  ${totalFetched} tickets refreshed (no changes)${C.reset}`);
    }
  }

  const stats = await getCacheStats();
  out(`${C.dim}Total in cache: ${stats.totalIssues}${C.reset}`);
}

async function ensureCacheOrFresh(creds: Credentials, args: Record<string, unknown>): Promise<void> {
  if (args.F) {
    await runSync(creds);
    return;
  }
  const stats = await getCacheStats();
  if (stats.totalIssues === 0) {
    console.error(`${C.red}No local data.${C.reset} Run ${C.cyan}tik sync${C.reset} first.`);
    process.exit(1);
  }
}

async function requireAccountId(email: string): Promise<string> {
  const accountId = await getUserAccountId(email);
  if (!accountId) {
    console.error(`${C.red}Account ID not cached.${C.reset} Run ${C.cyan}tik sync${C.reset} or use ${C.cyan}-F${C.reset}.`);
    process.exit(1);
  }
  return accountId;
}

async function cmdPrio(creds: Credentials): Promise<void> {
  if (globalFormat === "table") showLoading("Loading...");

  const [sprintResp, myself] = await Promise.all([
    jiraGet(creds, `/rest/agile/1.0/board/${Config.myBoardId}/sprint?state=active`) as Promise<{ values?: unknown[] }>,
    jiraGet(creds, "/rest/api/3/myself") as Promise<{ accountId?: string }>,
  ]);

  const sprints = sprintResp.values || [];
  if (sprints.length === 0) {
    clearLoading();
    out("No active sprint found");
    process.exit(1);
  }

  const sprint = parseSprint(sprints[0]);
  const issuesResult = await jiraGet(creds, `/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=200`) as { issues?: unknown[] };
  const allIssues = parseIssues(issuesResult);

  if (issuesResult.issues) await cacheIssues(issuesResult.issues);

  const highPrio = allIssues
    .filter(i => ["1", "2"].includes(i.priorityId))
    .filter(i => !StatusCategory.done.statuses.includes(i.status))
    .sort((a, b) => parseInt(a.priorityId) - parseInt(b.priorityId));

  clearLoading();

  if (globalFormat === "json") {
    out(JSON.stringify(highPrio, null, 2));
    return;
  }

  if (globalFormat === "plain") {
    for (const issue of highPrio) {
      out(issue.key);
    }
    return;
  }

  const renderPrioView = async (prMap?: PRMap) => {
    await renderStatic(React.createElement(IssueListView, {
      title: `High Priority in ${sprint.name}`,
      issues: highPrio,
      grouped: false,
      prMap,
      currentUserId: myself.accountId,
      showPR: globalShowPR,
      showStatus: true,
    }));
  };

  if (globalShowPR) {
    await renderPrioView(undefined);

    showLoading("Loading PR status...");
    const prMap = await fetchPRsForTickets(highPrio.map(i => i.key));

    clearScreen();
    await renderPrioView(prMap);
  } else {
    await renderPrioView(undefined);
  }
}

async function cmdTriage(creds: Credentials, _showAll: boolean): Promise<void> {
  const fetchIssues = async () => {
    const qaIdList = [...getQaAccountIds()].map(id => `"${id}"`).join(", ");
    const jql = `(assignee=currentUser() AND status not in (${DoneStatusesJql})) OR (assignee WAS currentUser() AND assignee in (${qaIdList}) AND status not in (${DoneStatusesJql})) ORDER BY updated DESC`;

    const [issuesResult, sprintResp] = await Promise.all([
      jiraSearch(creds, jql, 50) as Promise<{ issues?: unknown[] }>,
      jiraGet(creds, `/rest/agile/1.0/board/${Config.myBoardId}/sprint?state=active,future`) as Promise<{ values?: { id: number; name: string; state: string }[] }>,
    ]);

    if (issuesResult.issues) await cacheIssues(issuesResult.issues);

    const rawIssues = parseIssues(issuesResult);

    const issues = rawIssues.map((issue) => {
      const raw = (issuesResult as { issues?: unknown[] }).issues?.find(
        (i: unknown) => (i as { key: string }).key === issue.key
      ) as { fields?: Record<string, unknown> } | undefined;

      const sprintArr = raw?.fields?.[customFields.sprint] as { id: number; name: string }[] | undefined;
      const sprint = Array.isArray(sprintArr) && sprintArr.length > 0 ? sprintArr[sprintArr.length - 1] : null;
      const teamId = (raw?.fields?.[customFields.team] as string | undefined) ?? null;

      return {
        ...issue,
        sprint: sprint ? { id: sprint.id, name: sprint.name } : undefined,
        teamId,
        teamName: teamId && teamId === localConfig.myTeamId ? MyTeamName : teamId ? "Other" : null,
      } as IssueData & { sprint?: { id: number; name: string }; teamId?: string; teamName?: string };
    });

    const sprints = (sprintResp.values || [])
      .filter((s) => s.state === "active" || s.state === "future")
      .slice(0, 3)
      .map((s) => ({ id: s.id, name: s.name }));

    return { issues, sprints };
  };

  if (globalFormat === "json") {
    const { issues } = await fetchIssues();
    out(JSON.stringify(filterIssues(issues, _showAll), null, 2));
    return;
  }

  await runTriageInk(creds, fetchIssues, localConfig.myTeamId, MyTeamName, _showAll);
}

async function cmdStart(creds: Credentials, args: string[]): Promise<void> {
  const key = await requireTicket(args);

  showLoading(`Starting ${key}...`);

  await jiraPost(creds, `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: Config.inProgressTransitionId },
  });

  clearLoading();
  out(`${C.green}✓${C.reset} ${formatProjectKey(key)} → ${C.yellow}In Progress${C.reset}`);
}

async function cmdReview(creds: Credentials, args: string[], options: { gateCI?: boolean } = {}): Promise<void> {
  const key = await requireTicket(args);

  if (options.gateCI) {
    showLoading(`Checking PR for ${key}...`);
    const pr = await getPRForTicket(key);
    clearLoading();

    const gate = validateReviewGate(pr);
    if (!gate.ok) {
      console.error(`${C.red}✗${C.reset} ${gate.message} for ${formatProjectKey(key)}`);
      process.exit(1);
    }
  }

  showLoading(`Moving ${key} to review...`);

  await jiraPost(creds, `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: Config.reviewTransitionId },
  });

  clearLoading();
  out(`${C.green}✓${C.reset} ${formatProjectKey(key)} → ${C.cyan}${localConfig.statuses.reviewName}${C.reset}`);
}

async function renderPROverview(key: string, detail: PRDetail): Promise<void> {
  const stateColor = detail.state === "OPEN" ? C.green : detail.state === "MERGED" ? C.magenta : C.red;
  const draft = detail.isDraft ? ` ${C.yellow}[draft]${C.reset}` : "";

  out(`\n${formatProjectKey(key)}  ${C.bold}${detail.title}${C.reset}`);
  out(`${C.dim}PR:${C.reset} ${stateColor}#${detail.number}${C.reset}${draft} ${detail.state.toLowerCase()}  ${detail.headRefName} ${C.dim}→${C.reset} ${detail.baseRefName}`);
  out(`${formatDiffStats(detail.additions, detail.deletions, detail.changedFiles)}`);
  out(`${C.blue}${C.underline}${detail.url}${C.reset}`);

  // Merge line
  const mergeIcon = formatMergeStatusIcon(detail.mergeStatus);
  const mergeLabel = formatMergeStatusLabel(detail.mergeStatus);
  const conflicts = detail.mergeStatus.mergeable === "CONFLICTING"
    ? `${C.red}conflicts${C.reset}`
    : `${C.green}no conflicts${C.reset}`;
  out(`\n${C.dim}Merge:${C.reset} ${mergeIcon} ${mergeLabel}  ${C.dim}${conflicts}${C.reset}`);

  // Review line
  const reviewLabel = detail.reviewDecision === "APPROVED"
    ? `${C.green}Approved${C.reset}`
    : detail.reviewDecision === "CHANGES_REQUESTED"
      ? `${C.red}Changes requested${C.reset}`
      : detail.reviewDecision === "REVIEW_REQUIRED"
        ? `${C.yellow}Review required${C.reset}`
        : `${C.dim}Unknown${C.reset}`;
  out(`${C.dim}Review:${C.reset} ${reviewLabel}  ${C.dim}(${formatReviewSummary(detail.reviews, detail.reviewRequests)})${C.reset}`);

  // CI line
  const ciSummary = formatCheckRunSummary(detail.checkRuns);
  out(`${C.dim}CI:${C.reset} ${ciSummary}`);
}

async function renderPRCI(detail: PRDetail): Promise<void> {
  out(`\n${formatProjectKey(detail.number.toString())}  PR #${detail.number} — CI/CD Details${detail.state !== "OPEN" ? ` (${detail.state})` : ""}`);
  out("");

  // Group by workflowName
  const grouped = new Map<string, PRCheckRun[]>();
  for (const run of detail.checkRuns) {
    const group = grouped.get(run.workflowName) || [];
    group.push(run);
    grouped.set(run.workflowName, group);
  }

  const failures: PRCheckRun[] = [];

  for (const [workflow, runs] of grouped) {
    out(`  ${C.bold}${workflow || "(unnamed)"}${C.reset}`);
    for (const run of runs) {
      const icon = formatCheckRunIcon(run);
      const duration = formatCheckRunDuration(run);
      out(`    ${icon}  ${C.dim}${duration}${C.reset}`);

      if (run.status === "COMPLETED") {
        const c = (run.conclusion || "").toUpperCase();
        if (c === "FAILURE" || c === "TIMED_OUT") {
          failures.push(run);
        }
      }
    }
    out("");
  }

  out(`  ${C.dim}Summary:${C.reset} ${formatCheckRunSummary(detail.checkRuns)}`);

  if (failures.length > 0) {
    out("");
    out(`  ${C.bold}Failing:${C.reset}`);
    for (const run of failures) {
      out(`    ${C.red}✗${C.reset} ${run.name}`);
      out(`      ${C.dim}${C.underline}${run.detailsUrl}${C.reset}`);
    }
  }
}

async function renderPRReviews(detail: PRDetail): Promise<void> {
  out(`\n${formatProjectKey(detail.number.toString())}  PR #${detail.number} — Review Status`);
  out("");

  const decisionLabel = detail.reviewDecision === "APPROVED"
    ? `${C.green}${detail.reviewDecision}${C.reset}`
    : detail.reviewDecision === "CHANGES_REQUESTED"
      ? `${C.red}${detail.reviewDecision}${C.reset}`
      : detail.reviewDecision === "REVIEW_REQUIRED"
        ? `${C.yellow}${detail.reviewDecision}${C.reset}`
        : `${C.dim}${detail.reviewDecision || "UNKNOWN"}${C.reset}`;
  out(`  ${C.dim}Review Decision:${C.reset} ${decisionLabel}`);
  out("");

  const authorPad = Math.max(...detail.reviews.map(r => r.author.length + 3), 12);
  const statePad = 20;

  for (const review of detail.reviews) {
    const icon = formatReviewIcon(review);
    const authorPadded = review.author.padEnd(authorPad);
    const stateFormatted = review.state.replace(/_/g, " ").padEnd(statePad);
    const bodyExcerpt = review.body
      ? `"${review.body.replace(/\n/g, " ").slice(0, 40)}${review.body.length > 40 ? "…" : ""}"`
      : "";
    const timeAgo = formatRelativeTime(review.submittedAt);
    out(`  ${icon}  ${C.dim}${stateFormatted}${C.reset} ${bodyExcerpt ? `${bodyExcerpt}  ` : ""}${C.dim}${timeAgo}${C.reset}`);
  }

  if (detail.reviewRequests.length > 0) {
    out("");
    out(`  ${C.dim}Reviewers requested:${C.reset} ${detail.reviewRequests.join(", ")}`);
  }

  out("");
  // Count how many CHANGES_REQUESTED have actual bodies (proxy for unresolved)
  const changesRequested = detail.reviews.filter(r => r.state === "CHANGES_REQUESTED").length;
  if (changesRequested > 0) {
    out(`  ${C.dim}Unresolved reviews with changes requested:${C.reset} ${changesRequested}`);
  }
  out(`  ${C.dim}Total comments:${C.reset} ${detail.totalComments}`);
}

async function renderPRMerge(detail: PRDetail): Promise<void> {
  out(`\n${formatProjectKey(detail.number.toString())}  PR #${detail.number} — Merge Readiness`);
  out("");

  const mergeableIcon = detail.mergeStatus.mergeable === "MERGEABLE"
    ? `${C.green}✓${C.reset}`
    : detail.mergeStatus.mergeable === "CONFLICTING"
      ? `${C.red}✗${C.reset}`
      : `${C.dim}◌${C.reset}`;
  out(`  ${C.dim}Mergeability:${C.reset} ${mergeableIcon} ${detail.mergeStatus.mergeable}`);
  out(`  ${C.dim}Base:${C.reset}         ${detail.headRefName} ${C.dim}→${C.reset} ${detail.baseRefName}`);

  const statusIcon = formatMergeStatusIcon(detail.mergeStatus);
  const statusLabel = formatMergeStatusLabel(detail.mergeStatus);
  out("");
  out(`  ${C.dim}Status:${C.reset} ${statusIcon} ${statusLabel}`);

  // Human readable explanation
  let canMergeExplain: string;
  const ms = detail.mergeStatus;
  if (ms.mergeable === "CONFLICTING") {
    canMergeExplain = `${C.red}No${C.reset} — merge conflicts exist`;
  } else if (ms.mergeable === "UNKNOWN") {
    canMergeExplain = `${C.yellow}Checking...${C.reset} — GitHub is still computing mergeability`;
  } else {
    switch (ms.mergeStateStatus) {
      case "CLEAN":
        canMergeExplain = `${C.green}Yes${C.reset} — all requirements met`;
        break;
      case "BEHIND":
        canMergeExplain = `${C.yellow}No${C.reset} — branch is behind base`;
        break;
      case "BLOCKED":
        canMergeExplain = `${C.red}No${C.reset} — blocked by branch protection requirements`;
        break;
      case "DIRTY":
        canMergeExplain = `${C.yellow}No${C.reset} — merge commit required`;
        break;
      case "UNSTABLE":
        canMergeExplain = `${C.yellow}No${C.reset} — required checks are not passing`;
        break;
      case "HAS_HOOKS":
        canMergeExplain = `${C.yellow}Pending${C.reset} — pending required checks`;
        break;
      default:
        canMergeExplain = `${C.yellow}Unknown${C.reset}`;
    }
  }

  out("");
  out(`  ${C.dim}Can merge now?${C.reset}  ${canMergeExplain}`);
  out(`  ${C.dim}Conflicts:${C.reset}      ${ms.mergeable === "CONFLICTING" ? `${C.red}Yes${C.reset}` : `${C.green}None${C.reset}`}`);
  out(`  ${C.dim}Draft:${C.reset}          ${detail.isDraft ? `${C.yellow}Yes${C.reset}` : `${C.dim}No${C.reset}`}`);

  // Count pending checks
  const pending = detail.checkRuns.filter(r => r.status !== "COMPLETED").length;
  if (pending > 0) {
    out(`  ${C.dim}Checks:${C.reset}         ${C.yellow}◌ ${pending} ${pending === 1 ? "check" : "checks"} still ${pending === 1 ? "is" : "are"} pending${C.reset}`);
  } else {
    out(`  ${C.dim}Checks:${C.reset}         ${C.green}all complete${C.reset}`);
  }

  if (ms.mergeStateStatus === "BEHIND") {
    out(`  ${C.dim}Advice:${C.reset}         ${C.yellow}Run \`git pull --rebase origin ${detail.baseRefName}\` to catch up${C.reset}`);
  }
}

async function cmdPR(args: string[], mode: { showCI?: boolean; showReviews?: boolean; showMerge?: boolean; showAll?: boolean } = {}): Promise<void> {
  let key: string;
  let repo: string | undefined;
  let detail: PRDetail | undefined;
  let prSummary: PRData | undefined;
  let branchName: string | null = null;

  // Detect if a key was explicitly given vs from-branch auto-detection
  const hasExplicitKey = args.length > 0 && args[0] && !args[0].startsWith("-");

  if (!hasExplicitKey) {
    // No key given — detect current branch and look up PR directly
    branchName = await getCurrentBranch();
    if (!branchName) {
      console.error("Error: Not in a git repository");
      process.exit(1);
    }

    // Extract ticket key from branch for display & project mapping
    const branchTicket = await ticketFromBranch();
    if (!branchTicket) {
      console.error("Error: Could not extract ticket key from branch name");
      process.exit(1);
    }
    key = branchTicket;

    const project = key.split("-")[0];
    repo = getRepoForProject(project);
    if (!repo) {
      out(`${C.dim}No GitHub repo mapping for project ${project}${C.reset}`);
      return;
    }

    showLoading(`Loading PR for ${key} (${branchName})...`);

    // Try branch-based lookup first (most direct)
    detail = await fetchPRDetailForBranch(repo, branchName);

    if (detail) {
      clearLoading();
      // Got it from branch lookup directly
    } else {
      // Fall back to ticket-based lookup
      prSummary = await getPRForTicket(key);
      if (prSummary) {
        detail = await fetchPRDetail(repo, prSummary.number);
      }
      clearLoading();
    }
  } else {
    // Explicit key given — use existing ticket-based path
    key = await requireTicket(args);
    showLoading(`Loading PR for ${key}...`);

    const project = key.split("-")[0];
    repo = getRepoForProject(project);
    if (!repo) {
      clearLoading();
      out(`${C.dim}No GitHub repo mapping for project ${project}${C.reset}`);
      return;
    }

    prSummary = await getPRForTicket(key);
    if (!prSummary) {
      clearLoading();
      if (globalFormat === "json") {
        out(JSON.stringify({ key, pr: null }, null, 2));
        return;
      }
      if (globalFormat === "plain") {
        out(`${key}\t\t\t\t\t`);
        return;
      }
      out(`${C.dim}No PR found for${C.reset} ${formatProjectKey(key)}`);
      return;
    }

    detail = await fetchPRDetail(repo, prSummary.number);
    clearLoading();
  }

  // Handle case where no PR found at all (both lookup paths failed)
  if (!detail && !prSummary) {
    if (globalFormat === "json") {
      out(JSON.stringify({ key, pr: null }, null, 2));
      return;
    }
    if (globalFormat === "plain") {
      out(`${key}\t\t\t\t\t`);
      return;
    }
    if (branchName) {
      out(`${C.dim}No PR found on branch${C.reset} ${branchName}`);
    } else {
      out(`${C.dim}No PR found for${C.reset} ${formatProjectKey(key)}`);
    }
    return;
  }

  const fallbackPR = prSummary!; // safe — checked above

  if (globalFormat === "json") {
    out(JSON.stringify({ key, pr: detail || fallbackPR }, null, 2));
    return;
  }

  if (globalFormat === "plain") {
    if (!detail) {
      out(`${key}\t${fallbackPR.number}\t${fallbackPR.state}\t${fallbackPR.reviewDecision || ""}\t${fallbackPR.checksStatus || ""}\t${fallbackPR.url}`);
      return;
    }
    const ms = detail.mergeStatus;
    out(`${key}\t${detail.number}\t${detail.state}\t${detail.reviewDecision || ""}\t${detail.checksStatus || ""}\t${detail.mergeStatus.mergeable}\t${detail.mergeStatus.mergeStateStatus}\t${detail.url}`);
    return;
  }

  if (!detail) {
    // Fall back to basic PRData
    const stateColor = fallbackPR.state === "OPEN" ? C.green : fallbackPR.state === "MERGED" ? C.magenta : C.red;
    const review = formatPRReviewLabel(fallbackPR);
    const checks = formatPRChecksLabel(fallbackPR);
    const draft = fallbackPR.isDraft ? ` ${C.yellow}[draft]${C.reset}` : "";

    out(`\n${formatProjectKey(key)}  ${C.bold}${fallbackPR.title}${C.reset}`);
    out(`${C.dim}PR:${C.reset} ${stateColor}#${fallbackPR.number}${C.reset}${draft} ${fallbackPR.state.toLowerCase()} ${C.blue}${C.underline}${fallbackPR.url}${C.reset}`);
    out(`${C.dim}Review:${C.reset} ${review}`);
    out(`${C.dim}CI:${C.reset} ${checks}`);
    out(`${C.dim}Branch:${C.reset} ${fallbackPR.headRefName}`);
    return;
  }

  const isDefault = !mode.showCI && !mode.showReviews && !mode.showMerge;

  if (isDefault) {
    // Default mode: show compact overview
    await renderPROverview(key, detail);
    return;
  }

  // Detail modes
  if (mode.showAll) {
    // --all: overview + all detail sections
    await renderPROverview(key, detail);
    await renderPRMerge(detail);
    await renderPRReviews(detail);
    await renderPRCI(detail);
    return;
  }

  // Individual detail mode: header first
  out(`\n${formatProjectKey(key)}  ${C.bold}${detail.title}${C.reset}`);
  out(`${C.blue}${C.underline}${detail.url}${C.reset}`);

  if (mode.showMerge) {
    await renderPRMerge(detail);
  }

  if (mode.showReviews) {
    await renderPRReviews(detail);
  }

  if (mode.showCI) {
    await renderPRCI(detail);
  }
}

function formatPRStateIcon(state: MyPRSummary["state"], isDraft: boolean): string {
  if (state === "OPEN") return isDraft ? `${C.yellow}◌${C.reset}` : `${C.green}●${C.reset}`;
  if (state === "MERGED") return `${C.magenta}◆${C.reset}`;
  return `${C.red}○${C.reset}`;
}

function formatPRReviewIconShort(decision: MyPRSummary["reviewDecision"]): string {
  if (decision === "APPROVED") return `${C.green}✓${C.reset}`;
  if (decision === "CHANGES_REQUESTED") return `${C.red}✗${C.reset}`;
  if (decision === "REVIEW_REQUIRED") return `${C.yellow}◌${C.reset}`;
  return `${C.dim}—${C.reset}`;
}

function formatPRChecksIconShort(status: MyPRSummary["checksStatus"]): string {
  if (status === "SUCCESS") return `${C.green}✓${C.reset}`;
  if (status === "FAILURE") return `${C.red}✗${C.reset}`;
  if (status === "PENDING") return `${C.yellow}◌${C.reset}`;
  return `${C.dim}—${C.reset}`;
}

async function fetchMyPRsWithCache(opts: {
  repos?: string[];
  state?: "OPEN" | "MERGED" | "CLOSED" | "all";
  fresh?: boolean;
}): Promise<MyPRSummary[]> {
  // Try cache first (unless --fresh)
  if (!opts.fresh) {
    const cacheOpts: { repos?: string[]; state?: string } = {};
    if (opts.repos) cacheOpts.repos = opts.repos;
    if (opts.state && opts.state !== "all") cacheOpts.state = opts.state;

    const cached = getCachedPRs(cacheOpts);
    if (cached && !cached.isStale) {
      // Cache is fresh — return parsed data
      return cached.prs.map(c => ({
        repo: c.repo,
        number: c.number,
        state: c.state as MyPRSummary["state"],
        ...(c.data as Omit<MyPRSummary, "repo" | "number" | "state">),
      } as MyPRSummary));
    }
  }

  // Cache miss or stale — fetch fresh
  const prs = await fetchMyPRs({
    repos: opts.repos,
    state: opts.state,
  });

  // Cache the results (store all states so future queries with different state filters can hit)
  // Store full unfiltered set so cached queries with different state/repo filters work
  if (prs.length > 0) {
    cachePRs(prs.map(pr => ({
      repo: pr.repo,
      number: pr.number,
      state: pr.state,
      data: {
        title: pr.title,
        url: pr.url,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        isDraft: pr.isDraft,
        updatedAt: pr.updatedAt,
        reviewDecision: pr.reviewDecision,
        checksStatus: pr.checksStatus,
      },
    })));
  }

  return prs;
}

async function cmdMyPRs(args: {
  repos?: string[];
  projects?: string[];
  org?: string;
  state?: "OPEN" | "MERGED" | "CLOSED" | "all";
  fresh?: boolean;
  showCI?: boolean;
  showReviews?: boolean;
  showMerge?: boolean;
  showAll?: boolean;
}): Promise<void> {
  // Resolve repos from --project and --org filters
  let targetRepos: string[] | undefined;
  if (args.projects && args.projects.length > 0) {
    targetRepos = args.projects.map(p => getRepoForProject(p.toUpperCase())).filter((r): r is string => !!r);
    if (targetRepos.length === 0) {
      out(`${C.yellow}No repo mappings found for specified projects${C.reset}`);
      return;
    }
  }
  if (args.repos && args.repos.length > 0) {
    targetRepos = args.repos;
  }
  if (args.org) {
    const allRepos = getAllMappedRepos();
    targetRepos = allRepos.filter(r => r.toLowerCase().startsWith(args.org!.toLowerCase() + "/"));
    if (targetRepos.length === 0) {
      out(`${C.yellow}No mapped repos found under org "${args.org}"${C.reset}`);
      return;
    }
  }

  showLoading("Fetching your PRs...");
  try {
    const prs = await fetchMyPRsWithCache({
      repos: targetRepos,
      state: args.state,
      fresh: args.fresh,
    });
    clearLoading();

    if (prs.length === 0) {
      if (globalFormat === "json") {
        out(JSON.stringify({ prs: [] }, null, 2));
        return;
      }
      if (globalFormat === "plain") {
        out("");
        return;
      }
      const filterDesc = args.repos?.length
        ? ` in ${args.repos.join(", ")}`
        : args.projects?.length
          ? ` for projects ${args.projects.join(", ")}`
          : args.org
            ? ` in ${args.org}`
            : "";
      out(`${C.dim}No PRs found${filterDesc}${C.reset}`);
      return;
    }

    if (globalFormat === "json") {
      out(JSON.stringify({ prs, count: prs.length }, null, 2));
      return;
    }

    if (globalFormat === "plain") {
      for (const pr of prs) {
        out(`${pr.repo}\t${pr.number}\t${pr.state}\t${pr.reviewDecision || ""}\t${pr.checksStatus || ""}\t${pr.title}\t${pr.url}`);
      }
      return;
    }

    const showDetails = args.showAll || args.showCI || args.showReviews || args.showMerge;

    // ── Table view ──
    const repoPad = Math.max(...prs.map(p => p.repo.length), 6);
    const numPad = Math.max(...prs.map(p => String(p.number).length), 1);
    const titleWidth = Math.min(process.stdout.columns ? process.stdout.columns - repoPad - numPad - 42 : 60, 80);

    out(`\n${C.bold}My PRs${C.reset} ${C.dim}(${prs.length})${C.reset}`);
    if (args.repos || args.projects || args.org) {
      const filterDesc = args.repos?.join(", ") || args.projects?.join(", ") || args.org || "";
      out(`${C.dim}Filter: ${filterDesc}${C.reset}`);
    }
    out("");

    // Header
    const stateHdr = "St".padEnd(2);
    const reviewHdr = "Rv".padEnd(2);
    const ciHdr = "CI".padEnd(2);
    out(`  ${C.dim}${stateHdr}  ${reviewHdr}  ${ciHdr}  #${"".padEnd(numPad - 1)}  ${C.reset}${C.dim}Repo${"".padEnd(Math.max(0, repoPad - 4))}  Title${C.reset}`);
    out(`  ${C.dim}--  --  --  ${"".padEnd(numPad)}  ${"".padEnd(repoPad)}  ${"".padEnd(titleWidth)}${C.reset}`);

    for (const pr of prs) {
      const stateIcon = formatPRStateIcon(pr.state, pr.isDraft);
      const reviewIcon = formatPRReviewIconShort(pr.reviewDecision);
      const ciIcon = formatPRChecksIconShort(pr.checksStatus);
      const numStr = String(pr.number);
      const repoStr = pr.repo.length > repoPad ? pr.repo.slice(0, repoPad - 3) + "…" : pr.repo.padEnd(repoPad);
      const title = pr.title.length > titleWidth ? pr.title.slice(0, titleWidth - 1) + "…" : pr.title;
      out(`  ${stateIcon}  ${reviewIcon}  ${ciIcon}  ${C.dim}#${numStr}${C.reset}  ${repoStr}  ${title}`);
    }

    out("");
    out(`${C.dim}Legend: ${formatPRStateIcon("OPEN", false)} open  ${formatPRStateIcon("OPEN", true)} draft  ${formatPRStateIcon("MERGED", false)} merged  ${formatPRStateIcon("CLOSED", false)} closed  |  ${formatPRReviewIconShort("APPROVED")} approved  ${formatPRReviewIconShort("CHANGES_REQUESTED")} changes  ${formatPRReviewIconShort("REVIEW_REQUIRED")} pending  |  ${formatPRChecksIconShort("SUCCESS")} pass  ${formatPRChecksIconShort("FAILURE")} fail  ${formatPRChecksIconShort("PENDING")} running${C.reset}`);

    // If detail flags are set, fetch and show details for each PR
    if (showDetails) {
      for (const pr of prs) {
        out("");
        const sepLen = process.stdout.columns ? Math.min(process.stdout.columns - 1, 80) : 60;
        out(`${C.dim}${String.prototype.repeat.call("─", sepLen)}${C.reset}`);
        const detail = await fetchPRDetail(pr.repo, pr.number);
        if (!detail) {
          out(`${C.yellow}Could not load details for #${pr.number}${C.reset}`);
          continue;
        }
        if (args.showAll) {
          await renderPROverview("", detail);
          await renderPRMerge(detail);
          await renderPRReviews(detail);
          await renderPRCI(detail);
        } else {
          await renderPROverview("", detail);
          if (args.showMerge) await renderPRMerge(detail);
          if (args.showReviews) await renderPRReviews(detail);
          if (args.showCI) await renderPRCI(detail);
        }
      }
    }
  } finally {
    clearLoading();
  }
}


async function cmdOpen(args: string[]): Promise<void> {
  const key = await requireTicket(args);
  const url = `${Config.jiraBase}/browse/${key}`;

  if (globalFormat === "plain" || globalFormat === "json") {
    out(url);
  } else {
    out(`${C.dim}Opening${C.reset} ${formatProjectKey(key)} ${C.dim}in browser...${C.reset}`);
    Bun.spawn(["open", url]);
  }
}

async function cmdBranch(creds: Credentials): Promise<void> {
  if (!(await ensureInsideGitRepo())) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }

  const ticket = await ticketFromBranch();
  if (!ticket) {
    console.error("Error: Could not extract ticket from branch name");
    console.error("Branch should contain a ticket key like PROJ-123");
    process.exit(1);
  }

  if (globalFormat === "table") showLoading(`Loading ${ticket}...`);

  const issue = await jiraGet(creds, `/rest/api/3/issue/${ticket}`);
  await cacheSingleIssue(issue);
  const links = parseIssueLinks(issue);
  clearLoading();

  const allSections = { showDescription: true, showAC: true, showTI: true };
  if (globalShowPR && globalFormat === "table") {
    await formatIssue(issue, undefined, links, allSections);

    showLoading("Loading PR status...");
    const prMap = await fetchPRsForTickets([ticket]);

    clearScreen();
    await formatIssue(issue, prMap.get(ticket), links, allSections);
  } else {
    await formatIssue(issue, undefined, links, allSections);
  }
}

async function cmdEdit(creds: Credentials, key: string, options: {
  summary?: string;
  description?: string;
  assignee?: string;
  parent?: string;
  priority?: string;
  team?: boolean;
  sprint?: boolean | string;
  points?: string;
  acceptanceCriteria?: string;
  testingInstructions?: string;
  labels?: string;
  addLabel?: string;
  removeLabel?: string;
  status?: string;
  dryRun?: boolean;
}): Promise<void> {
  const fields: Record<string, unknown> = {};
  const changes: string[] = [];
  const update: Record<string, unknown> = {};

  if (options.summary) {
    const summary = await readFileArg(options.summary);
    fields.summary = summary.trim().split("\n")[0];
    changes.push(`summary → "${truncate(summary, 40)}"`);
  }

  if (options.description) {
    const description = await readFileArg(options.description);
    fields.description = markdownToAdf(description);
    const isFile = description !== options.description;
    changes.push(isFile ? `description → from ${options.description}` : `description → "${truncate(description, 30)}"`);
  }

  if (options.assignee) {
    if (options.assignee === "me") {
      const myself = (await jiraGet(creds, "/rest/api/3/myself")) as { accountId?: string };
      if (myself.accountId) {
        fields.assignee = { accountId: myself.accountId };
        changes.push("assignee → me");
      }
    } else if (options.assignee === "none" || options.assignee === "-") {
      fields.assignee = null;
      changes.push("assignee → unassigned");
    } else {
      fields.assignee = { accountId: options.assignee };
      changes.push(`assignee → ${options.assignee}`);
    }
  }

  if (options.parent) {
    if (options.parent === "none" || options.parent === "-") {
      fields.parent = null;
      changes.push("parent → removed");
    } else {
      const parentKey = await resolveTicketKey(options.parent);
      fields.parent = { key: parentKey };
      changes.push(`parent → ${parentKey}`);
    }
  }

  if (options.priority) {
    const priorityId = PriorityMap[options.priority.toLowerCase()];
    if (priorityId) {
      fields.priority = { id: priorityId };
      changes.push(`priority → ${PriorityNames[parseInt(priorityId)]}`);
    }
  }

  if (options.team) {
    fields[requireCustomField("team")] = Config.myTeamId;
    changes.push(`team → ${MyTeamName}`);
  }

  if (options.sprint) {
    if (options.sprint === true) {
      const sprintResp = (await jiraGet(
        creds,
        `/rest/agile/1.0/board/${Config.myBoardId}/sprint?state=active`
      )) as { values?: { id: number; name: string }[] };
      const activeSprint = sprintResp.values?.[0];
      if (activeSprint) {
        fields[requireCustomField("sprint")] = activeSprint.id;
        changes.push(`sprint → ${activeSprint.name}`);
      }
    } else if (options.sprint === "none" || options.sprint === "-") {
      fields[requireCustomField("sprint")] = null;
      changes.push("sprint → removed");
    } else {
      const sprintId = parseInt(options.sprint, 10);
      if (!isNaN(sprintId)) {
        fields[requireCustomField("sprint")] = sprintId;
        changes.push(`sprint → ${sprintId}`);
      }
    }
  }

  if (options.points) {
    const pts = parseFloat(options.points);
    if (!isNaN(pts)) {
      fields[requireCustomField("storyPoints")] = pts;
      changes.push(`points → ${pts}`);
    }
  }

  if (options.acceptanceCriteria) {
    const ac = await readFileArg(options.acceptanceCriteria);
    fields[requireCustomField("acceptanceCriteria")] = markdownToAdf(ac);
    const isFile = ac !== options.acceptanceCriteria;
    changes.push(isFile ? `acceptance criteria → from ${options.acceptanceCriteria}` : `acceptance criteria → "${truncate(ac, 30)}"`);
  }

  if (options.testingInstructions) {
    const ti = await readFileArg(options.testingInstructions);
    fields[requireCustomField("testingInstructions")] = markdownToAdf(ti);
    const isFile = ti !== options.testingInstructions;
    changes.push(isFile ? `testing instructions → from ${options.testingInstructions}` : `testing instructions → "${truncate(ti, 30)}"`);
  }

  if (options.labels) {
    const labelList = options.labels.split(",").map(l => l.trim()).filter(Boolean);
    fields.labels = labelList;
    changes.push(`labels → ${labelList.join(", ")}`);
  }

  if (options.addLabel) {
    const labelToAdd = options.addLabel.trim();
    update.labels = [{ add: labelToAdd }];
    changes.push(`label + ${labelToAdd}`);
  }

  if (options.removeLabel) {
    const labelToRemove = options.removeLabel.trim();
    update.labels = [{ remove: labelToRemove }];
    changes.push(`label - ${labelToRemove}`);
  }

  if (Object.keys(fields).length === 0 && Object.keys(update).length === 0 && !options.status) {
    out(`${C.yellow}No changes specified${C.reset}`);
    out();
    out(`Usage: tik edit <KEY> [options]`);
    out(`  -s, --summary     New summary/title (or path to file)`);
    out(`  -d, --desc        New description (or path to .md file)`);
    out(`  -a, --assignee    Assignee (accountId, "me", or "none")`);
    out(`  --parent          Parent ticket key, or "none" to remove`);
    out(`  -p, --priority    Priority (1-5 or name)`);
    out(`  -e, --team        Assign to your team (myTeamId)`);
    out(`  -S                Add to current sprint`);
    out(`  --sprint <id>     Add to specific sprint, or "none" to remove`);
    out(`  --points          Story points`);
    out(`  --ac              Acceptance criteria (or path to .md file)`);
    out(`  --ti              Testing instructions (or path to .md file)`);
    out(`  --labels          Set labels (comma-separated)`);
    out(`  --add-label       Add a label`);
    out(`  --remove-label    Remove a label`);
    out(`  --status          Transition to status (name or ID)`);
    return;
  }

  const hasFieldChanges = Object.keys(fields).length > 0 || Object.keys(update).length > 0;

  let foundTransition: { id: string; name: string } | undefined;
  if (options.status) {
    if (globalFormat === "table") showLoading(`Transitioning ${key}...`);
    const transitionsResp = (await jiraGet(creds, `/rest/api/3/issue/${key}/transitions`)) as {
      transitions?: { id: string; name: string }[];
    };
    const transitions = transitionsResp.transitions || [];
    if (globalFormat === "table") clearLoading();

    const isNumeric = /^\d+$/.test(options.status);
    const found = transitions.find((t) =>
      isNumeric ? t.id === options.status : t.name.toLowerCase() === options.status!.toLowerCase()
    );

    if (!found) {
      emitError("invalid_transition", `Transition '${options.status}' not found`, {
        validTransitions: transitions.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    foundTransition = found;
  }

  if (options.dryRun) {
    const payload = { dryRun: true, action: "edit", fields, update, changes, transition: foundTransition ?? null };
    if (globalFormat === "json") {
      out(JSON.stringify(payload, null, 2));
      return;
    }
    out(`${C.yellow}Dry run — would apply:${C.reset}`);
    for (const c of changes) out(`  ${c}`);
    if (foundTransition) out(`  ${C.dim}Transition to:${C.reset} ${foundTransition.name}`);
    return;
  }

  if (hasFieldChanges) {
    showLoading(`Updating ${key}...`);

    const payload: Record<string, unknown> = {};
    if (Object.keys(fields).length > 0) payload.fields = fields;
    if (Object.keys(update).length > 0) payload.update = update;

    const result = await jiraPut(creds, `/rest/api/3/issue/${key}`, payload);

    clearLoading();

    if (!result.ok) {
      console.error(`${C.red}✗${C.reset} Failed to update ${formatProjectKey(key)}`);
      console.error(`  ${C.dim}${result.error}${C.reset}`);
      process.exit(1);
    }
  }

  if (foundTransition) {
    showLoading(`Transitioning ${key}...`);
    await jiraPost(creds, `/rest/api/3/issue/${key}/transitions`, {
      transition: { id: foundTransition.id },
    });
    clearLoading();
    changes.push(`status → ${foundTransition.name}`);
  }

  out(`${C.green}✓${C.reset} Updated ${formatProjectKey(key)}`);
  for (const change of changes) {
    out(`  ${C.dim}${change}${C.reset}`);
  }
}

async function cmdTransition(creds: Credentials, args: string[]): Promise<void> {
  const key = await requireTicket(args);
  const targetStatus = args.length > 1 ? args[1] : null;

  if (globalFormat === "table") showLoading(`Loading transitions for ${key}...`);

  const transitionsResp = (await jiraGet(creds, `/rest/api/3/issue/${key}/transitions`)) as {
    transitions?: { id: string; name: string }[];
  };
  const transitions = transitionsResp.transitions || [];

  if (globalFormat === "table") clearLoading();

  if (!targetStatus) {
    out();
    out(` ${C.bold}Available transitions for ${formatProjectKey(key)}${C.reset}`);
    out();
    for (const t of transitions) {
      out(`   ${C.dim}[${t.id}]${C.reset}  ${t.name}`);
    }
    out();
    return;
  }

  const isNumeric = /^\d+$/.test(targetStatus);
  const found = transitions.find((t) =>
    isNumeric ? t.id === targetStatus : t.name.toLowerCase() === targetStatus.toLowerCase()
  );

  if (!found) {
    emitError("invalid_transition", `Transition '${targetStatus}' not found`, {
      validTransitions: transitions.map((t) => ({ id: t.id, name: t.name })),
    });
  }

  showLoading(`Transitioning ${key}...`);

  await jiraPost(creds, `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: found.id },
  });

  clearLoading();
  out(`${C.green}✓${C.reset} ${formatProjectKey(key)} → ${found.name}`);
}

async function printAgentHelp(): Promise<void> {
  const help = `
# Tik CLI - AI Agent Reference

## Overview
CLI tool for Jira operations. Supports viewing, creating, editing tickets, managing comments, linking tickets, and transitioning statuses.

## Global Options
--json          Output as JSON (structured data, best for parsing)
--plain         Output as tab-separated values (KEY, STATUS, SUMMARY, ASSIGNEE, POINTS)
--pr            Include GitHub PR status for issues
--refresh-auth  Force credential refresh from 1Password
--agent-help    Show this AI agent reference

## Commands

### sprint (default)
Show current sprint issues assigned to me.

\`\`\`bash
tik                    # My sprint issues (default)
tik sprint             # Same as above
tik sprint -a          # All team issues (not just mine)
tik sprint -e          # Expand done section (show all completed tickets)
tik sprint -i          # Sprint info only (no issues)
tik sprint -g          # Show sprint goals
tik sprint --json      # Sprint + issues as JSON
\`\`\`

### view [KEY]
View single ticket details. If no KEY provided, extracts from current git branch.

\`\`\`bash
tik view PROJ-123
tik view               # Uses ticket from git branch (e.g., feature/PROJ-123-foo)
tik view PROJ-123 -d     # Show description
tik view PROJ-123 --ac   # Show acceptance criteria
tik view PROJ-123 --ti   # Show testing instructions
tik view PROJ-123 -A     # Show description, AC, and TI (--all)
tik view PROJ-123 -d --ac  # Mix and match sections
tik view PROJ-123 --json
tik view PROJ-123 --pr   # Include PR info
\`\`\`

### history [KEY]
Show full changelog timeline for a ticket. Fetches all field changes from Jira and displays them chronologically.

\`\`\`bash
tik history PROJ-123
tik history              # Uses ticket from git branch
tik history PROJ-123 -F # Sync before showing
tik history PROJ-123 --json
tik history PROJ-123 --plain
\`\`\`

### export [KEY]
Write a complete local copy of a ticket as markdown: field table, links, attachments,
description, AC, TI, comments and full changelog. Fetches every field live from Jira
(the sync cache only holds a subset), so it works without syncing first.

\`\`\`bash
tik export PROJ-123                       # ./PROJ-123/ticket.md + ./PROJ-123/attachments/
tik export                                 # Uses ticket from git branch
tik export PROJ-123 --out plans/PROJ-123 # Into a directory (writes ticket.md inside)
tik export PROJ-123 --out notes/copy.md   # Into a specific file
tik export PROJ-123 --stdout              # Print markdown, write nothing
tik export PROJ-123 --no-history --no-attachments
tik export PROJ-123 --bots                # Keep automated comments in full
tik export PROJ-123 --cached              # Build from the local cache instead of Jira
\`\`\`

Automated (CI/bot) comments are collapsed to one line each by default; configure which
authors count as bots with \`botAuthors\` in config.local.json.

### mine
All my open tickets (not filtered to current sprint).

\`\`\`bash
tik mine
tik mine --json
\`\`\`

### standup
Summarize last 30 hours of my Jira + GitHub account activity (commits + PRs) and match Git activity to tickets.

\`\`\`bash
tik standup
tik standup --hours 48
tik standup --json
\`\`\`

### search [query]
Search with text query, filters, or raw JQL.

\`\`\`bash
# Text search (positional argument, fuzzy matching):
tik search "login bug"                     # Fuzzy search in summary + description
tik search "auth" -p PROJ                 # Text + project filter
tik search --contains "BACKEND-PROD-822"   # Exact substring match, unranked, unlimited unless -m
tik search --contains-any ids.txt          # One token per line (--contains-any=- for stdin); JSON {token: [{key, summary, status, statusCategory, doneAt}]}

# Using filters (recommended for agents):
tik search -p PROJ                        # Project filter
tik search -t Bug                          # Type: Bug, Task, Story, Spike
tik search -s "In Progress"                # Status filter (quote multi-word)
tik search -a me                           # Assignee: "me" or account ID
tik search -p PROJ -t Bug -s "In Progress" -a me   # Combined filters
tik search -m 100                          # Max results (default: 50)

# Using raw JQL (bypasses all filters, queries Jira API directly):
tik search --jql "project=PROJ AND status='In Progress' ORDER BY updated DESC"
\`\`\`

Valid projects: ${localConfig.syncProjects.join(", ")}
Valid types: Bug, Task, Story, Spike, Epic
Statuses are those of your Jira workflow; "tik transition KEY" lists the valid ones

### prio
High priority tickets (P1/P2) in current sprint.

\`\`\`bash
tik prio
tik prio --json
\`\`\`

### create "Summary"
Create a new ticket.

\`\`\`bash
# Minimal:
tik create "Fix login button alignment"

# Full options:
tik create "Fix login button" \\
  -p PROJ              \\  # Project (default: ${localConfig.defaultProject})
  -t Bug                \\  # Type (default: Task)
  -d "Full description" \\  # Description (markdown supported)
  -a                    \\  # Assign to me
  -e                    \\  # Add your team (myTeamId)
  -S                    \\  # Add to current sprint
  --sprint 123          \\  # Or specific sprint ID
  --priority 2          \\  # 1=Highest, 2=High, 3=Medium, 4=Low, 5=Lowest
  --points 3            \\  # Story points
  --ac "- Works on mobile" \\ # Acceptance criteria (markdown)
  --ti "1. Test login flow"  \\ # Testing instructions (markdown)
  -i                       # Move to In Progress immediately

# Read from files:
tik create ./title.txt -d ./description.md --ac ./criteria.md --ti ./testing.md
\`\`\`

### edit [KEY]
Edit ticket fields. KEY from git branch if not provided.

\`\`\`bash
tik edit PROJ-123 -s "New title"
tik edit PROJ-123 -d "New description with **markdown**"
tik edit PROJ-123 -a me           # Assign to me
tik edit PROJ-123 -a none         # Unassign
tik edit PROJ-123 -p 2            # Set priority (1-5 or name)
tik edit PROJ-123 -e              # Assign your team (myTeamId)
tik edit PROJ-123 -S              # Add to current sprint
tik edit PROJ-123 --sprint 123    # Add to specific sprint
tik edit PROJ-123 --sprint none   # Remove from sprint
tik edit PROJ-123 --points 5      # Set story points
tik edit PROJ-123 --ac "criteria" # Set acceptance criteria
tik edit PROJ-123 --ti "testing"  # Set testing instructions
tik edit PROJ-123 --labels "tech-debt,urgent"  # Set labels
tik edit PROJ-123 --add-label "urgent"    # Add a label
tik edit PROJ-123 --remove-label "urgent" # Remove a label

# Read from files:
tik edit PROJ-123 -d ./spec.md --ac ./criteria.md --ti ./testing.md
\`\`\`

### start [KEY]
Transition ticket to "In Progress".

\`\`\`bash
tik start PROJ-123
tik start              # Uses ticket from git branch
\`\`\`

### review [KEY]
Transition ticket to your review status.

\`\`\`bash
tik review PROJ-123
tik review             # Uses ticket from git branch
tik review --gate-ci   # Only if PR is open + approved + checks passing
\`\`\`

### pr [KEY]
Show PR status (state, review, CI) for a ticket or current branch.

\`\`\`bash
tik pr PROJ-123
tik pr                 # Uses ticket from git branch
\`\`\`

### transition [KEY] [STATUS]
List available transitions or transition to specific status.

\`\`\`bash
tik transition PROJ-123           # List available transitions
tik transition PROJ-123 "Done"    # Transition by name
tik transition PROJ-123 11       # Transition by ID
\`\`\`

### comment [KEY] "Message"
Add a comment to a ticket.

\`\`\`bash
tik comment PROJ-123 "This is my comment"
tik comment PROJ-123 -m ./notes.md   # Comment from file
tik comment "Comment on branch ticket" # Uses ticket from git branch
\`\`\`

### comments [KEY]
View comments on a ticket. Bodies are capped at 15 lines in the boxed view — use
\`--full\` or \`--md\` to read a long comment (e.g. a test plan) in its entirety.

\`\`\`bash
tik comments PROJ-123           # All comments (bodies capped at 15 lines)
tik comments PROJ-123 -n 5      # Last 5 comments
tik comments                     # Comments on branch ticket
tik comments PROJ-123 --full    # No line cap (-f)
tik comments PROJ-123 --md      # Raw markdown bodies, pipe/file friendly
tik comments PROJ-123 --no-bots # Hide CI/automation comments
tik comments PROJ-123 --bots    # Only CI/automation comments
tik comments PROJ-123 --author sophie
tik comments PROJ-123 --json    # Parsed comments (respects the filters above)
tik comments PROJ-123 --json --raw  # Unparsed Jira response (ADF bodies)
\`\`\`

### get [KEY] REFS
Download attachments by id, filename, or \`tikmedia:\` token. Defaults to a temp dir with
\`<id>-\` prefixed names; \`--out\` saves to a directory of your choice under the plain filename.

\`\`\`bash
tik get PROJ-123 shot.png                  # → $TMPDIR/tik-attachments/10234-shot.png
tik get 10234                               # By attachment id
tik get PROJ-123 a.png,b.png --out ./docs  # → ./docs/a.png, ./docs/b.png
\`\`\`

### link KEY --type TARGET
Link two tickets together.

\`\`\`bash
tik link PROJ-123 --blocks PROJ-456       # This blocks that
tik link PROJ-123 --is-blocked-by API-789 # This is blocked by that
tik link PROJ-123 --relates-to PROJ-456   # Relates to
tik link PROJ-123 --duplicates PROJ-456   # This duplicates that
\`\`\`

### links [KEY]
View links on a ticket.

\`\`\`bash
tik links PROJ-123
tik links              # Links on branch ticket
tik links --json
\`\`\`

### open [KEY]
Open ticket in browser.

\`\`\`bash
tik open PROJ-123
tik open               # Uses ticket from git branch
\`\`\`

### branch
View ticket from current git branch name.

\`\`\`bash
tik branch
\`\`\`

## Output Formats

### --json
Returns structured JSON. For search/list commands:
\`\`\`json
{"issues": [{"key": "PROJ-123", "fields": {...}}]}
\`\`\`

### --plain
Returns tab-separated values (KEY, STATUS, SUMMARY, ASSIGNEE, POINTS):
\`\`\`
PROJ-123	In Progress	Fix login bug	John Doe	3
PROJ-124	Done	Add feature	Jane Doe	5
\`\`\`

## Markdown Support
Fields \`-d\` (description), \`--ac\` (acceptance criteria), and \`--ti\` (testing instructions) support full markdown:
- Headers: # H1, ## H2, ### H3
- Bold: **text**, Italic: *text*, Strikethrough: ~~text~~
- Code: \\\`inline\\\` and \\\`\\\`\\\`lang code blocks
- Links: [text](url)
- Lists: - bullet, 1. numbered
- Blockquotes: > quote
- Tables: | col | col |

## File Input
Pass file paths to read content from files. Auto-detected by path patterns:
- Paths with / or ./ or ~/
- Extensions: .md, .txt, .markdown

## Common Workflows

### Start working on a ticket:
\`\`\`bash
tik start PROJ-123
\`\`\`

### Create ticket and start working:
\`\`\`bash
tik create "Fix bug" -a -S -i
\`\`\`

### Create ticket, branch, and switch worktree:
\`\`\`bash
tik flow start "Fix bug"
tik flow start "PORTAL bug" -p PORTAL
tik flow start PROJ-123 -w quick
\`\`\`

### Push branch and create PR:
\`\`\`bash
tik flow pr --open
\`\`\`

### Move to review when PR is ready:
\`\`\`bash
tik review   # Uses current branch ticket
\`\`\`

### Check sprint status:
\`\`\`bash
tik --json | jq '.issues[] | {key, status: .fields.status.name}'
\`\`\`

### Find unassigned bugs:
\`\`\`bash
tik search -p PROJ -t Bug -a none --json
\`\`\`

### View ticket with full details:
\`\`\`bash
tik view PROJ-123 --full   # Shows description, AC, testing instructions
\`\`\`

### Add a comment with context:
\`\`\`bash
tik comment PROJ-123 "Fixed in PR #456. Ready for review."
\`\`\`

### Check recent comments:
\`\`\`bash
tik comments PROJ-123 -n 3   # Last 3 comments
\`\`\`

### Link related tickets:
\`\`\`bash
tik link PROJ-123 --blocks PROJ-456
tik link PROJ-123 --relates-to API-789
\`\`\`

### Add labels to categorize:
\`\`\`bash
tik edit PROJ-123 --add-label "tech-debt"
tik edit PROJ-123 --labels "urgent,frontend"
\`\`\`

### Get plain output for scripting:
\`\`\`bash
tik mine --plain | cut -f1   # Just ticket keys
tik mine --plain | awk -F'\\t' '{print $1, $2}'  # Key and status
\`\`\`

## Notes for AI Agents
- Use --json for reliable parsing of output
- Use --plain for tab-separated output (parseable with cut/awk)
- Ticket keys follow pattern: PROJECT-NUMBER (e.g., PROJ-123, API-456)
- When no KEY is provided, most commands extract it from git branch name
- Sprint commands operate on the active sprint only
- Priority values: 1=Highest, 2=High, 3=Medium, 4=Low, 5=Lowest
- Labels are comma-separated when setting multiple: --labels "a,b,c"
- Rich text fields (description, AC, TI) support full markdown
- Comments support markdown and can be read from files with -m flag
- Link types: blocks, is-blocked-by, relates-to, duplicates, is-duplicated-by

## Custom Fields Reference
Custom field IDs come from customFields in config.local.json:
- team: Team (use -e for your configured team)
- sprint: Sprint (use -S for current sprint)
- storyPoints: Story Points (use --points)
- acceptanceCriteria: Acceptance Criteria (use --ac)
- testingInstructions: Testing Instructions (use --ti)
`;
  if (globalFormat === "table") {
    await renderStatic(React.createElement(HelpView, { help }));
    return;
  }
  out(help);
}

async function runJqlSearch(creds: Credentials, jql: string, args: Record<string, unknown>): Promise<void> {
  const showSpinner = globalFormat === "table" && !args.keys && !args.count;
  if (showSpinner) showLoading("Searching...");
  const maxResults = typeof args.m === "string" ? parseInt(args.m, 10) || 50 : 50;
  const result = await jiraSearch(creds, jql, maxResults) as { issues?: unknown[] };
  if (showSpinner) clearLoading();
  if (result.issues) await cacheIssues(result.issues);

  // Re-rank text searches with local fuzzy search
  if (typeof args.q === "string" || typeof args.summary === "string") {
    await runLocalSearch(args, creds, false);
    return;
  }

  const issues = parseIssues(result);
  if (args.keys) { for (const issue of issues) out(issue.key); return; }
  if (args.count) { out(issues.length); return; }

  if (globalShowPR && globalFormat === "table") {
    await formatIssues(result, "Search Results", false);
    showLoading("Loading PR status...");
    const prMap = await fetchPRsForTickets(issues.map(i => i.key));
    clearScreen();
    await formatIssues(result, "Search Results", false, prMap);
  } else {
    await formatIssues(result, "Search Results", false);
  }
}

async function fetchAllComments(creds: Credentials, key: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let startAt = 0;
  while (true) {
    const page = (await jiraGet(
      creds,
      `/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=100`
    )) as { comments?: unknown[]; total?: number };
    const batch = page.comments || [];
    all.push(...batch);
    startAt += batch.length;
    if (batch.length === 0 || all.length >= (page.total ?? all.length)) break;
  }
  return all;
}

async function downloadAttachments(
  creds: Credentials,
  attachments: AttachmentData[],
  dir: string
): Promise<string[]> {
  if (attachments.length === 0) return [];
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const att of attachments) {
    const res = await fetch(att.url, { headers: { Authorization: makeAuthHeader(creds) } });
    if (!res.ok) {
      if (globalFormat === "table") out(`${C.yellow}⚠${C.reset} Skipped ${att.filename} (HTTP ${res.status})`);
      continue;
    }
    const filePath = path.join(dir, att.filename);
    await Bun.write(filePath, Buffer.from(await res.arrayBuffer()));
    written.push(filePath);
  }
  return written;
}

const exportCommand = defineCommand({
  meta: { description: "Export a full ticket (fields, description, AC, TI, comments, history) to markdown" },
  args: {
    key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
    out: { type: "string", description: "Output .md file, or a directory (default: ./<KEY>/ticket.md)" },
    stdout: { type: "boolean", description: "Print the markdown instead of writing files" },
    cached: { type: "boolean", description: "Build from the local cache instead of fetching all fields from Jira" },
    "no-comments": { type: "boolean", description: "Omit the comments section" },
    "no-history": { type: "boolean", description: "Omit the changelog section" },
    "no-attachments": { type: "boolean", description: "Don't download attachments" },
    bots: { type: "boolean", description: "Include automated comments in full instead of collapsing them" },
  },
  run: async ({ args }) => {
    subCommandExecuted = true;
    applyFormat(args);
    const creds = await getCredentials(args);
    const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);

    showLoading(`Exporting ${key}...`);

    let raw: unknown;
    if (args.cached) {
      const cached = await getCachedIssue(key);
      if (!cached) {
        clearLoading();
        emitError("not_cached", `Ticket ${key} not in cache. Run tik sync, or drop --cached.`);
      }
      raw = cached.raw;
    } else {
      raw = await jiraGet(creds, `/rest/api/3/issue/${key}`);
    }

    const issue = parseIssue(raw);
    const links = parseIssueLinks(raw);

    const transitionsResp = (await jiraGet(creds, `/rest/api/3/issue/${key}/transitions`)) as {
      transitions?: { id: string; name: string }[];
    };

    const comments = isDisabled(args, "comments")
      ? []
      : parseComments({ comments: await fetchAllComments(creds, key) });

    const history = isDisabled(args, "history")
      ? null
      : parseHistory(raw, await fetchFullChangelog(creds, key));

    const useStdout = !!args.stdout;
    const outArg = typeof args.out === "string" && args.out ? args.out : null;
    const filePath = useStdout
      ? null
      : outArg?.endsWith(".md")
        ? outArg
        : path.join(outArg ?? key, "ticket.md");
    const attachmentDir = filePath && !isDisabled(args, "attachments") && issue.attachments.length > 0
      ? path.join(path.dirname(filePath), "attachments")
      : null;

    const markdown = buildTicketMarkdown(
      { issue, raw, links, comments, history, availableTransitions: (transitionsResp.transitions || []).map((t) => t.name) },
      {
        jiraBase: Config.jiraBase,
        capturedAt: new Date().toISOString().slice(0, 10),
        attachmentDir: attachmentDir ? "attachments" : null,
        botAuthors: localConfig.botAuthors ?? DEFAULT_BOT_AUTHORS,
        keepBots: !!args.bots,
        teamLabel: resolveTeamName(issue.teamId ?? undefined),
      }
    );

    clearLoading();

    if (useStdout) {
      out(markdown);
      return;
    }

    await mkdir(path.dirname(filePath!), { recursive: true });
    await Bun.write(filePath!, markdown);
    const attachmentFiles = attachmentDir
      ? await downloadAttachments(creds, issue.attachments, attachmentDir)
      : [];

    if (globalFormat === "json") {
      out(JSON.stringify({ key, file: filePath, attachments: attachmentFiles }, null, 2));
      return;
    }
    if (globalFormat === "plain") {
      out([filePath, ...attachmentFiles].join("\n"));
      return;
    }
    out(`${C.green}✓${C.reset} ${filePath}`);
    for (const file of attachmentFiles) {
      out(`  ${C.dim}${file}${C.reset}`);
    }
  },
});

const searchCommand = defineCommand({
  meta: { description: "Search tickets with text or filters" },
  args: {
    query: { type: "positional", required: false, description: "Search text — fuzzy matches against summary and description (e.g., tik search 'login bug')" },
    // Text search
    summary: { type: "string", description: "Search summary/title only, excludes description" },
    jql: { type: "string", description: "Raw JQL query — bypasses all filters and searches Jira API directly" },
    contains: { type: "string", description: "Exact case-insensitive substring match over summary, description, AC and TI — unranked, unlimited unless -m is given" },
    "contains-any": { type: "string", description: "File path (or --contains-any=- for stdin) with one token per line — prints JSON mapping each token to its matching tickets" },
    // Basic filters
    p: { type: "string", description: "Filter by project — comma-separated for multiple (e.g., -p PROJ,PORTAL,API)" },
    t: { type: "string", alias: "type", description: "Filter by issue type — comma-separated (e.g., -t Bug,Task,Story,Spike)" },
    s: { type: "string", description: "Filter by status — comma-separated (e.g., -s 'In Progress,Review')" },
    a: { type: "string", description: "Filter by assignee — 'me' for yourself, 'none' for unassigned, or a person's name" },
    r: { type: "string", description: "Filter by reporter — 'me' for yourself, or a person's name" },
    l: { type: "string", description: "Filter by labels — comma-separated (e.g., -l frontend,urgent)" },
    priority: { type: "string", description: "Filter by priority — 1-5 (1=Highest) or name: Highest, High, Medium, Low, Lowest" },
    // Sprint filters
    S: { type: "boolean", alias: "current-sprint", description: "Limit results to the current active sprint" },
    sprint: { type: "string", description: "Filter by sprint ID, or 'none' for backlog items with no sprint" },
    // Date filters
    created: { type: "string", description: "Filter by created date — relative (-7d, -24h, -2w), absolute (2024-01-01), or range (start..end)" },
    updated: { type: "string", description: "Filter by updated date — relative (-7d, -24h, -2w), absolute (2024-01-01), or range (start..end)" },
    resolved: { type: "string", description: "Filter by resolved date — relative (-7d, -24h), absolute (2024-01-01), or range (start..end)" },
    // Relationship filters
    epic: { type: "string", description: "Show tickets belonging to an epic (e.g., --epic PROJ-100)" },
    parent: { type: "string", description: "Show subtasks of a parent ticket (e.g., --parent PROJ-50)" },
    // Team & points
    "my-team": { type: "boolean", description: "Limit results to your team" },
    points: { type: "string", description: "Filter by story points — exact (3), comparison (>0, >=2), range (1-5), 'none', or 'any'" },
    // Convenience shortcuts
    recent: { type: "boolean", description: "Shortcut: tickets updated in the last 7 days" },
    stale: { type: "string", description: "Tickets NOT updated in N days (e.g., --stale 30 for 30+ days inactive)" },
    backlog: { type: "boolean", description: "Shortcut: tickets with no sprint assigned and status is not done" },
    "my-created": { type: "boolean", description: "Shortcut: tickets created/reported by me" },
    // Sorting
    sort: { type: "string", alias: "o", description: "Sort results by field: updated, created, resolved, priority, status, key" },
    asc: { type: "boolean", description: "Sort ascending instead of descending (default)" },
    // Output options
    m: { type: "string", description: "Max number of results to return (default: 50)" },
    keys: { type: "boolean", description: "Output only ticket keys, one per line — useful for piping to other commands" },
    count: { type: "boolean", description: "Output only the count of matching tickets" },
    F: { type: "boolean", alias: "fresh", description: "Sync latest changes from Jira before searching" },
    "no-fuzzy": { type: "boolean", description: "Use exact matching only — disables typo tolerance and stemming" },
    "no-semantic": { type: "boolean", description: "Disable semantic/vector search — keyword matching only" },
    "min-score": { type: "string", description: "Min fuzzy match score as % of best result (default: 30) — higher values = stricter matching" },
    // Table display options
    compact: { type: "boolean", description: "Use compact table layout with less whitespace" },
    e: { type: "boolean", alias: "expand-done", description: "Show all completed/done tickets (normally collapsed into a summary line)" },
    grep: { type: "string", description: "Post-filter results by summary using a regex pattern" },
  },
  run: async ({ args }) => {
    subCommandExecuted = true;
    applyFormat(args);
    const creds = await getCredentials(args);

    // Positional query → treat as text search
    if (typeof args.query === "string") args.q = args.query;

    // Raw JQL via --jql flag → always remote
    if (typeof args.jql === "string") {
      await runJqlSearch(creds, args.jql, args);
      return;
    }

    // Convert convenience flags to filters that runLocalSearch understands
    if (args.recent && !args.updated) args.updated = "-7d";

    // Require at least one filter
    const hasFilters = typeof args.q === "string" || typeof args.summary === "string" ||
      typeof args.contains === "string" || typeof args["contains-any"] === "string" ||
      typeof args.p === "string" || typeof args.t === "string" ||
      typeof args.s === "string" || typeof args.a === "string" ||
      typeof args.l === "string" || typeof args.priority === "string" ||
      typeof args.epic === "string" || typeof args.points === "string" ||
      typeof args.updated === "string" || typeof args.r === "string" ||
      args.S || typeof args.sprint === "string" ||
      args["my-team"] || args.recent || typeof args.stale === "string" ||
      args.backlog || args["my-created"];

    if (!hasFilters) {
      console.error("Error: Provide a search query or use filters. Run 'tik search --help' for options.");
      process.exit(1);
    }

    await ensureCacheOrFresh(creds, args);
    if (typeof args["contains-any"] === "string") {
      await runContainsAny(args["contains-any"]);
      return;
    }
    await runLocalSearch(args, creds);
  },
});

const main = defineCommand({
  meta: {
    name: "tik",
    description: "Tik CLI tool",
    version: getPackageVersion(),
  },
  args: {
    json: { type: "boolean", description: "Output as JSON" },
    plain: { type: "boolean", description: "Output as plain text" },
    pr: { type: "boolean", description: "Show GitHub PR status for each issue" },
    "refresh-auth": { type: "boolean", description: "Refresh cached credentials from 1Password" },
    "agent-help": { type: "boolean", alias: "ai", description: "Show detailed help for AI agents (use --ai; -ai parses as -a -i)" },
    version: { type: "boolean", alias: "v", description: "Print tik version" },
    F: { type: "boolean", alias: "fresh", description: "Sync before running" },
    grep: { type: "string", description: "Filter issues by summary (regex)" },
  },
  subCommands: {
    version: defineCommand({
      meta: { description: "Print tik version" },
      run: () => {
        subCommandExecuted = true;
        out(getPackageVersion());
      },
    }),
    whoami: defineCommand({
      meta: { description: "Show the current authenticated user" },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const accountId = await requireAccountId(creds.email);
        const user = getUser(accountId);
        const payload = { accountId, displayName: user?.displayName ?? null, email: creds.email };
        if (globalFormat === "json") { out(JSON.stringify(payload, null, 2)); return; }
        if (globalFormat === "plain") { out(`${payload.accountId}\t${payload.displayName ?? ""}\t${payload.email}`); return; }
        out(`${C.bold}${payload.displayName ?? "(unknown)"}${C.reset}  ${C.dim}${payload.email}${C.reset}`);
        out(`${C.dim}accountId:${C.reset} ${payload.accountId}`);
      },
    }),
    mine: defineCommand({
      meta: { description: "List my open tickets" },
      args: {
        e: { type: "boolean", alias: "expand-done", description: "Expand done section" },
        F: { type: "boolean", alias: "fresh", description: "Sync before running" },
        grep: { type: "string", description: "Filter issues by summary (regex)" },
        type: { type: "string", description: "Issue type filter (Bug, Task, Story, Spike) - comma-separated" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await ensureCacheOrFresh(creds, args);

        const accountId = await requireAccountId(creds.email);
        const rawIssues = getLocalMineIssues(accountId, getQaAccountIds());

        if (globalShowPR && globalFormat === "table") {
          const issues = parseIssues({ issues: rawIssues });
          await formatIssues({ issues: rawIssues }, "My Open Tickets", true);
          showLoading("Loading PR status...");
          const prMap = await fetchPRsForTickets(issues.map(i => i.key));
          clearScreen();
          await formatIssues({ issues: rawIssues }, "My Open Tickets", true, prMap);
        } else {
          await formatIssues({ issues: rawIssues }, "My Open Tickets", true);
        }
        await printSyncAge();
      },
    }),
    standup: defineCommand({
      meta: { description: "Show standup summary from recent Jira and Git/PR activity" },
      args: {
        hours: { type: "string", description: "Lookback window in hours (default: 30)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const hours = typeof args.hours === "string" ? Math.max(1, parseInt(args.hours, 10) || 30) : 30;
        await cmdStandup(creds, hours);
      },
    }),
    log: defineCommand({
      meta: { description: "Show recent changes to tickets" },
      args: {
        scope: { type: "positional", required: false, description: "Scope: 'sprint' to limit to sprint tickets" },
        h: { type: "string", description: "Hours to look back (default: 30)" },
        a: { type: "boolean", alias: "all", description: "Show all tickets (not just mine)" },
        F: { type: "boolean", alias: "fresh", description: "Sync before running" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await ensureCacheOrFresh(creds, args);
        await cmdLog(creds, args);
      },
    }),
    flow: defineCommand({
      meta: { description: "Automate feature branch and PR workflow" },
      subCommands: {
        start: defineCommand({
          meta: { description: "Create a ticket if needed, prepare branch from project base, and switch a worktree" },
          args: {
            target: { type: "positional", required: true, description: "Ticket key or new ticket title" },
            w: { type: "string", alias: "worktree", description: "Target worktree name (default: quick)" },
            y: { type: "boolean", alias: "yes", description: "Skip create confirmation when target is a title" },
            f: { type: "boolean", alias: "force", description: "Refresh cached ticket data before preparing" },
            base: { type: "string", description: "Base branch (default: project config or release)" },
            p: { type: "string", alias: "project", description: "Jira project for new tickets (default: defaultProject from config)" },
            "branch-prefix": { type: "string", description: "Branch prefix (default: feature)" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            await cmdFlowStart(creds, {
              target: args.target as string,
              worktree: typeof args.w === "string" ? args.w : undefined,
              yes: !!args.y,
              force: !!args.f,
              base: typeof args.base === "string" ? args.base : undefined,
              project: typeof args.p === "string" ? args.p : undefined,
              "branch-prefix": typeof args["branch-prefix"] === "string" ? args["branch-prefix"] : undefined,
            });
          },
        }),
        pr: defineCommand({
          meta: { description: "Push current branch and create a PR with Jira title/link" },
          args: {
            key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
            open: { type: "boolean", description: "Open the PR in browser after creation" },
            draft: { type: "boolean", description: "Create the PR as draft" },
            f: { type: "boolean", alias: "force", description: "Refresh PR and ticket state from GitHub/Jira" },
            base: { type: "string", description: "Base branch (default: project config or release)" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            const positional = typeof args.key === "string" ? args.key : undefined;
            const key = positional && positional.toLowerCase() !== "open" ? positional : undefined;
            const open = !!args.open || positional?.toLowerCase() === "open";
            await cmdFlowPR(creds, {
              key,
              open,
              draft: !!args.draft,
              force: !!args.f,
              base: typeof args.base === "string" ? args.base : undefined,
            });
          },
        }),
        status: defineCommand({
          meta: { description: "Show workflow status across ticket, branch, worktree, PR, and CI" },
          args: {
            key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
            f: { type: "boolean", alias: "force", description: "Refresh PR and ticket state from GitHub/Jira" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            await cmdFlowStatus(creds, {
              key: typeof args.key === "string" ? args.key : undefined,
              force: !!args.f,
            });
          },
        }),
      },
    }),
    opr: defineCommand({
      meta: { description: "Alias: push branch and open PR in browser (same as `tik flow pr open`)" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        draft: { type: "boolean", description: "Create the PR as draft" },
        f: { type: "boolean", alias: "force", description: "Refresh PR and ticket state from GitHub/Jira" },
        base: { type: "string", description: "Base branch (default: project config or release)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const positional = typeof args.key === "string" ? args.key : undefined;
        const key = positional && positional.toLowerCase() !== "open" ? positional : undefined;
        await cmdFlowPR(creds, {
          key,
          open: true,
          draft: !!args.draft,
          force: !!args.f,
          base: typeof args.base === "string" ? args.base : undefined,
        });
      },
    }),
    prio: defineCommand({
      meta: { description: "Show high priority tickets in sprint" },
      args: {
        e: { type: "boolean", alias: "expand-done", description: "Expand done section" },
        F: { type: "boolean", alias: "fresh", description: "Sync before running" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await ensureCacheOrFresh(creds, args);

        const localData = getLocalSprintData(getMyBoardId());
        if (!localData) {
          console.error("No active sprint found in cache");
          process.exit(1);
        }

        const sprint = parseSprint(localData.sprint);
        const allIssues = parseIssues({ issues: localData.rawIssues });
        const highPrio = allIssues
          .filter(i => ["1", "2"].includes(i.priorityId))
          .filter(i => !StatusCategory.done.statuses.includes(i.status))
          .sort((a, b) => parseInt(a.priorityId) - parseInt(b.priorityId));

        if (globalFormat === "json") {
          out(JSON.stringify(highPrio, null, 2));
          return;
        }

        if (globalFormat === "plain") {
          for (const issue of highPrio) out(issue.key);
          return;
        }

        const accountId = await requireAccountId(creds.email);

        const renderPrioView = async (prMap?: PRMap) => {
          await renderStatic(React.createElement(IssueListView, {
            title: `High Priority in ${sprint.name}`,
            issues: highPrio,
            grouped: false,
            prMap,
            currentUserId: accountId,
            showPR: globalShowPR,
            showStatus: true,
          }));
        };

        if (globalShowPR) {
          await renderPrioView(undefined);
          showLoading("Loading PR status...");
          const prMap = await fetchPRsForTickets(highPrio.map(i => i.key));
          clearScreen();
          await renderPrioView(prMap);
        } else {
          await renderPrioView(undefined);
        }
        await printSyncAge();
      },
    }),
    triage: defineCommand({
      meta: { description: "Interactively triage my tickets (set type, sprint, points, team)" },
      args: {
        a: { type: "boolean", alias: "all", description: "Include all tickets, not just those missing fields" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await cmdTriage(creds, !!args.a);
      },
    }),
    start: defineCommand({
      meta: { description: "Move ticket to In Progress" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const cmdArgs = typeof args.key === "string" ? [args.key] : [];
        await cmdStart(creds, cmdArgs);
      },
    }),
    assign: defineCommand({
      meta: { description: "Assign ticket (defaults to me)" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        assignee: { type: "positional", required: false, description: 'Assignee (accountId, "me", or "none")' },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);
        const assignee = typeof args.assignee === "string" ? args.assignee : "me";
        await cmdEdit(creds, key, { assignee });
      },
    }),
    move: defineCommand({
      meta: { description: "Move ticket to status" },
      args: {
        key: { type: "positional", required: true, description: "Ticket key" },
        status: { type: "positional", required: true, description: "Target status (name or ID)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await cmdTransition(creds, [args.key as string, args.status as string]);
      },
    }),
    review: defineCommand({
      meta: { description: "Move ticket to your review status" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        "gate-ci": { type: "boolean", description: "Require PR to be open, approved, and checks passing before transitioning" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const cmdArgs = typeof args.key === "string" ? [args.key] : [];
        await cmdReview(creds, cmdArgs, { gateCI: !!args["gate-ci"] });
      },
    }),
    pr: defineCommand({
      meta: { description: "Show PR state, review status, CI checks, and merge readiness" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        ci: { type: "boolean", description: "Show detailed CI/CD check run breakdown" },
        reviews: { type: "boolean", description: "Show detailed review status per reviewer" },
        merge: { type: "boolean", description: "Show detailed merge readiness" },
        a: { type: "boolean", alias: "all", description: "Show all details (CI, reviews, merge)" },
        mine: { type: "boolean", description: "List all PRs authored by or assigned to me" },
        repo: { type: "string", description: "Filter by GitHub repo (comma-separated, e.g. 'owner/repo')" },
        project: { type: "string", description: "Filter by Jira project key (comma-separated, e.g. 'PROJ')" },
        org: { type: "string", description: "Filter by GitHub org/owner (e.g. 'my-org')" },
        state: { type: "string", description: "Filter by PR state: open, merged, closed (default: all)" },
        F: { type: "boolean", alias: "fresh", description: "Skip cache and fetch fresh PR data" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);

        const isMine = !!args.mine;
        const isFresh = !!args.F;
        const hasKey = typeof args.key === "string" && args.key.length > 0;
        const hasFilters = !!(args.repo || args.project || args.org || args.state);

        // Shared state filter
        const stateOpt = typeof args.state === "string" ? args.state.toLowerCase() as "OPEN" | "MERGED" | "CLOSED" | "all" : "all";

        // Route to my-PRs list when --mine is set, or when filters are given without a key
        if (isMine || (!hasKey && hasFilters)) {
          await cmdMyPRs({
            repos: typeof args.repo === "string" ? args.repo.split(",").map(r => r.trim()).filter(Boolean) : undefined,
            projects: typeof args.project === "string" ? args.project.split(",").map(p => p.trim().toUpperCase()).filter(Boolean) : undefined,
            org: typeof args.org === "string" ? args.org : undefined,
            state: stateOpt,
            fresh: isFresh,
            showCI: !!args.ci || !!args.a,
            showReviews: !!args.reviews || !!args.a,
            showMerge: !!args.merge || !!args.a,
            showAll: !!args.a,
          });
          return;
        }

        // When no key and no filters, check if we should still show my PRs
        // (auto-detect if not in a git repo)
        if (!hasKey && !hasFilters) {
          const inGit = await ensureInsideGitRepo();
          if (!inGit) {
            // Not in a git repo — show all my PRs
            await cmdMyPRs({
              state: stateOpt,
              fresh: isFresh,
              showCI: !!args.ci || !!args.a,
              showReviews: !!args.reviews || !!args.a,
              showMerge: !!args.merge || !!args.a,
              showAll: !!args.a,
            });
            return;
          }
          // In a git repo — fall through to existing branch-based logic
        }

        const cmdArgs = typeof args.key === "string" ? [args.key] : [];
        await cmdPR(cmdArgs, {
          showCI: !!args.ci || !!args.a,
          showReviews: !!args.reviews || !!args.a,
          showMerge: !!args.merge || !!args.a,
          showAll: !!args.a,
        });
      },
    }),
    view: defineCommand({
      meta: { description: "View ticket details (or from branch if no key)" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key" },
        F: { type: "boolean", alias: "fresh", description: "Sync before running" },
        d: { type: "boolean", alias: "description", description: "Show description" },
        ac: { type: "boolean", description: "Show acceptance criteria" },
        ti: { type: "boolean", description: "Show testing instructions" },
        A: { type: "boolean", alias: "all", description: "Show description, AC, and TI" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);

        const showAll = !!args.A;
        const opts: FormatIssueOpts = {
          showDescription: showAll || !!args.d,
          showAC: showAll || !!args.ac,
          showTI: showAll || !!args.ti,
        };

        const requestedKeys = typeof args.key === "string"
          ? args.key.split(",").map((k) => k.trim()).filter(Boolean)
          : [];

        if (requestedKeys.length > 1) {
          if (globalFormat === "table") {
            emitError("multi_key_table_unsupported", "Table output doesn't support multiple keys; use --json or --plain");
          }

          if (args.F) {
            await runSync(creds);
          }

          const jsonResults: Record<string, unknown>[] = [];
          for (const rawKey of requestedKeys) {
            const key = await resolveTicketKey(rawKey);
            const cached = await getCachedIssue(key);
            if (!cached) {
              emitError("not_cached", `Ticket ${key} not in cache. Run tik sync or use -F.`);
            }
            const links = parseIssueLinks(cached.raw);

            if (globalFormat === "json") {
              const transitionsResp = (await jiraGet(creds, `/rest/api/3/issue/${key}/transitions`)) as {
                transitions?: { id: string; name: string }[];
              };
              const extraJson = { availableTransitions: (transitionsResp.transitions || []).map((t) => t.name) };
              const data = parseIssue(cached.raw);
              jsonResults.push({ ...(cached.raw as Record<string, unknown>), ...buildIssueJsonFields(data), ...extraJson });
            } else {
              await formatIssue(cached.raw, undefined, links, opts);
            }
          }

          if (globalFormat === "json") {
            out(JSON.stringify(jsonResults, null, 2));
          }
          await printSyncAge();
          return;
        }

        const cmdArgs = typeof args.key === "string" ? [args.key] : [];
        const key = await requireTicket(cmdArgs);

        if (args.F) {
          await runSync(creds);
        }

        const cached = await getCachedIssue(key);
        if (!cached) {
          emitError("not_cached", "Ticket not in cache. Run tik sync or use -F.");
        }

        const links = parseIssueLinks(cached.raw);

        let extraJson: Record<string, unknown> | undefined;
        if (globalFormat === "json") {
          const transitionsResp = (await jiraGet(creds, `/rest/api/3/issue/${key}/transitions`)) as {
            transitions?: { id: string; name: string }[];
          };
          extraJson = { availableTransitions: (transitionsResp.transitions || []).map((t) => t.name) };
        }

        if (globalShowPR && globalFormat === "table") {
          await formatIssue(cached.raw, undefined, links, { ...opts, extraJson });
          showLoading("Loading PR status...");
          const prMap = await fetchPRsForTickets([key]);
          clearScreen();
          await formatIssue(cached.raw, prMap.get(key), links, { ...opts, extraJson });
        } else {
          await formatIssue(cached.raw, undefined, links, { ...opts, extraJson });
        }
        await printSyncAge();
      },
    }),
    get: defineCommand({
      meta: { description: "Download a ticket attachment by id, filename, or tikmedia: token" },
      args: {
        arg1: { type: "positional", required: true, description: "Ticket key, or ref(s) if all numeric ids" },
        arg2: { type: "positional", required: false, description: "Ref(s) to download, comma-separated" },
        out: { type: "string", description: "Directory to save into (default: a temp dir; names keep the attachment id prefix)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);

        const arg1 = args.arg1 as string;
        const arg2 = typeof args.arg2 === "string" ? args.arg2 : undefined;
        const key = arg2 !== undefined ? arg1 : undefined;
        const refsStr = arg2 !== undefined ? arg2 : arg1;
        const refs = refsStr.split(",").map((r) => r.trim()).filter(Boolean);

        let attachments: AttachmentData[] | null = null;
        const loadAttachments = async (): Promise<AttachmentData[]> => {
          if (attachments) return attachments;
          if (!key) {
            console.error("Error: Ticket key required to resolve filename/tikmedia refs");
            process.exit(1);
          }
          const resolvedKey = await resolveTicketKey(key);
          const cached = await getCachedIssue(resolvedKey);
          if (!cached) {
            emitError("not_cached", `Ticket ${resolvedKey} not in cache. Run tik sync or use -F.`);
          }
          attachments = parseIssue(cached.raw).attachments;
          return attachments;
        };

        const customDir = typeof args.out === "string" && args.out ? args.out : null;
        const dir = customDir ?? path.join(os.tmpdir(), "tik-attachments");
        await mkdir(dir, { recursive: true });

        const results: { id: string; path: string }[] = [];

        for (const ref of refs) {
          let id: string;
          let knownFilename: string | undefined;

          if (/^\d+$/.test(ref)) {
            id = ref;
          } else {
            let filename: string;
            if (ref.startsWith("tikmedia:")) {
              const node = decodeMediaPlaceholder(ref.slice("tikmedia:".length));
              const media = node?.content?.find((c) => c.type === "media") ??
                (node?.type === "media" || node?.type === "mediaInline" ? node : undefined);
              const alt = media?.attrs?.alt as string | undefined;
              if (!alt) {
                console.error(`Error: Could not decode filename from ${ref}`);
                process.exit(1);
              }
              filename = alt;
            } else {
              filename = ref;
            }

            const list = await loadAttachments();
            const match = list.find((a) => a.filename === filename);
            if (!match) {
              console.error(`Error: No attachment named "${filename}" on ${key}. Available: ${list.map((a) => a.filename).join(", ") || "(none)"}`);
              process.exit(1);
            }
            id = match.id;
            knownFilename = match.filename;
          }

          if (!knownFilename && attachments) {
            knownFilename = (attachments as AttachmentData[]).find((a) => a.id === id)?.filename;
          }
          if (!knownFilename) {
            const meta = (await jiraGet(creds, `/rest/api/3/attachment/${id}`)) as { filename?: string };
            knownFilename = meta.filename || id;
          }

          const res = await fetch(`${Config.jiraBase}/rest/api/3/attachment/content/${id}`, {
            headers: { Authorization: makeAuthHeader(creds) },
          });
          if (!res.ok) {
            console.error(`Error: Failed to download attachment ${id} (HTTP ${res.status})`);
            process.exit(1);
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const filePath = path.join(dir, customDir ? knownFilename : `${id}-${knownFilename}`);
          await Bun.write(filePath, buf);
          results.push({ id, path: filePath });
        }

        if (globalFormat === "json") {
          out(JSON.stringify(results, null, 2));
        } else if (globalFormat === "plain") {
          out(results.map((r) => r.path).join("\n"));
        } else {
          for (const r of results) {
            out(`${C.green}✓${C.reset} ${r.path}`);
          }
        }
      },
    }),
    history: defineCommand({
      meta: { description: "Show full changelog timeline for a ticket" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        F: { type: "boolean", alias: "fresh", description: "Sync before running" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const cmdArgs = typeof args.key === "string" ? [args.key] : [];
        const key = await requireTicket(cmdArgs);

        if (args.F) {
          await runSync(creds);
        }

        const cached = await getCachedIssue(key);
        if (!cached) {
          emitError("not_cached", "Ticket not in cache. Run tik sync or use -F.");
        }

        if (globalFormat === "json") {
          showLoading("Fetching changelog...");
          const changelog = await fetchFullChangelog(creds, key);
          clearLoading();
          out(JSON.stringify({ issue: cached.raw, changelog }, null, 2));
          return;
        }

        if (globalFormat === "plain") {
          showLoading("Fetching changelog...");
          const changelog = await fetchFullChangelog(creds, key);
          clearLoading();
          const history = parseHistory(cached.raw, changelog);
          out(`${history.issue.key}\tCreated\t${history.created.toISOString()}\t${history.creator}`);
          for (const event of history.events) {
            for (const change of event.changes) {
              out(`${history.issue.key}\t${event.date.toISOString()}\t${event.author}\t${change.field}\t${change.from || ""}\t${change.to || ""}`);
            }
          }
          return;
        }

        showLoading("Fetching changelog...");
        const [changelog, commentsResult] = await Promise.all([
          fetchFullChangelog(creds, key),
          jiraGet(creds, `/rest/api/3/issue/${key}/comment`) as Promise<unknown>,
        ]);
        clearLoading();
        const comments = parseComments(commentsResult);
        for (const c of comments) {
          changelog.push({
            created: c.created,
            author: { displayName: c.author },
            items: [{ field: "Comment", fromString: c.body, toString: null }],
          });
        }
        changelog.sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
        const history = parseHistory(cached.raw, changelog);
        const historyLines = await buildHistoryLines(history);
        await renderStatic(React.createElement(HistoryView, { lines: historyLines }));
        await printSyncAge();
      },
    }),
    export: exportCommand,
    search: searchCommand,
    q: searchCommand,
    jql: defineCommand({
      meta: { description: "Run a raw JQL query" },
      args: {
        query: { type: "positional", required: true, description: "Raw JQL query" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await runJqlSearch(creds, args.query as string, args);
      },
    }),
    timeline: defineCommand({
      meta: { description: "Show timeline of tickets with lane visualization" },
      args: {
        query: { type: "positional", required: false, description: "Ticket key or search text" },
        summary: { type: "string", description: "Search summary only" },
        p: { type: "string", description: "Project filter" },
        t: { type: "string", alias: "type", description: "Issue type filter" },
        s: { type: "string", description: "Status filter" },
        a: { type: "string", description: "Assignee filter" },
        l: { type: "string", description: "Labels filter" },
        priority: { type: "string", description: "Priority filter" },
        S: { type: "boolean", alias: "current-sprint", description: "Current sprint" },
        sprint: { type: "string", description: "Sprint ID" },
        epic: { type: "string", description: "Epic key" },
        points: { type: "string", description: "Story points filter" },
        updated: { type: "string", description: "Updated date filter" },
        recent: { type: "boolean", description: "Updated in last 7 days" },
        sort: { type: "string", description: "Sort field" },
        asc: { type: "boolean", description: "Sort ascending" },
        m: { type: "string", description: "Max results (default: 20)" },
        F: { type: "boolean", alias: "fresh", description: "Sync before running" },
        e: { type: "boolean", alias: "expand-done", description: "Show all no-timeline-data tickets" },
        "no-expand": { type: "boolean", description: "Don't expand to related tickets" },
        "no-fuzzy": { type: "boolean", description: "Disable fuzzy matching" },
        "min-score": { type: "string", description: "Min fuzzy match score" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);

        // Check if query is a ticket key or partial key (e.g. PROJ-123 or just 2311)
        let queryIsKey = typeof args.query === "string" && isValidKey(args.query.toUpperCase());

        if (!queryIsKey && typeof args.query === "string") {
          const resolved = await resolveKey(args.query);
          if (resolved.type === "valid" || resolved.type === "resolved") {
            args.query = resolved.key;
            queryIsKey = true;
            if (resolved.type === "resolved") {
              out(`${C.dim}Resolved${C.reset} ${resolved.original} ${C.dim}→${C.reset} ${formatProjectKey(resolved.key)}`);
            }
          } else if (resolved.type === "multiple") {
            if (globalFormat === "table") {
              const selected = await promptSelect(
                `${C.yellow}Multiple matches for '${resolved.original}':${C.reset}`,
                resolved.matches.map(match => ({
                  value: match.key,
                  label: formatProjectKey(match.key),
                  description: truncate(match.summary, 60),
                }))
              );
              if (selected) {
                args.query = selected;
                queryIsKey = true;
              }
            } else {
              args.q = args.query;
            }
          } else {
            args.q = args.query;
          }
        }
        if (args.recent && !args.updated) args.updated = "-7d";

        const hasFilters = queryIsKey || typeof args.q === "string" || typeof args.summary === "string" ||
          typeof args.p === "string" || typeof args.t === "string" ||
          typeof args.s === "string" || typeof args.a === "string" ||
          typeof args.l === "string" || typeof args.priority === "string" ||
          typeof args.epic === "string" || typeof args.points === "string" ||
          typeof args.updated === "string" ||
          args.S || typeof args.sprint === "string" || args.recent;

        if (!hasFilters) {
          console.error("Error: Provide a ticket key, search query, or use filters. Run 'tik timeline --help' for options.");
          process.exit(1);
        }

        await ensureCacheOrFresh(creds, args);

        let seedIssues: IssueData[];
        let seedRaws: Map<string, unknown>;

        if (queryIsKey) {
          // Use specific ticket as starting point
          const key = (args.query as string).toUpperCase();
          const cached = await getCachedIssue(key);
          if (!cached) {
            out(`${C.dim}Ticket not found: ${key}. Run ${C.cyan}tik sync${C.reset}${C.dim} or use ${C.cyan}-F${C.reset}`);
            return;
          }
          seedIssues = [parseIssue(cached.raw)];
          seedRaws = new Map([[key, cached.raw]]);
        } else {
          // Search
          if (globalFormat === "table") showLoading("Searching...");
          const opts = await buildSearchOpts(args, creds, 20);
          const hybridOpts: HybridSearchOpts = { ...opts, noSemantic: !!args["no-semantic"] };
          const cachedIssues = opts.text && !args["no-semantic"]
            ? await searchCacheHybrid(hybridOpts)
            : await searchCache(opts);
          clearLoading();

          if (cachedIssues.length === 0) {
            out(`${C.dim}No tickets found${C.reset}`);
            return;
          }

          seedIssues = cachedIssues.map(c => parseIssue(c.raw));
          seedRaws = new Map(cachedIssues.map(c => [c.key, c.raw]));
        }

        // Expand
        let allIssues: Map<string, IssueData>;
        let allRaws: Map<string, unknown>;

        if (args["no-expand"]) {
          allIssues = new Map(seedIssues.map(i => [i.key, i]));
          allRaws = seedRaws;
        } else {
          if (globalFormat === "table") showLoading("Expanding related tickets...");
          const expanded = expandRelatedTickets(seedIssues, seedRaws);
          allIssues = expanded.issues;
          allRaws = expanded.raws;
          clearLoading();
        }

        // Resolve timeline dates (fetch changelogs only with -F)
        const fresh = !!args.F;
        if (fresh && globalFormat === "table") showLoading(`Fetching changelogs (${allIssues.size} tickets)...`);
        const rawDates = await fetchTimelineDates(creds, [...allIssues.keys()], fresh);
        const dates = extractTimelineDates(rawDates, allIssues);
        if (fresh) clearLoading();

        // Build timeline data
        const tickets = new Map<string, TimelineTicket>();
        for (const [key, issue] of allIssues) {
          const raw = allRaws.get(key);
          const links = raw ? parseIssueLinks(raw) : [];
          tickets.set(key, {
            issue,
            dates: dates.get(key) || { startedAt: null, testingAt: null, completedAt: null, doneAt: null },
            links,
          });
        }

        const edges = buildGraph(allIssues, allRaws);
        const timelineData = buildTimeline(tickets, edges);

        if (globalFormat === "json") {
          out(JSON.stringify({
            events: timelineData.events,
            noDateTickets: timelineData.noDateTickets,
            stats: timelineData.stats,
            dateRange: timelineData.dateRange,
            edges,
          }, null, 2));
          return;
        }

        await renderStatic(React.createElement(TimelineView, { data: timelineData, expandNoDate: !!args.e }));
        await printSyncAge();
      },
    }),
    open: defineCommand({
      meta: { description: "Open ticket in browser (or from branch if no key)" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const cmdArgs = typeof args.key === "string" ? [args.key] : [];
        await cmdOpen(cmdArgs);
      },
    }),
    o: defineCommand({
      meta: { description: "Alias: open ticket in browser (same as `tik open`)" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const cmdArgs = typeof args.key === "string" ? [args.key] : [];
        await cmdOpen(cmdArgs);
      },
    }),
    branch: defineCommand({
      meta: { description: "View ticket from current git branch" },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await cmdBranch(creds);
      },
    }),
    transition: defineCommand({
      meta: { description: "Transition ticket status" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key" },
        status: { type: "positional", required: false, description: "Target status (name or ID)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const cmdArgs: string[] = [];
        if (typeof args.key === "string") cmdArgs.push(args.key);
        if (typeof args.status === "string") cmdArgs.push(args.status);
        await cmdTransition(creds, cmdArgs);
      },
    }),
    comment: defineCommand({
      meta: { description: "Add a comment to a ticket" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        message: { type: "positional", required: false, description: "Comment text" },
        m: { type: "string", description: "Comment from file" },
        attach: { type: "string", description: "Upload and inline-embed an image file in the comment" },
        "attach-width": { type: "string", alias: "W", description: "Display width as % of column (1-100, e.g. 50 for half-width)" },
        rm: { type: "string", description: "Delete comment(s) by id, comma-separated" },
        edit: { type: "string", description: "Edit an existing comment in place by id" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);

        // Delete mode: tik comment KEY --rm <id[,id...]>
        if (typeof args.rm === "string") {
          const ids = args.rm.split(",").map((i) => i.trim()).filter(Boolean);
          for (const id of ids) {
            const res = await jiraDelete(creds, `/rest/api/3/issue/${key}/comment/${id}`);
            if (!res.ok) {
              console.error(`Error deleting comment ${id}: ${res.error}`);
              process.exit(1);
            }
            out(`${C.green}✓${C.reset} Deleted comment ${id} from ${formatProjectKey(key)}`);
          }
          return;
        }

        let body: string;
        if (typeof args.m === "string") {
          body = await readFileArg(args.m);
        } else if (typeof args.message === "string") {
          body = args.message;
        } else if (typeof args.attach === "string") {
          body = "";
        } else {
          console.error("Error: Comment text required (positional or -m file)");
          process.exit(1);
        }

        // Upload attachment if --attach is given
        let attachmentReplacement: string | null = null;
        if (typeof args.attach === "string") {
          const filePath = args.attach;
          const bunFile = Bun.file(filePath);
          if (!(await bunFile.exists())) {
            console.error(`Error: File not found: ${filePath}`);
            process.exit(1);
          }
          const blob = new Blob([await bunFile.arrayBuffer()]);
          const filename = path.basename(filePath);

          showLoading(`Uploading ${filename} to ${key}...`);
          const res = await jiraUpload(creds, `/rest/api/3/issue/${key}/attachments`, filename, blob);
          clearLoading();

          if (!res.ok) {
            console.error(`Error uploading ${filename}: ${res.error}`);
            process.exit(1);
          }

          // Try to get media-service id
          const attData = Array.isArray(res.data) ? (res.data as Record<string, unknown>[])[0] : null;
          const attIdForMedia = attData ? getStr(attData, "id") : "";
          let mediaId = attData ? getStr(attData, "mediaId") : "";
          if (!mediaId && attIdForMedia) {
            // Jira's attachment REST responses don't carry the media-service id;
            // resolve it from the content-URL redirect.
            mediaId = await resolveMediaId(creds, attIdForMedia);
          }

          // Refresh cache so future tik view shows the new attachment
          try {
            const refreshed = await jiraGet(creds, `/rest/api/3/issue/${key}`);
            await cacheSingleIssue(refreshed);
          } catch {}

          if (mediaId) {
            const issueObj = (await jiraGet(creds, `/rest/api/3/issue/${key}?fields=id`)) as { id?: string };
            const issueNumId = issueObj?.id || "";
            const attachWidth = typeof args["attach-width"] === "string" ? parseInt(args["attach-width"], 10) : 0;
            const validatedWidth = !isNaN(attachWidth) && attachWidth >= 1 && attachWidth <= 100 ? attachWidth : undefined;
            const token = makeMediaPlaceholder(mediaId, issueNumId, filename, validatedWidth);
            if (token) {
              attachmentReplacement = token;
            }
          }

          if (!attachmentReplacement) {
            // Fallback: use a link to the attachment
            const attId = attData ? getStr(attData, "id") : "unknown";
            attachmentReplacement = `[${filename}](${Config.jiraBase}/rest/api/3/attachment/content/${attId})`;
            out(`${C.yellow}⚠ No media-service id — embedded as link instead of inline image${C.reset}`);
          }
        }

        // Position the image: replace {attach} placeholder, or append if absent
        let fullBody: string;
        if (attachmentReplacement) {
          // Check for {attach} placeholder (possibly with newlines around it)
          const attachMarker = /^\s*\{attach\}\s*$|\{attach\}/m;
          if (attachMarker.test(body)) {
            fullBody = body.replace(attachMarker, attachmentReplacement);
          } else {
            // No placeholder — append at the end
            fullBody = body ? `${body}\n\n${attachmentReplacement}` : attachmentReplacement;
          }
        } else {
          fullBody = body;
        }

        const adf = markdownToAdf(fullBody);
        if (typeof args.edit === "string") {
          showLoading(`Updating comment ${args.edit} on ${key}...`);
          const res = await jiraPut(creds, `/rest/api/3/issue/${key}/comment/${args.edit}`, { body: adf });
          clearLoading();
          if (!res.ok) {
            console.error(`Error updating comment ${args.edit}: ${res.error}`);
            process.exit(1);
          }
          out(`${C.green}✓${C.reset} Updated comment ${args.edit} on ${formatProjectKey(key)}`);
        } else {
          showLoading(`Adding comment to ${key}...`);
          await jiraPost(creds, `/rest/api/3/issue/${key}/comment`, { body: adf });
          clearLoading();
          out(`${C.green}✓${C.reset} Added comment to ${formatProjectKey(key)}`);
        }
      },
    }),
    comments: defineCommand({
      meta: { description: "View comments on a ticket" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        n: { type: "string", description: "Number of comments to show (default: all)" },
        full: { type: "boolean", alias: "f", description: "Show full comment bodies (no line cap)" },
        md: { type: "boolean", description: "Print raw markdown bodies (pipe/file friendly)" },
        author: { type: "string", description: "Only comments whose author matches this text" },
        "no-bots": { type: "boolean", description: "Hide automated comments (CI, automation)" },
        bots: { type: "boolean", description: "Only automated comments" },
        raw: { type: "boolean", description: "With --json, emit the unparsed Jira response" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);

        showLoading(`Loading comments for ${key}...`);

        const result = await jiraGet(creds, `/rest/api/3/issue/${key}/comment`);
        let comments = parseComments(result);

        clearLoading();

        const botAuthors = localConfig.botAuthors ?? DEFAULT_BOT_AUTHORS;
        if (isDisabled(args, "bots")) comments = comments.filter((c) => !isBotAuthor(c.author, botAuthors));
        else if (args.bots === true) comments = comments.filter((c) => isBotAuthor(c.author, botAuthors));
        if (typeof args.author === "string" && args.author) {
          const needle = args.author.toLowerCase();
          comments = comments.filter((c) => c.author.toLowerCase().includes(needle));
        }

        if (typeof args.n === "string") {
          const limit = parseInt(args.n, 10);
          if (!isNaN(limit) && limit > 0) {
            comments = comments.slice(-limit);
          }
        }

        if (globalFormat === "json") {
          out(JSON.stringify(args.raw ? result : { key, total: comments.length, comments }, null, 2));
          return;
        }

        if (args.md) {
          out(`# Comments on ${key} (${comments.length})\n`);
          for (const c of comments) {
            out(`## ${c.author} — ${c.created}\n`);
            out(`${demoteHeadings(c.body.trim(), 3) || "_(empty)_"}\n`);
          }
          return;
        }

        if (globalFormat === "plain") {
          for (const c of comments) {
            out(`${c.author}\t${c.created}\t${c.body.split("\n")[0]}`);
          }
          return;
        }

        const renderedComments = await Promise.all(
          comments.map(async (c) => ({
            ...c,
            renderedBody: await renderMarkdown(c.body),
          }))
        );
        await renderStatic(
          React.createElement(CommentsView, { ticketKey: key, comments: renderedComments, full: !!args.full })
        );
      },
    }),
    link: defineCommand({
      meta: { description: "Link two tickets" },
      args: {
        key: { type: "positional", required: true, description: "Source ticket key" },
        blocks: { type: "string", description: "Target ticket that this blocks" },
        "is-blocked-by": { type: "string", description: "Target ticket that blocks this" },
        "relates-to": { type: "string", description: "Target ticket that relates to this" },
        duplicates: { type: "string", description: "Target ticket that this duplicates" },
        "is-duplicated-by": { type: "string", description: "Target ticket that duplicates this" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);

        const key = await resolveTicketKey(args.key as string);
        let linkType: string | null = null;
        let targetKeyInput: string | null = null;
        let inward = false;

        if (typeof args.blocks === "string") {
          linkType = "Blocks";
          targetKeyInput = args.blocks;
          inward = false;
        } else if (typeof args["is-blocked-by"] === "string") {
          linkType = "Blocks";
          targetKeyInput = args["is-blocked-by"];
          inward = true;
        } else if (typeof args["relates-to"] === "string") {
          linkType = "Relates";
          targetKeyInput = args["relates-to"];
          inward = false;
        } else if (typeof args.duplicates === "string") {
          linkType = "Duplicate";
          targetKeyInput = args.duplicates;
          inward = false;
        } else if (typeof args["is-duplicated-by"] === "string") {
          linkType = "Duplicate";
          targetKeyInput = args["is-duplicated-by"];
          inward = true;
        }

        if (!linkType || !targetKeyInput) {
          console.error("Error: Specify a link type (--blocks, --is-blocked-by, --relates-to, --duplicates, --is-duplicated-by)");
          process.exit(1);
        }

        const targetKey = await resolveTicketKey(targetKeyInput);

        showLoading(`Linking ${key} → ${targetKey}...`);

        // Jira treats the outwardIssue as the one performing the outward verb
        // (e.g. "blocks"); the inwardIssue receives it (e.g. "is blocked by").
        // So for `--is-blocked-by TARGET` (inward=true) the source KEY must be
        // the outwardIssue's counterpart — i.e. KEY goes in outwardIssue and
        // TARGET in inwardIssue. (Previously reversed, which inverted the link.)
        const payload = {
          type: { name: linkType },
          inwardIssue: { key: inward ? targetKey : key },
          outwardIssue: { key: inward ? key : targetKey },
        };

        await jiraPost(creds, "/rest/api/3/issueLink", payload);

        clearLoading();
        out(`${C.green}✓${C.reset} Linked ${formatProjectKey(key)} ${C.dim}${inward ? "is blocked by" : linkType.toLowerCase()}${C.reset} ${formatProjectKey(targetKey)}`);
      },
    }),
    links: defineCommand({
      meta: { description: "View links on a ticket" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);

        if (globalFormat === "table") showLoading(`Loading links for ${key}...`);

        const issue = await jiraGet(creds, `/rest/api/3/issue/${key}?fields=issuelinks`);
        const links = parseIssueLinks(issue);

        clearLoading();

        if (globalFormat === "json") {
          out(JSON.stringify(links, null, 2));
          return;
        }

        if (globalFormat === "plain") {
          for (const link of links) {
            out(`${link.type}\t${link.linkedIssue.key}\t${link.linkedIssue.summary}`);
          }
          return;
        }

        await renderStatic(React.createElement(LinksView, { ticketKey: key, links }));
      },
    }),
    unlink: defineCommand({
      meta: { description: "Remove a link between two tickets" },
      args: {
        key: { type: "positional", required: true, description: "Source ticket key" },
        target: { type: "positional", required: false, description: "Linked ticket key to unlink (removes every link to it)" },
        id: { type: "string", description: "Specific issue-link ID to delete instead of a target key" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);

        if (typeof args.id === "string") {
          showLoading(`Removing link ${args.id}...`);
          const res = await jiraDelete(creds, `/rest/api/3/issueLink/${args.id}`);
          clearLoading();
          if (!res.ok) {
            console.error(`Error: ${res.error}`);
            process.exit(1);
          }
          out(`${C.green}✓${C.reset} Removed link ${args.id}`);
          return;
        }

        const key = await resolveTicketKey(args.key as string);
        if (typeof args.target !== "string") {
          console.error("Error: specify a target ticket key or --id");
          process.exit(1);
        }
        const targetKey = await resolveTicketKey(args.target);

        showLoading(`Finding links ${key} ↔ ${targetKey}...`);
        const issue = await jiraGet(creds, `/rest/api/3/issue/${key}?fields=issuelinks`);
        const matches = parseIssueLinks(issue).filter((l) => l.linkedIssue.key === targetKey);
        clearLoading();

        if (matches.length === 0) {
          console.error(`Error: no link found between ${key} and ${targetKey}`);
          process.exit(1);
        }

        for (const link of matches) {
          const res = await jiraDelete(creds, `/rest/api/3/issueLink/${link.id}`);
          if (!res.ok) {
            console.error(`Error removing link ${link.id}: ${res.error}`);
            process.exit(1);
          }
          out(`${C.green}✓${C.reset} Removed ${C.dim}${link.type}${C.reset} ${formatProjectKey(key)} ↔ ${formatProjectKey(targetKey)}`);
        }
      },
    }),
    attach: defineCommand({
      meta: { description: "Add or remove ticket attachments" },
      subCommands: {
        add: defineCommand({
          meta: { description: "Upload a file as an attachment" },
          args: {
            key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
            file: { type: "positional", required: true, description: "Path to file to upload" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);
            const filePath = args.file as string;

            const bunFile = Bun.file(filePath);
            if (!(await bunFile.exists())) {
              console.error(`Error: File not found: ${filePath}`);
              process.exit(1);
            }
            const blob = new Blob([await bunFile.arrayBuffer()]);
            const filename = path.basename(filePath);

            showLoading(`Uploading ${filename} to ${key}...`);
            const res = await jiraUpload(creds, `/rest/api/3/issue/${key}/attachments`, filename, blob);
            clearLoading();

            if (!res.ok) {
              console.error(`Error: ${res.error}`);
              process.exit(1);
            }

            // Extract attachment info from response
            const attData = Array.isArray(res.data) ? (res.data as Record<string, unknown>[])[0] : null;
            const attId = attData ? getStr(attData, "id") : "";
            let mediaId = attData ? getStr(attData, "mediaId") : "";
            if (!mediaId && attId) mediaId = await resolveMediaId(creds, attId);

            // Re-fetch the issue to update local cache with fresh attachment list
            showLoading(`Refreshing cache for ${key}...`);
            try {
              const refreshed = await jiraGet(creds, `/rest/api/3/issue/${key}`);
              await cacheSingleIssue(refreshed);
            } catch {}
            clearLoading();

            if (globalFormat === "json") {
              out(JSON.stringify({ key, attachmentId: attId, filename, mediaId: mediaId || null }, null, 2));
              return;
            }
            if (globalFormat === "plain") {
              out(`${key}\t${attId}\t${filename}\t${mediaId || "(no media id)"}`);
              return;
            }

            out(`${C.green}✓${C.reset} Uploaded ${filename} to ${formatProjectKey(key)}`);
            out(`  ${C.dim}Attachment id:${C.reset} ${attId}`);
            if (mediaId) {
              // Build a tikmedia token the user can copy-paste into comments / descriptions
              const issueObj = (await jiraGet(creds, `/rest/api/3/issue/${key}?fields=id`)) as { id?: string } | null;
              const issueNumId = issueObj?.id || "";
              const token = makeMediaPlaceholder(mediaId, issueNumId, filename);
              if (token) {
                out(`  ${C.dim}Media id:${C.reset} ${C.dim}${mediaId}${C.reset}`);
                out(`  ${C.dim}Embed token (paste into comment/description):${C.reset}`);
                out(`  ${C.cyan}${token}${C.reset}`);
              }
            } else {
              out(`  ${C.yellow}No media-service id available.${C.reset} Use ${C.cyan}tik attach embed ${key} ${attId}${C.reset} to retry, or embed via attachment link: ${C.dim}${Config.jiraBase}/rest/api/3/attachment/content/${attId}${C.reset}`);
            }
          },
        }),
        rm: defineCommand({
          meta: { description: "Remove attachment(s) by id" },
          args: {
            key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
            id: { type: "positional", required: true, description: "Attachment id(s), comma-separated" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);
            const ids = (args.id as string).split(",").map((i) => i.trim()).filter(Boolean);

            for (const id of ids) {
              const res = await jiraDelete(creds, `/rest/api/3/attachment/${id}`);
              if (!res.ok) {
                console.error(`Error removing attachment ${id}: ${res.error}`);
                process.exit(1);
              }
              out(`${C.green}✓${C.reset} Removed attachment ${id} from ${formatProjectKey(key)}`);
            }
          },
        }),
        embed: defineCommand({
          meta: { description: "Generate a tikmedia embed token for an attachment to paste into comments/descriptions" },
          args: {
            key: { type: "positional", required: true, description: "Ticket key" },
            ref: { type: "positional", required: true, description: "Attachment id, filename, or tikmedia: token" },
            W: { type: "string", description: "Display width as % of column (1-100, e.g. 40)" },
            width: { type: "string", description: "Alias for -W" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            const key = await resolveTicketKey(args.key as string);
            const ref = (args.ref as string).trim();

            // Resolve the ref to an attachment
            let attachmentId: string;
            let filename: string;

            // First, try to get from cache
            let cached = await getCachedIssue(key);

            // Helper: find attachment in local data
            function findInCache(raw: unknown): { attId: string; fname: string; mediaId?: string } | null {
              const data = parseIssue(raw);
              const atts = data.attachments;
              if (/^\d+$/.test(ref)) {
                const match = atts.find(a => a.id === ref);
                if (match) return { attId: match.id, fname: match.filename, mediaId: match.mediaId };
              } else {
                const match = atts.find(a => a.filename === ref);
                if (match) return { attId: match.id, fname: match.filename, mediaId: match.mediaId };
              }
              return null;
            }

            let info = cached ? findInCache(cached.raw) : null;

            // If not in cache, re-fetch the issue
            if (!info) {
              showLoading(`Fetching ${key}...`);
              const fresh = await jiraGet(creds, `/rest/api/3/issue/${key}`);
              await cacheSingleIssue(fresh);
              cached = await getCachedIssue(key);
              if (cached) info = findInCache(cached.raw);
              clearLoading();
            }

            if (!info) {
              console.error(`${C.red}✗${C.reset} Could not find attachment matching "${ref}" on ${key}`);
              if (cached) {
                const data = parseIssue(cached.raw);
                const names = data.attachments.map(a => `${a.id} (${a.filename})`);
                if (names.length > 0) {
                  console.error(`  ${C.dim}Available:${C.reset} ${names.join(", ")}`);
                }
              }
              process.exit(1);
            }

            attachmentId = info.attId;
            filename = info.fname;

            // If we don't have mediaId from cache, resolve it from the
            // attachment content-URL redirect (Jira's REST responses omit it).
            let mediaId = info.mediaId;
            if (!mediaId) {
              mediaId = (await resolveMediaId(creds, attachmentId)) || undefined;
            }

            // Get the issue numeric id for the collection
            const issueObj = cached
              ? (getObj(cached.raw, "id") as string) || ""
              : ((await jiraGet(creds, `/rest/api/3/issue/${key}?fields=id`)) as { id?: string })?.id || "";
            const issueNumId = typeof issueObj === "string" ? issueObj : "";

            const widthRaw = typeof args.W === "string" ? args.W : typeof args.width === "string" ? args.width : "";
            const widthNum = widthRaw ? parseInt(widthRaw, 10) : 0;
            const embedWidth = !isNaN(widthNum) && widthNum >= 1 && widthNum <= 100 ? widthNum : undefined;

            if (globalFormat === "json") {
              out(JSON.stringify({
                key,
                attachmentId,
                filename,
                mediaId: mediaId || null,
                embedToken: mediaId && issueNumId
                  ? makeMediaPlaceholder(mediaId, issueNumId, filename, embedWidth)
                  : null,
              }, null, 2));
              return;
            }

            if (globalFormat === "plain") {
              if (mediaId && issueNumId) {
                const token = makeMediaPlaceholder(mediaId, issueNumId, filename, embedWidth);
                out(token || "(error generating token)");
              } else {
                out(`(no embed token available)`);
              }
              return;
            }

            if (mediaId && issueNumId) {
              const token = makeMediaPlaceholder(mediaId, issueNumId, filename, embedWidth);
              if (token) {
                out(`\n${C.green}✓${C.reset} Embed token for ${C.bold}${filename}${C.reset} on ${formatProjectKey(key)}:`);
                out(`\n  ${C.cyan}${token}${C.reset}\n`);
                out(`${C.dim}Paste the line above into a comment or description to embed this image inline.${C.reset}`);
                out(`${C.dim}Tip: Use${C.reset} ${C.cyan}tik comment ${key} -m ./comment.md${C.reset} ${C.dim}with the token in the file.${C.reset}`);
              } else {
                out(`${C.yellow}⚠ Could not generate embed token.${C.reset}`);
              }
            } else {
              out(`\n${C.yellow}No media-service id available for attachment ${attachmentId} (${filename})${C.reset}`);
              out(`  ${C.dim}You can still reference it by URL:${C.reset}`);
              out(`  ${C.dim}${Config.jiraBase}/rest/api/3/attachment/content/${attachmentId}${C.reset}`);
              out(`  ${C.dim}Or check after a Jira sync:${C.reset} ${C.cyan}tik sync -f${C.reset}`);
            }
          },
        }),
      },
    }),
    edit: defineCommand({
      meta: { description: "Edit ticket fields" },
      args: {
        key: { type: "positional", required: false, description: "Ticket key (or from branch)" },
        s: { type: "string", alias: "summary", description: "New summary/title (or path to file)" },
        d: { type: "string", alias: "desc", description: "New description with markdown (or path to .md file)" },
        a: { type: "string", alias: "assignee", description: 'Assignee (accountId, "me", or "none")' },
        p: { type: "string", alias: "priority", description: "Priority (1-5 or name)" },
        e: { type: "boolean", alias: "team", description: "Assign to your team (myTeamId)" },
        S: { type: "boolean", description: "Add to current sprint" },
        sprint: { type: "string", description: 'Sprint ID, or "none" to remove' },
        points: { type: "string", description: "Story points" },
        ac: { type: "string", description: "Acceptance criteria with markdown (or path to .md file)" },
        ti: { type: "string", description: "Testing instructions with markdown (or path to .md file)" },
        labels: { type: "string", description: "Set labels (comma-separated)" },
        "add-label": { type: "string", description: "Add a label" },
        "remove-label": { type: "string", description: "Remove a label" },
        parent: { type: "string", description: 'Parent ticket key, or "none" to remove' },
        status: { type: "string", description: "Transition to status (name or ID)" },
        "dry-run": { type: "boolean", description: "Print the computed changes without applying them" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const key = await requireTicket(typeof args.key === "string" ? [args.key] : []);
        let sprintValue: boolean | string | undefined;
        if (args.S) sprintValue = true;
        else if (typeof args.sprint === "string") sprintValue = args.sprint;
        await cmdEdit(creds, key, {
          summary: typeof args.s === "string" ? args.s : undefined,
          description: typeof args.d === "string" ? args.d : undefined,
          assignee: typeof args.a === "string" ? args.a : undefined,
          parent: typeof args.parent === "string" ? args.parent : undefined,
          priority: typeof args.p === "string" ? args.p : undefined,
          team: !!args.e,
          sprint: sprintValue,
          points: typeof args.points === "string" ? args.points : undefined,
          acceptanceCriteria: typeof args.ac === "string" ? args.ac : undefined,
          testingInstructions: typeof args.ti === "string" ? args.ti : undefined,
          labels: typeof args.labels === "string" ? args.labels : undefined,
          addLabel: typeof args["add-label"] === "string" ? args["add-label"] : undefined,
          removeLabel: typeof args["remove-label"] === "string" ? args["remove-label"] : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          dryRun: !!args["dry-run"],
        });
      },
    }),
    create: defineCommand({
      meta: { description: "Create a new ticket" },
      args: {
        summary: { type: "positional", required: false, description: "Summary/title (or path to file)" },
        s: { type: "string", description: "Summary/title (or path to file)" },
        p: { type: "string", description: "Project key (default: defaultProject from config)" },
        d: { type: "string", description: "Description with markdown (or path to .md file)" },
        t: { type: "string", description: "Issue type (default: Task)" },
        a: { type: "boolean", description: "Assign to me" },
        i: { type: "boolean", description: "Move to In Progress" },
        e: { type: "boolean", description: "Add your team (myTeamId)" },
        S: { type: "boolean", description: "Add to current sprint" },
        sprint: { type: "string", description: "Add to specific sprint by ID" },
        priority: { type: "string", description: "Priority (1-5 or Highest/High/Medium/Low/Lowest)" },
        points: { type: "string", description: "Story points" },
        ac: { type: "string", description: "Acceptance criteria with markdown (or path to .md file)" },
        ti: { type: "string", description: "Testing instructions with markdown (or path to .md file)" },
        "dry-run": { type: "boolean", description: "Print the computed fields without creating the ticket" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);

        const summaryArg = typeof args.s === "string" ? args.s : (typeof args.summary === "string" ? args.summary : "");
        if (!summaryArg) {
          console.error("Error: Summary is required (-s or positional argument)");
          process.exit(1);
        }
        const summaryText = await readFileArg(summaryArg);
        const summary = summaryText.trim().split("\n")[0];

        const project = typeof args.p === "string" ? args.p : Config.defaultProject;
        const issueType = typeof args.t === "string" ? args.t : "Task";

        if (globalFormat === "table") showLoading("Creating ticket...");

        const myself = (await jiraGet(creds, "/rest/api/3/myself")) as { accountId?: string };
        const accountId = myself.accountId || "";

        const fields: Record<string, unknown> = {
          project: { key: project },
          summary,
          issuetype: { name: issueType },
        };

        if (typeof args.d === "string") {
          const description = await readFileArg(args.d);
          fields.description = markdownToAdf(description);
        }

        if (args.a && accountId) {
          fields.assignee = { accountId };
        }

        if (args.e) {
          fields[requireCustomField("team")] = Config.myTeamId;
        }

        if (typeof args.priority === "string") {
          const priorityId = PriorityMap[args.priority.toLowerCase()];
          if (priorityId) {
            fields.priority = { id: priorityId };
          }
        }

        if (typeof args.points === "string") {
          const pts = parseFloat(args.points);
          if (!isNaN(pts)) {
            fields[requireCustomField("storyPoints")] = pts;
          }
        }

        if (typeof args.ac === "string") {
          const ac = await readFileArg(args.ac);
          fields[requireCustomField("acceptanceCriteria")] = markdownToAdf(ac);
        }

        if (typeof args.ti === "string") {
          const ti = await readFileArg(args.ti);
          fields[requireCustomField("testingInstructions")] = markdownToAdf(ti);
        }

        if (typeof args.sprint === "string") {
          const sprintId = parseInt(args.sprint, 10);
          if (!isNaN(sprintId)) {
            fields[requireCustomField("sprint")] = sprintId;
          }
        } else if (args.S) {
          const sprintResp = (await jiraGet(
            creds,
            `/rest/agile/1.0/board/${Config.myBoardId}/sprint?state=active`
          )) as { values?: { id: number }[] };
          const activeSprint = sprintResp.values?.[0];
          if (activeSprint) {
            fields[requireCustomField("sprint")] = activeSprint.id;
          }
        }

        if (args["dry-run"]) {
          if (globalFormat === "table") clearLoading();
          const payload = { dryRun: true, action: "create", fields };
          if (globalFormat === "json") {
            out(JSON.stringify(payload, null, 2));
            return;
          }
          out(`${C.yellow}Dry run — would create:${C.reset}`);
          out(JSON.stringify(fields, null, 2));
          return;
        }

        const result = (await jiraPost(creds, "/rest/api/3/issue", { fields })) as {
          key?: string;
          errors?: unknown;
        };

        const newKey = result.key;
        if (!newKey) {
          clearLoading();
          console.error(`${C.red}✗${C.reset} Error creating issue: ${JSON.stringify(result.errors || result)}`);
          process.exit(1);
        }

        if (args.i) {
          await jiraPost(creds, `/rest/api/3/issue/${newKey}/transitions`, {
            transition: { id: Config.inProgressTransitionId },
          });
        }

        const createdIssue = await jiraGet(creds, `/rest/api/3/issue/${newKey}`);
        await cacheSingleIssue(createdIssue);

        clearLoading();

        out();
        out(`${C.green}✓${C.reset} Created ${formatProjectKey(newKey)}  ${C.dim}${truncate(summary, 50)}${C.reset}`);

        if (args.i) {
          out(`  ${C.dim}→${C.reset} ${C.yellow}In Progress${C.reset}`);
        }

        out(`  ${C.dim}${Config.jiraBase}/browse/${newKey}${C.reset}`);
        out();
      },
    }),
    sprint: defineCommand({
      meta: { description: "Show current sprint with issues" },
      args: {
        i: { type: "boolean", alias: "info", description: "Show sprint info only (no issues)" },
        g: { type: "boolean", alias: "goals", description: "Show sprint goals" },
        a: { type: "boolean", alias: "all", description: "Show all team issues (not just mine)" },
        e: { type: "boolean", alias: "expand-done", description: "Expand done section" },
        F: { type: "boolean", alias: "fresh", description: "Sync before running" },
        grep: { type: "string", description: "Filter issues by summary (regex)" },
        type: { type: "string", description: "Issue type filter (Bug, Task, Story, Spike) - comma-separated" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        await ensureCacheOrFresh(creds, args);

        const localData = getLocalSprintData(getMyBoardId());
        if (!localData) {
          console.error("No active sprint found in cache");
          process.exit(1);
        }

        const sprint = parseSprint(localData.sprint);
        const issues = parseIssues({ issues: localData.rawIssues });

        if (args.g) { await formatSprintGoals(sprint); await printSyncAge(); return; }
        if (args.i) { await formatSprint(localData.sprint); await printSyncAge(); return; }

        if (globalFormat === "json") {
          out(JSON.stringify({ sprint, issues: { issues: localData.rawIssues } }, null, 2));
          return;
        }
        if (globalFormat === "plain") {
          for (const issue of issues) out(issue.key);
          return;
        }

        const accountId = await requireAccountId(creds.email);
        const mineOnly = !args.a;
        const sprintKeys = issues.map(i => i.key);
        const wasMine = mineOnly ? getWasMineKeys(accountId, sprintKeys) : new Set<string>();

        if (globalShowPR) {
          await formatSprintView(sprint, issues, {
            expandDone: !!args.e,
            mineOnly,
            currentUserId: accountId,
            prMap: undefined,
            wasMineKeys: wasMine,
          });

          showLoading("Loading PR status...");
          const prMap = await fetchPRsForTickets(sprintKeys);

          clearScreen();
          await formatSprintView(sprint, issues, {
            expandDone: !!args.e,
            mineOnly,
            currentUserId: accountId,
            prMap,
            wasMineKeys: wasMine,
          });
        } else {
          await formatSprintView(sprint, issues, {
            expandDone: !!args.e,
            mineOnly,
            currentUserId: accountId,
            prMap: undefined,
            wasMineKeys: wasMine,
          });
        }
        await printSyncAge();
      },
    }),
    sprints: defineCommand({
      meta: { description: "List sprints for the team board" },
      args: {
        state: { type: "string", description: "Sprint state filter (default: active,future)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);
        const creds = await getCredentials(args);
        const state = typeof args.state === "string" ? args.state : "active,future";
        const boardId = getMyBoardId();
        const resp = (await jiraGet(creds, `/rest/agile/1.0/board/${boardId}/sprint?state=${state}`)) as { values?: unknown[] };
        const sprints = (resp.values || []).map(parseSprint);

        if (globalFormat === "json") {
          out(JSON.stringify(sprints, null, 2));
          return;
        }
        if (globalFormat === "plain") {
          for (const s of sprints) out(`${s.id}\t${s.name}\t${s.state}\t${s.startDate}\t${s.endDate}`);
          return;
        }

        for (const s of sprints) {
          out(`${C.bold}${s.name}${C.reset} ${C.dim}[${s.id}] ${s.state}${C.reset}`);
          if (s.startDate || s.endDate) out(`  ${C.dim}${s.startDate || "?"} → ${s.endDate || "?"}${C.reset}`);
        }
      },
    }),
    users: defineCommand({
      meta: { description: "List and manage users" },
      args: {
        role: { type: "string", description: "Filter by role (Dev, QA, PM)" },
        team: { type: "string", description: `Filter by team${TeamNamesHint ? ` (${TeamNamesHint})` : ""}` },
        active: { type: "boolean", description: "Show only active users" },
        edit: { type: "positional", required: false, description: "User name or account ID to edit" },
        "set-role": { type: "string", description: "Set role (Dev, QA, PM, or none to clear)" },
        "set-team": { type: "string", description: `Set team${TeamNamesHint ? ` (${TeamNamesHint}, or none to clear)` : " (or none to clear)"}` },
        "set-notes": { type: "string", description: "Set notes" },
        main: { type: "boolean", description: "Set as main account" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        applyFormat(args);

        // Edit mode
        if (typeof args.edit === "string") {
          const matches = findUserByNameOrId(args.edit);
          if (matches.length === 0) {
            console.error(`${C.red}No user found matching '${args.edit}'${C.reset}`);
            process.exit(1);
          }

          let target: UserRecord;
          if (matches.length === 1) {
            target = matches[0];
          } else if (globalFormat === "table") {
            const selected = await promptSelect(
              `${C.yellow}Multiple matches for '${args.edit}':${C.reset}`,
              matches.map(u => ({
                value: u.accountId,
                label: u.displayName,
                description: u.email || u.accountId.slice(0, 20),
              }))
            );
            if (!selected) { console.error(`${C.red}No selection made${C.reset}`); process.exit(1); }
            target = matches.find(u => u.accountId === selected)!;
          } else {
            console.error(`Multiple users match '${args.edit}':`);
            for (const u of matches) out(`  ${u.displayName} (${u.accountId})`);
            process.exit(1);
          }

          const fields: Partial<Pick<UserRecord, "role" | "team" | "notes" | "isMainAccount">> = {};
          let hasChanges = false;

          if (typeof args["set-role"] === "string") {
            fields.role = args["set-role"].toLowerCase() === "none" ? null : args["set-role"];
            hasChanges = true;
          }
          if (typeof args["set-team"] === "string") {
            fields.team = args["set-team"].toLowerCase() === "none" ? null : args["set-team"];
            hasChanges = true;
          }
          if (typeof args["set-notes"] === "string") {
            fields.notes = args["set-notes"].toLowerCase() === "none" ? null : args["set-notes"];
            hasChanges = true;
          }
          if (args.main) {
            fields.isMainAccount = true;
            hasChanges = true;
          }

          if (!hasChanges) {
            console.error("No changes specified. Use --set-role, --set-team, --set-notes, or --main");
            process.exit(1);
          }

          updateUserFields(target.accountId, fields);
          out(`${C.green}✓${C.reset} Updated ${C.bold}${target.displayName}${C.reset}`);
          if ("role" in fields) out(`  role: ${fields.role || C.dim + "none" + C.reset}`);
          if ("team" in fields) out(`  team: ${fields.team || C.dim + "none" + C.reset}`);
          if ("notes" in fields) out(`  notes: ${fields.notes || C.dim + "none" + C.reset}`);
          if (fields.isMainAccount) out(`  ${C.cyan}★ main account${C.reset}`);
          return;
        }

        // List mode
        let users = getAllUsers();
        if (typeof args.role === "string") users = users.filter(u => u.role?.toLowerCase() === args.role!.toString().toLowerCase());
        if (typeof args.team === "string") users = users.filter(u => u.team?.toLowerCase() === args.team!.toString().toLowerCase());
        if (args.active) users = users.filter(u => u.active);

        if (globalFormat === "json") {
          out(JSON.stringify(users, null, 2));
          return;
        }

        if (globalFormat === "plain") {
          for (const u of users) {
            out(`${u.accountId}\t${u.displayName}\t${u.email || ""}\t${u.role || ""}\t${u.team || ""}\t${u.isMainAccount ? "main" : ""}`);
          }
          return;
        }

        if (users.length === 0) {
          out(`${C.dim}No users found. Run ${C.cyan}tik sync${C.reset}${C.dim} or ${C.cyan}tik sync --users${C.reset}${C.dim} first.${C.reset}`);
          return;
        }

        // Table format
        const nameW = 24;
        const emailW = 30;
        const roleW = 6;
        const teamW = 8;
        const notesW = 20;

        out(`${C.bold}${C.underline}${"Name".padEnd(nameW)}  ${"Email".padEnd(emailW)}  ${"Role".padEnd(roleW)}  ${"Team".padEnd(teamW)}  ${"Notes".padEnd(notesW)}${C.reset}`);
        for (const u of users) {
          const mainMark = u.isMainAccount ? `${C.cyan}★${C.reset}` : " ";
          const name = truncate(u.displayName, nameW);
          const email = truncate(u.email || "", emailW);
          const role = (u.role || "").padEnd(roleW);
          const team = (u.team || "").padEnd(teamW);
          const notes = truncate(u.notes || "", notesW);
          const activeColor = u.active ? "" : C.dim;
          const resetColor = u.active ? "" : C.reset;
          out(`${mainMark}${activeColor}${name.padEnd(nameW)}  ${email.padEnd(emailW)}  ${role}  ${team}  ${notes}${resetColor}`);
        }
        out(`${C.dim}${users.length} users${C.reset}`);
      },
    }),
    sync: defineCommand({
      meta: { description: "Sync tickets from Jira to local cache" },
      args: {
        f: { type: "boolean", alias: "full", description: "Force full sync (ignore last sync time)" },
        a: { type: "boolean", alias: "all", description: "Include done/closed tickets" },
        p: { type: "string", description: "Project filter - comma-separated" },
        stats: { type: "boolean", description: "Show cache stats only" },
        users: { type: "boolean", description: "Sync users only (fetch all Jira users)" },
        backfill: { type: "boolean", description: "Backfill assignee changelog for recent tickets missing it (last 4 months)" },
        c: { type: "boolean", alias: "changelog", description: "Refresh changelogs only (skip ticket fetch)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;
        const creds = await getCredentials(args);

        if (args.users) {
          showLoading("Fetching Jira users...");
          const allJiraUsers: Array<{ accountId: string; displayName: string; email?: string | null; active?: boolean }> = [];
          let startAt = 0;
          const maxResults = 200;
          while (true) {
            const batch = await jiraGet(creds, `/rest/api/3/users/search?startAt=${startAt}&maxResults=${maxResults}`) as Array<{
              accountId?: string;
              displayName?: string;
              emailAddress?: string;
              active?: boolean;
              accountType?: string;
            }>;
            if (!Array.isArray(batch) || batch.length === 0) break;
            for (const u of batch) {
              if (u.accountId && u.accountType === "atlassian") {
                allJiraUsers.push({
                  accountId: u.accountId,
                  displayName: u.displayName || "Unknown",
                  email: u.emailAddress || null,
                  active: u.active !== false,
                });
              }
            }
            startAt += batch.length;
            if (batch.length < maxResults) break;
          }
          upsertUsersFromSync(allJiraUsers);
          clearLoading();
          out(`${C.green}✓${C.reset} Synced ${allJiraUsers.length} users`);
          return;
        }

        if (args.stats) {
          const stats = await getCacheStats();
          out(`${C.bold}Cache Statistics${C.reset}`);
          out(`Total issues: ${C.cyan}${stats.totalIssues}${C.reset}`);
          out(`Last sync: ${stats.lastSync ? formatRelativeDate(stats.lastSync) : C.dim + "never" + C.reset}`);
          if (Object.keys(stats.byProject).length > 0) {
            out(`\nBy project:`);
            for (const [proj, count] of Object.entries(stats.byProject).sort((a, b) => b[1] - a[1])) {
              out(`  ${proj}: ${count}`);
            }
          }
          return;
        }

        if (args.backfill) {
          const recentKeys = getRecentCachedKeys(4);
          if (recentKeys.length === 0) {
            out(`${C.green}✓${C.reset} ${C.dim}No recent tickets to backfill${C.reset}`);
            return;
          }

          const progress = new SyncProgress(`Backfill ${recentKeys.length} tickets`);
          progress.startPhase("tickets");

          const BATCH = 100;
          let ticketsFetched = 0;
          for (let i = 0; i < recentKeys.length; i += BATCH) {
            const batch = recentKeys.slice(i, i + BATCH);
            const jql = `key IN (${batch.join(", ")})`;
            let nextPageToken: string | null = null;
            do {
              const result = await jiraSearchPaginated(creds, jql, BATCH, nextPageToken);
              if (result.issues.length > 0) {
                await cacheIssues(result.issues);
                upsertUsersFromSync(extractUsersFromIssues(result.issues));
              }
              ticketsFetched += result.issues.length;
              progress.update(ticketsFetched, recentKeys.length);
              nextPageToken = result.nextPageToken;
            } while (nextPageToken);
          }

          const changelogKeys = getBackfillKeys(4);
          if (changelogKeys.length > 0) {
            progress.startPhase("changelogs");
            await syncTimelineDates(creds, changelogKeys, (fetched, total) => {
              progress.update(fetched, total);
            });
          }

          invalidateSearchIndex();
          const doneMsg = `${C.green}✓${C.reset} Backfilled ${ticketsFetched} tickets${changelogKeys.length > 0 ? `, ${changelogKeys.length} changelogs` : ""}`;
          await progress.done(doneMsg);
          return;
        }

        if (args.c) {
          const allKeys = await getCachedKeys();
          if (allKeys.length === 0) {
            out(`${C.dim}No tickets in cache. Run ${C.bold}tik sync${C.reset}${C.dim} first.${C.reset}`);
            return;
          }
          resetChangelogSynced();
          const progress = new SyncProgress(`Changelogs for ${allKeys.length} tickets`);
          progress.startPhase("changelogs");
          await syncTimelineDates(creds, allKeys, (fetched, total) => {
            progress.update(fetched, total);
          });
          await progress.done(`${C.green}✓${C.reset} Refreshed changelogs for ${allKeys.length} tickets`);
          return;
        }

        const projects = typeof args.p === "string"
          ? args.p.split(",").map(p => p.trim().toUpperCase())
          : undefined;

        await runSync(creds, {
          projects,
          fullSync: !!args.f,
          includeDone: args.a !== false,
        });
      },
    }),
    embed: defineCommand({
      meta: { description: "Manage semantic search embeddings" },
      args: {
        action: { type: "positional", required: false, description: "Action: sync (generate embeddings), check (Ollama status)" },
      },
      run: async ({ args }) => {
        subCommandExecuted = true;

        const action = typeof args.action === "string" ? args.action : "stats";

        if (action === "check") {
          const ollamaUp = await isOllamaAvailable();
          if (!ollamaUp) {
            out(`${C.red}✗${C.reset} Ollama is not running`);
            out(`${C.dim}Start with: ollama serve${C.reset}`);
            return;
          }
          out(`${C.green}✓${C.reset} Ollama is running`);
          const modelReady = await isModelAvailable();
          if (modelReady) {
            out(`${C.green}✓${C.reset} nomic-embed-text model available`);
          } else {
            out(`${C.red}✗${C.reset} nomic-embed-text model not found`);
            out(`${C.dim}Install with: ollama pull nomic-embed-text${C.reset}`);
          }
          return;
        }

        if (action === "sync") {
          const ollamaUp = await isOllamaAvailable();
          if (!ollamaUp) {
            out(`${C.red}✗${C.reset} Ollama is not running. Start with: ${C.cyan}ollama serve${C.reset}`);
            return;
          }
          const progress = new SyncProgress("Embedding sync");
          progress.startPhase("embeddings");
          const count = await syncEmbeddings((done, total) => {
            progress.update(done, total);
          });
          if (count > 0) invalidateEmbeddingCache();
          const msg = count === 0
            ? `${C.green}✓${C.reset} ${C.dim}All embeddings up to date${C.reset}`
            : `${C.green}✓${C.reset} Generated ${count} embeddings`;
          await progress.done(msg);
          return;
        }

        // Default: stats
        const stats = getEmbeddingStats();
        out(`${C.bold}Embedding Statistics${C.reset}`);
        out(`Total issues:  ${C.cyan}${stats.total}${C.reset}`);
        out(`Embedded:      ${C.green}${stats.embedded}${C.reset}`);
        out(`Pending:       ${stats.pending > 0 ? C.yellow + stats.pending + C.reset : C.dim + "0" + C.reset}`);
        if (stats.pending > 0) {
          out(`\n${C.dim}Run ${C.bold}tik embed sync${C.reset}${C.dim} to generate missing embeddings${C.reset}`);
        }
      },
    }),
    doc: defineCommand({
      meta: { description: "Manage Confluence pages" },
      subCommands: {
        view: defineCommand({
          meta: { description: "View a Confluence page" },
          args: {
            id: { type: "positional", required: true, description: "Page ID" },
            F: { type: "boolean", alias: "fresh", description: "Fetch fresh content from Confluence" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            const pageId = String(args.id);
            
            let page: any = null;
            if (!args.F) {
              page = getPageFromCache(pageId);
            }
            
            if (!page) {
              showLoading("Fetching page from Confluence...");
              try {
                const fetchedPage = await getConfluencePage(creds, pageId);
                const spaceKey = await resolveSpaceKey(creds, fetchedPage.spaceId);
                fetchedPage.spaceKey = spaceKey || null;
                cachePages([fetchedPage]);
                page = fetchedPage;
              } finally {
                clearLoading();
              }
            }
            
            if (globalFormat === "json") {
              out(JSON.stringify(page, null, 2));
              return;
            }
            
            out(`${C.bold}${C.cyan}${page.title}${C.reset}`);
            out(`${C.dim}ID: ${page.id} | Space: ${page.spaceKey || page.spaceId} | Version: ${page.version}${C.reset}\n`);
            if (page.body) {
              out(await renderMarkdown(page.body));
            } else {
              out(`${C.dim}(No content)${C.reset}`);
            }
          },
        }),
        create: defineCommand({
          meta: { description: "Create a new Confluence page" },
          args: {
            title: { type: "positional", required: true, description: "Page title" },
            space: { type: "string", description: "Space Key (e.g. ENG) or Space ID" },
            parent: { type: "string", description: "Parent Page ID" },
            d: { type: "string", alias: "desc", description: "Markdown body text (or path to .md file)" },
            stdin: { type: "boolean", description: "Read body from stdin" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            
            let spaceStr = typeof args.space === "string" ? args.space : undefined;
            if (!spaceStr) {
              spaceStr = Config.confluence?.defaultSpace || "";
            }
            if (!spaceStr) {
              console.error(`${C.red}Error: Space key or ID is required (use --space or configure confluence.defaultSpace)${C.reset}`);
              process.exit(1);
            }
            
            let markdown = "";
            if (args.stdin) {
              markdown = await Bun.stdin.text();
            } else if (args.d) {
              markdown = await readFileArg(String(args.d));
            }
            
            let spaceId = spaceStr;
            let spaceKey: string | null = null;
            if (isNaN(Number(spaceStr))) {
              showLoading(`Resolving space key ${spaceStr}...`);
              try {
                spaceId = await resolveSpaceId(creds, spaceStr);
                spaceKey = spaceStr;
              } finally {
                clearLoading();
              }
            } else {
              spaceKey = await resolveSpaceKey(creds, spaceStr);
            }
            
            showLoading("Creating page on Confluence...");
            try {
              const newPage = await createConfluencePage(creds, {
                title: String(args.title),
                spaceId,
                markdown,
                parentId: typeof args.parent === "string" ? args.parent : undefined,
              });
              newPage.spaceKey = spaceKey || null;
              cachePages([newPage]);
              
              out(`${C.green}Created Confluence page successfully!${C.reset}`);
              out(`ID: ${newPage.id}`);
              out(`URL: ${Config.jiraBase}/wiki/spaces/${spaceKey || spaceId}/pages/${newPage.id}`);
            } finally {
              clearLoading();
            }
          },
        }),
        edit: defineCommand({
          meta: { description: "Edit a Confluence page interactively" },
          args: {
            id: { type: "positional", required: true, description: "Page ID" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            const pageId = String(args.id);
            
            showLoading("Fetching page details...");
            let page: any;
            try {
              page = await getConfluencePage(creds, pageId);
            } finally {
              clearLoading();
            }
            
            const originalBody = page.body || "";
            const tempFilePath = `/tmp/tik-doc-${pageId}.md`;
            await Bun.write(tempFilePath, originalBody);
            
            const editor = process.env.EDITOR || "nano";
            const proc = Bun.spawn([editor, tempFilePath], {
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            });
            await proc.exited;
            
            const updatedBody = await Bun.file(tempFilePath).text();
            if (updatedBody === originalBody) {
              out(`${C.yellow}No changes detected. Page not updated.${C.reset}`);
              return;
            }
            
            showLoading("Updating page on Confluence...");
            try {
              const updatedPage = await updateConfluencePage(creds, pageId, {
                title: page.title,
                markdown: updatedBody,
                currentVersion: page.version,
              });
              const spaceKey = await resolveSpaceKey(creds, updatedPage.spaceId);
              updatedPage.spaceKey = spaceKey || null;
              cachePages([updatedPage]);
              
              out(`${C.green}Updated Confluence page successfully!${C.reset}`);
              out(`ID: ${updatedPage.id}`);
              out(`Version: ${updatedPage.version}`);
            } finally {
              clearLoading();
            }
          },
        }),
        search: defineCommand({
          meta: { description: "Search Confluence pages" },
          args: {
            query: { type: "positional", required: true, description: "Search query" },
            space: { type: "string", description: "Space Key to filter by" },
            online: { type: "boolean", alias: "O", description: "Search online using Confluence API (CQL)" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            const query = String(args.query);
            
            if (args.online) {
              showLoading("Searching Confluence online...");
              try {
                let cql = `text ~ "${query}" AND type=page`;
                if (args.space) {
                  cql += ` AND space = "${String(args.space)}"`;
                }
                const results = await searchConfluence(creds, cql);
                if (globalFormat === "json") {
                  out(JSON.stringify(results, null, 2));
                  return;
                }
                
                if (results.length === 0) {
                  out("No pages found.");
                  return;
                }
                
                out(`${C.bold}Online search results for "${query}":${C.reset}\n`);
                for (const item of results) {
                  const title = item.title;
                  const id = item.content?.id || item.id;
                  const space = item.space?.key || "";
                  out(`  • ${C.cyan}${title}${C.reset} ${C.dim}(ID: ${id} | Space: ${space})${C.reset}`);
                }
              } finally {
                clearLoading();
              }
            } else {
              let results = searchPagesInCache(query);
              if (args.space) {
                const filterSpace = String(args.space).toLowerCase();
                results = results.filter(p => p.spaceKey?.toLowerCase() === filterSpace);
              }
              
              if (globalFormat === "json") {
                out(JSON.stringify(results, null, 2));
                return;
              }
              
              if (results.length === 0) {
                out(`No cached pages found matching "${query}". Run with ${C.cyan}-O${C.reset} or ${C.cyan}--online${C.reset} to search online.`);
                return;
              }
              
              out(`${C.bold}Cached search results for "${query}":${C.reset}\n`);
              for (const page of results) {
                out(`  • ${C.cyan}${page.title}${C.reset} ${C.dim}(ID: ${page.id} | Space: ${page.spaceKey || page.spaceId})${C.reset}`);
              }
            }
          },
        }),
        sync: defineCommand({
          meta: { description: "Sync Confluence pages to local cache" },
          args: {
            space: { type: "string", description: "Specific Space Key to sync" },
          },
          run: async ({ args }) => {
            subCommandExecuted = true;
            applyFormat(args);
            const creds = await getCredentials(args);
            
            let spacesToSync: string[] = [];
            if (args.space) {
              spacesToSync = [String(args.space)];
            } else if (Config.confluence?.syncSpaces && Config.confluence.syncSpaces.length > 0) {
              spacesToSync = Config.confluence.syncSpaces;
            } else if (Config.confluence?.defaultSpace) {
              spacesToSync = [Config.confluence.defaultSpace];
            }
            
            if (spacesToSync.length === 0) {
              console.error(`${C.red}Error: No spaces to sync configured. Use --space or define confluence.syncSpaces in config.local.json.${C.reset}`);
              process.exit(1);
            }
            
            out(`Starting Confluence sync for spaces: ${spacesToSync.join(", ")}`);
            for (const spaceKey of spacesToSync) {
              showLoading(`Syncing space ${spaceKey}...`);
              try {
                const spaceId = await resolveSpaceId(creds, spaceKey);
                const pages = await getPagesInSpace(creds, spaceId, 100);
                
                const detailedPages: any[] = [];
                for (const p of pages) {
                  showLoading(`Fetching page: ${p.title}...`);
                  try {
                    const detailed = await getConfluencePage(creds, p.id);
                    detailed.spaceKey = spaceKey || null;
                    detailedPages.push(detailed);
                  } catch (err) {
                    console.error(`Failed to fetch page ${p.id} (${p.title}):`, err);
                  }
                }
                
                if (detailedPages.length > 0) {
                  cachePages(detailedPages);
                }
                out(`${C.green}✓ Synced ${detailedPages.length} pages in space ${spaceKey}${C.reset}`);
              } catch (err: any) {
                console.error(`Failed to sync space ${spaceKey}:`, err.message || err);
              } finally {
                clearLoading();
              }
            }
            out(`${C.green}Confluence sync complete!${C.reset}`);
          },
        }),
      },
    }),
  },
  run: async ({ args }) => {
    if (subCommandExecuted) return;
    if (args.version) {
      out(getPackageVersion());
      return;
    }
    if (args["agent-help"]) {
      await printAgentHelp();
      return;
    }
    applyFormat(args);
    const creds = await getCredentials(args);
    await ensureCacheOrFresh(creds, args);

    const localData = getLocalSprintData(getMyBoardId());
    if (!localData) {
      // No active sprint in cache, fall back to local mine issues
      const accountId = await requireAccountId(creds.email);
      const rawIssues = getLocalMineIssues(accountId, getQaAccountIds());
      out("No active sprint found, showing my tickets instead");
      await formatIssues({ issues: rawIssues }, "My Open Tickets", true);
      await printSyncAge();
      return;
    }

    const sprint = parseSprint(localData.sprint);
    const issues = parseIssues({ issues: localData.rawIssues });

    if (globalFormat === "json") {
      out(JSON.stringify({ sprint, issues: { issues: localData.rawIssues } }, null, 2));
      return;
    }
    if (globalFormat === "plain") {
      for (const issue of issues) out(issue.key);
      return;
    }

    const accountId = await requireAccountId(creds.email);
    const sprintKeys = issues.map(i => i.key);
    const wasMine = getWasMineKeys(accountId, sprintKeys);

    if (globalShowPR) {
      await formatSprintView(sprint, issues, {
        expandDone: false,
        mineOnly: true,
        currentUserId: accountId,
        prMap: undefined,
        wasMineKeys: wasMine,
      });

      showLoading("Loading PR status...");
      const prMap = await fetchPRsForTickets(sprintKeys);

      clearScreen();
      await formatSprintView(sprint, issues, {
        expandDone: false,
        mineOnly: true,
        currentUserId: accountId,
        prMap,
        wasMineKeys: wasMine,
      });
    } else {
      await formatSprintView(sprint, issues, {
        expandDone: false,
        mineOnly: true,
        currentUserId: accountId,
        prMap: undefined,
        wasMineKeys: wasMine,
      });
    }
    await printSyncAge();
  },
});

/** mri turns `--no-foo` into `foo: false` rather than setting `"no-foo"`, so accept both spellings. */
function isDisabled(args: Record<string, unknown>, name: string): boolean {
  return args[`no-${name}`] === true || args[name] === false;
}

function applyFormat(args: Record<string, unknown>): void {
  if (args.json) globalFormat = "json";
  else if (args.plain) globalFormat = "plain";
  else globalFormat = "table";
  setQuietProgress(globalFormat !== "table" || !!args.md);
  globalShowPR = !!args.pr;
  globalExpandDone = !!args["expand-done"];
  if (typeof args.grep === "string" && args.grep) {
    try { globalGrepFilter = new RegExp(args.grep, "i"); }
    catch { globalGrepFilter = new RegExp(args.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  } else {
    globalGrepFilter = null;
  }
  if (typeof args.type === "string" && args.type) {
    globalTypeFilter = args.type.split(",").map((t: string) => t.trim().toLowerCase());
  } else {
    globalTypeFilter = null;
  }
}

async function getCredentials(args: Record<string, unknown>): Promise<Credentials> {
  try {
    return await loadCredentials(!!args["refresh-auth"]);
  } catch (err) {
    emitError("credentials_failed", "Could not load Atlassian credentials from 1Password", {
      hint: "Run: op signin",
      details: String(err),
    });
  }
}

// Workaround: citty's mri parser won't consume a value starting with '-' for
// string args (treats it as a new flag). Convert `--arg <-value>` to `--arg=<-value>`.
const stringArgs = new Set(["--ac", "--ti", "-d", "--desc", "-s", "--summary", "-q", "-m"]);
const argv = process.argv;
for (let i = 0; i < argv.length - 1; i++) {
  if (stringArgs.has(argv[i]) && argv[i + 1]?.startsWith("-")) {
    argv[i] = `${argv[i]}=${argv[i + 1]}`;
    argv.splice(i + 1, 1);
  }
}

process.on("uncaughtException", (err) => {
  if (globalFormat === "json") {
    out(JSON.stringify({ error: "uncaught", message: err instanceof Error ? err.message : String(err) }, null, 2));
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  if (globalFormat === "json") {
    out(JSON.stringify({ error: "unhandled_rejection", message: err instanceof Error ? err.message : String(err) }, null, 2));
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

await runMain(main);
await flushStdout();
