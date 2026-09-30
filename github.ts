import { C } from "./lib/colors";
import { runCommand, runCommandResult } from "./lib/util";
import { localConfig } from "./lib/config";

const GithubRepos: Record<string, string> = localConfig.githubRepos;

export type PRCheckRun = {
  name: string;
  workflowName: string;
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED";
  conclusion: string | null;
  detailsUrl: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type PRReview = {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED";
  author: string;
  body: string;
  submittedAt: string;
};

export type PRMergeStatus = {
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: "CLEAN" | "BEHIND" | "BLOCKED" | "DIRTY" | "HAS_HOOKS" | "UNSTABLE" | "UNKNOWN";
};

export type PRDetail = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviews: PRReview[];
  reviewRequests: string[];
  totalComments: number;
  checkRuns: PRCheckRun[];
  checksStatus: "SUCCESS" | "FAILURE" | "PENDING" | null;
  mergeStatus: PRMergeStatus;
};

export type PRData = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  updatedAt: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checksStatus: "SUCCESS" | "FAILURE" | "PENDING" | null;
};

export type PRMap = Map<string, PRData>;

export type PRAuthorActivity = {
  repo: string;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  activityType: "opened" | "merged" | "updated";
  activityAt: string;
  ticketKey: string | null;
};

type GhCheckRun = {
  conclusion: string | null;
  status: string;
};

type GhPRResponse = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: string;
  isDraft?: boolean;
  updatedAt: string;
  reviewDecision: string | null;
  statusCheckRollup: GhCheckRun[] | null;
};

type GhPRAuthorResponse = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
};

type GhPRDetailResponse = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: string;
  isDraft?: boolean;
  updatedAt: string;
  reviewDecision: string | null;
  statusCheckRollup: GhCheckRun[] | null;
};

function computeChecksStatus(checks: GhCheckRun[] | null): PRData["checksStatus"] {
  if (!checks || checks.length === 0) return null;

  const failureConclusions = new Set([
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]);

  let hasFailure = false;
  let hasPending = false;

  for (const check of checks) {
    if (check.status !== "COMPLETED") {
      hasPending = true;
      continue;
    }

    const conclusion = (check.conclusion || "").toUpperCase();
    if (!conclusion) {
      hasPending = true;
      continue;
    }

    if (failureConclusions.has(conclusion)) {
      hasFailure = true;
    }
  }

  if (hasFailure) return "FAILURE";
  if (hasPending) return "PENDING";
  return "SUCCESS";
}

async function fetchPRsForRepo(repo: string): Promise<PRData[]> {
  const output = await runCommand([
    "gh", "pr", "list", "--repo", repo, "--state", "all", "--limit", "300",
    "--json", "number,title,url,headRefName,state,isDraft,updatedAt,reviewDecision,statusCheckRollup",
  ]);
  if (!output) return [];

  try {
    const prs = JSON.parse(output) as GhPRResponse[];
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      state: pr.state as PRData["state"],
      isDraft: !!pr.isDraft,
      updatedAt: pr.updatedAt,
      reviewDecision: (pr.reviewDecision || null) as PRData["reviewDecision"],
      checksStatus: computeChecksStatus(pr.statusCheckRollup),
    }));
  } catch {
    return [];
  }
}

function extractTicketFromBranch(branch: string): string | null {
  const match = branch.match(/([A-Za-z][A-Za-z0-9]+-\d+)/);
  return match ? match[1].toUpperCase() : null;
}

function stateRank(state: PRData["state"]): number {
  if (state === "OPEN") return 3;
  if (state === "MERGED") return 2;
  return 1;
}

function selectPreferredPR(existing: PRData, incoming: PRData): PRData {
  const existingState = stateRank(existing.state);
  const incomingState = stateRank(incoming.state);

  if (incomingState !== existingState) {
    return incomingState > existingState ? incoming : existing;
  }

  if (existing.isDraft !== incoming.isDraft) {
    return existing.isDraft ? incoming : existing;
  }

  const existingUpdated = new Date(existing.updatedAt).getTime();
  const incomingUpdated = new Date(incoming.updatedAt).getTime();
  return incomingUpdated > existingUpdated ? incoming : existing;
}

export function getRepoForProject(project: string): string | undefined {
  return GithubRepos[project];
}

export function getAllMappedRepos(): string[] {
  return [...new Set(Object.values(GithubRepos))];
}

async function fetchRecentAuthorPRsForRepo(repo: string, cutoff: Date): Promise<PRAuthorActivity[]> {
  const sinceDate = cutoff.toISOString().slice(0, 10);
  const output = await runCommand([
    "gh", "pr", "list", "--repo", repo, "--author", "@me", "--state", "all",
    "--limit", "200", "--search", `updated:>=${sinceDate}`,
    "--json", "number,title,url,headRefName,state,createdAt,updatedAt,mergedAt",
  ]);
  if (!output) return [];

  try {
    const prs = JSON.parse(output) as GhPRAuthorResponse[];
    const cutoffMs = cutoff.getTime();
    const result: PRAuthorActivity[] = [];

    for (const pr of prs) {
      const createdMs = new Date(pr.createdAt).getTime();
      const updatedMs = new Date(pr.updatedAt).getTime();
      const mergedMs = pr.mergedAt ? new Date(pr.mergedAt).getTime() : 0;
      const inWindow = createdMs >= cutoffMs || updatedMs >= cutoffMs || mergedMs >= cutoffMs;
      if (!inWindow) continue;

      let activityType: PRAuthorActivity["activityType"] = "updated";
      let activityAt = pr.updatedAt;
      if (pr.mergedAt && mergedMs >= cutoffMs) {
        activityType = "merged";
        activityAt = pr.mergedAt;
      } else if (createdMs >= cutoffMs) {
        activityType = "opened";
        activityAt = pr.createdAt;
      }

      result.push({
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRefName: pr.headRefName,
        state: pr.state as PRAuthorActivity["state"],
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        mergedAt: pr.mergedAt,
        activityType,
        activityAt,
        ticketKey: extractTicketFromBranch(pr.headRefName),
      });
    }

    return result;
  } catch {
    return [];
  }
}

export async function fetchRecentPRAuthorActivity(repos: string[], cutoff: Date): Promise<PRAuthorActivity[]> {
  if (repos.length === 0) return [];
  const uniqueRepos = [...new Set(repos)];
  const results = await Promise.all(uniqueRepos.map(repo => fetchRecentAuthorPRsForRepo(repo, cutoff)));
  return results.flat().sort((a, b) => new Date(b.activityAt).getTime() - new Date(a.activityAt).getTime());
}

export async function getPRForTicket(ticketKey: string): Promise<PRData | undefined> {
  const prMap = await fetchPRsForTickets([ticketKey]);
  return prMap.get(ticketKey);
}

export async function getPRForBranch(repo: string, branch: string): Promise<PRData | undefined> {
  const output = await runCommand([
    "gh", "pr", "list", "--repo", repo, "--state", "all", "--head", branch,
    "--limit", "10",
    "--json", "number,title,url,headRefName,state,isDraft,updatedAt,reviewDecision,statusCheckRollup",
  ]);
  if (!output) return undefined;

  try {
    const prs = JSON.parse(output) as GhPRDetailResponse[];
    let preferred: PRData | undefined;
    for (const pr of prs) {
      if (pr.headRefName !== branch) continue;
      const parsed = {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRefName: pr.headRefName,
        state: pr.state as PRData["state"],
        isDraft: !!pr.isDraft,
        updatedAt: pr.updatedAt,
        reviewDecision: (pr.reviewDecision || null) as PRData["reviewDecision"],
        checksStatus: computeChecksStatus(pr.statusCheckRollup),
      };
      preferred = preferred ? selectPreferredPR(preferred, parsed) : parsed;
    }
    return preferred;
  } catch {
    return undefined;
  }
}

export async function createPullRequest(opts: {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  assignee?: string;
  draft?: boolean;
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cmd = [
    "gh", "pr", "create",
    "--repo", opts.repo,
    "--base", opts.base,
    "--head", opts.head,
    "--title", opts.title,
    "--body", opts.body,
  ];
  if (opts.assignee) cmd.push("--assignee", opts.assignee);
  if (opts.draft) cmd.push("--draft");

  const result = await runCommandResult(cmd);
  if (!result.ok) {
    return { ok: false, error: result.stderr || result.stdout || "Failed to create PR" };
  }
  return { ok: true, url: result.stdout || undefined };
}

export async function openPullRequest(repo: string, branch: string): Promise<boolean> {
  const result = await runCommandResult(["gh", "pr", "view", "--repo", repo, branch, "--web"]);
  return result.ok;
}

export async function fetchPRsForTickets(ticketKeys: string[]): Promise<PRMap> {
  const prMap: PRMap = new Map();
  const wanted = new Set(ticketKeys.map(k => k.toUpperCase()));

  const reposNeeded = new Set<string>();
  for (const key of wanted) {
    const project = key.split("-")[0];
    const repo = GithubRepos[project];
    if (repo) reposNeeded.add(repo);
  }

  if (reposNeeded.size === 0) return prMap;

  const repoArray = Array.from(reposNeeded);
  const results = await Promise.all(repoArray.map(fetchPRsForRepo));

  for (const prs of results) {
    for (const pr of prs) {
      const ticket = extractTicketFromBranch(pr.headRefName);
      if (!ticket || !wanted.has(ticket)) continue;

      const existing = prMap.get(ticket);
      if (!existing) {
        prMap.set(ticket, pr);
      } else {
        prMap.set(ticket, selectPreferredPR(existing, pr));
      }
    }
  }

  return prMap;
}

export type PRGateResult =
  | { ok: true; pr: PRData }
  | { ok: false; message: string };

export function validateReviewGate(pr: PRData | undefined): PRGateResult {
  if (!pr) return { ok: false, message: "No PR found" };
  if (pr.state !== "OPEN") return { ok: false, message: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isDraft) return { ok: false, message: `PR #${pr.number} is draft` };
  if (pr.reviewDecision !== "APPROVED") {
    const reviewState = pr.reviewDecision ? pr.reviewDecision.toLowerCase().replaceAll("_", " ") : "unknown";
    return { ok: false, message: `PR #${pr.number} review state is '${reviewState}', expected 'approved'` };
  }
  if (pr.checksStatus !== "SUCCESS") {
    const checksState = pr.checksStatus ? pr.checksStatus.toLowerCase() : "unknown";
    return { ok: false, message: `PR #${pr.number} checks are '${checksState}', expected 'success'` };
  }
  return { ok: true, pr };
}

// ─── My PRs (author or assignee) ──────────────────────────────────────

export type MyPRSummary = {
  repo: string;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  updatedAt: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checksStatus: "SUCCESS" | "FAILURE" | "PENDING" | null;
};

type GhPRSummaryResponse = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft?: boolean;
  updatedAt: string;
  reviewDecision: string | null;
  statusCheckRollup: GhCheckRun[] | null;
};

async function fetchRepoPRsByAuthor(repo: string): Promise<MyPRSummary[]> {
  const output = await runCommand([
    "gh", "pr", "list", "--repo", repo, "--author", "@me",
    "--state", "all", "--limit", "300",
    "--json", "number,title,url,headRefName,baseRefName,state,isDraft,updatedAt,reviewDecision,statusCheckRollup",
  ]);
  if (!output) return [];
  try {
    const prs = JSON.parse(output) as GhPRSummaryResponse[];
    return prs.map(pr => ({
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state: pr.state as MyPRSummary["state"],
      isDraft: !!pr.isDraft,
      updatedAt: pr.updatedAt,
      reviewDecision: (pr.reviewDecision || null) as MyPRSummary["reviewDecision"],
      checksStatus: computeChecksStatus(pr.statusCheckRollup),
    }));
  } catch {
    return [];
  }
}

async function fetchRepoPRsByAssignee(repo: string): Promise<MyPRSummary[]> {
  const output = await runCommand([
    "gh", "pr", "list", "--repo", repo,
    "--search", "assignee:@me",
    "--state", "all", "--limit", "300",
    "--json", "number,title,url,headRefName,baseRefName,state,isDraft,updatedAt,reviewDecision,statusCheckRollup",
  ]);
  if (!output) return [];
  try {
    const prs = JSON.parse(output) as GhPRSummaryResponse[];
    return prs.map(pr => ({
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state: pr.state as MyPRSummary["state"],
      isDraft: !!pr.isDraft,
      updatedAt: pr.updatedAt,
      reviewDecision: (pr.reviewDecision || null) as MyPRSummary["reviewDecision"],
      checksStatus: computeChecksStatus(pr.statusCheckRollup),
    }));
  } catch {
    return [];
  }
}

export async function fetchMyPRs(opts?: {
  repos?: string[];
  state?: "OPEN" | "MERGED" | "CLOSED" | "all";
}): Promise<MyPRSummary[]> {
  const repos = opts?.repos ?? getAllMappedRepos();
  if (repos.length === 0) return [];

  const uniqueRepos = [...new Set(repos)];
  const [authorResults, assigneeResults] = await Promise.all([
    Promise.all(uniqueRepos.map(r => fetchRepoPRsByAuthor(r))),
    Promise.all(uniqueRepos.map(r => fetchRepoPRsByAssignee(r))),
  ]);

  const seen = new Set<string>();
  const all: MyPRSummary[] = [];

  for (const prs of [...authorResults.flat(), ...assigneeResults.flat()]) {
    const key = `${prs.repo}#${prs.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(prs);
  }

  if (opts?.state && opts.state !== "all") {
    return all.filter(p => p.state === opts.state).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  return all.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function formatPRReviewLabel(pr: PRData): string {
  if (pr.reviewDecision === "APPROVED") return `${C.green}approved${C.reset}`;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return `${C.red}changes requested${C.reset}`;
  if (pr.reviewDecision === "REVIEW_REQUIRED") return `${C.yellow}review required${C.reset}`;
  return `${C.dim}unknown${C.reset}`;
}

// ─── Detailed PR fetch ─────────────────────────────────────────────

type GhCheckRunResponse = {
  __typename?: string;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string;
  startedAt: string | null;
  completedAt: string | null;
  workflowName?: string;
};

type GhReviewResponse = {
  state: string;
  author: { login: string };
  body: string;
  submittedAt: string;
};

type GhPRDetailResponseFull = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  reviews: GhReviewResponse[];
  reviewRequests: Array<{ requestedReviewer?: { login: string } }>;
  comments: { totalCount?: number } | number;
  statusCheckRollup: GhCheckRunResponse[] | null;
  mergeable: string;
  mergeStateStatus: string;
};

function parsePRDetail(raw: GhPRDetailResponseFull): PRDetail {
  const reviews: PRReview[] = (raw.reviews || []).map(r => ({
    state: r.state as PRReview["state"],
    author: r.author?.login || "unknown",
    body: r.body || "",
    submittedAt: r.submittedAt,
  }));

  const reviewRequests: string[] = (raw.reviewRequests || [])
    .map(rr => rr.requestedReviewer?.login)
    .filter((l): l is string => !!l);

  const checks: GhCheckRunResponse[] = raw.statusCheckRollup || [];
  const checkRuns: PRCheckRun[] = checks.map(c => ({
    name: c.name,
    workflowName: c.workflowName || c.__typename || "",
    status: c.status as PRCheckRun["status"],
    conclusion: c.conclusion,
    detailsUrl: c.detailsUrl,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
  }));

  const failureConclusions = new Set([
    "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE",
  ]);
  let hasFailure = false;
  let hasPending = false;
  for (const check of checks) {
    if (check.status !== "COMPLETED") {
      hasPending = true;
      continue;
    }
    const conclusion = (check.conclusion || "").toUpperCase();
    if (!conclusion) { hasPending = true; continue; }
    if (failureConclusions.has(conclusion)) { hasFailure = true; }
  }
  const checksStatus: PRDetail["checksStatus"] = hasFailure ? "FAILURE" : hasPending ? "PENDING" : "SUCCESS";

  // Deduplicate reviews by keeping the latest per reviewer
  const latestReview = new Map<string, PRReview>();
  for (const r of [...reviews].reverse()) {
    if (!latestReview.has(r.author)) {
      latestReview.set(r.author, r);
    }
  }
  const dedupedReviews = [...latestReview.values()].sort(
    (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
  );

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    state: raw.state as PRDetail["state"],
    isDraft: !!raw.isDraft,
    updatedAt: raw.updatedAt,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    reviewDecision: (raw.reviewDecision || null) as PRDetail["reviewDecision"],
    reviews: dedupedReviews,
    reviewRequests,
    totalComments: typeof raw.comments === "number" ? raw.comments : (raw.comments?.totalCount ?? 0),
    checkRuns,
    checksStatus,
    mergeStatus: {
      mergeable: raw.mergeable as PRMergeStatus["mergeable"],
      mergeStateStatus: raw.mergeStateStatus as PRMergeStatus["mergeStateStatus"],
    },
  };
}

const GH_PR_VIEW_JSON_FIELDS = [
  "number", "title", "url", "state", "headRefName", "baseRefName",
  "isDraft", "updatedAt", "additions", "deletions", "changedFiles",
  "mergeable", "mergeStateStatus",
  "reviews", "reviewRequests", "comments", "statusCheckRollup",
].join(",");

export async function fetchPRDetail(repo: string, number: number): Promise<PRDetail | undefined> {
  const output = await runCommand([
    "gh", "pr", "view", String(number), "--repo", repo,
    "--json", GH_PR_VIEW_JSON_FIELDS,
  ]);
  if (!output) return undefined;

  try {
    const raw = JSON.parse(output) as GhPRDetailResponseFull;
    return parsePRDetail(raw);
  } catch {
    return undefined;
  }
}

export async function fetchPRDetailForBranch(repo: string, branch: string): Promise<PRDetail | undefined> {
  const output = await runCommand([
    "gh", "pr", "view", branch, "--repo", repo,
    "--json", GH_PR_VIEW_JSON_FIELDS,
  ]);
  if (!output) return undefined;

  try {
    const raw = JSON.parse(output) as GhPRDetailResponseFull;
    if (raw.state !== "OPEN") return undefined;
    return parsePRDetail(raw);
  } catch {
    return undefined;
  }
}

export function formatPRChecksLabel(pr: PRData): string {
  if (pr.checksStatus === "SUCCESS") return `${C.green}passing${C.reset}`;
  if (pr.checksStatus === "FAILURE") return `${C.red}failing${C.reset}`;
  if (pr.checksStatus === "PENDING") return `${C.yellow}pending${C.reset}`;
  return `${C.dim}unknown${C.reset}`;
}
