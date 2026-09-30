export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runCommandResult(cmd: string[], cwd?: string): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return {
      ok: proc.exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: proc.exitCode ?? -1,
    };
  } catch {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: -1,
    };
  }
}

export async function runCommand(cmd: string[], cwd?: string): Promise<string | null> {
  const result = await runCommandResult(cmd, cwd);
  if (!result.ok) return null;
  return result.stdout || null;
}

export function getCacheDir(): string {
  const home = process.env.HOME || "/tmp";
  return `${home}/.cache/tik`;
}

export async function readFileArg(value: string): Promise<string> {
  const looksLikePath = value.includes("/") ||
    value.startsWith("./") ||
    value.startsWith("~/") ||
    /\.(md|txt|markdown)$/i.test(value);

  if (looksLikePath) {
    const filePath = value.startsWith("~/")
      ? value.replace("~", process.env.HOME || "")
      : value;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return await file.text();
    }
  }
  return value;
}

export async function ensureInsideGitRepo(): Promise<boolean> {
  return (await runCommand(["git", "rev-parse", "--is-inside-work-tree"])) !== null;
}

export async function ticketFromBranch(): Promise<string | null> {
  const branch = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const match = branch.match(/[A-Za-z][A-Za-z0-9]+-\d+/);
  return match ? match[0].toUpperCase() : null;
}

export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  return await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function gitBranchExists(branch: string, cwd?: string): Promise<boolean> {
  const result = await runCommandResult(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  return result.ok;
}

export async function gitRemoteBranchExists(branch: string, remote = "origin", cwd?: string): Promise<boolean> {
  const result = await runCommandResult(["git", "ls-remote", "--heads", remote, branch], cwd);
  return result.ok && !!result.stdout;
}

export type GitWorktree = {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
};

export async function listGitWorktrees(cwd?: string): Promise<GitWorktree[]> {
  const output = await runCommand(["git", "worktree", "list", "--porcelain"], cwd);
  if (!output) return [];

  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();

    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: value, branch: null, head: null, bare: false, detached: false };
      continue;
    }

    if (!current) continue;
    if (key === "branch") current.branch = value.replace("refs/heads/", "");
    else if (key === "HEAD") current.head = value;
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
  }

  if (current) worktrees.push(current);
  return worktrees;
}

export async function findWorktreeByName(name: string, cwd?: string): Promise<GitWorktree | null> {
  const worktrees = await listGitWorktrees(cwd);
  const normalized = name.trim().toLowerCase();
  return worktrees.find((wt) => {
    const base = wt.path.split("/").filter(Boolean).pop()?.toLowerCase();
    const branch = wt.branch?.toLowerCase();
    return base === normalized || branch === normalized;
  }) || null;
}

export function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return "──";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffWeeks < 5) return `${diffWeeks}w`;
  if (diffMonths < 12) return `${diffMonths}mo`;
  return `${Math.floor(diffMonths / 12)}y`;
}

export function abbreviateName(name: string | null): string {
  if (!name) return "";
  const parts = name.split(" ");
  if (parts.length === 1) return name.slice(0, 8);
  return parts[0].toLowerCase().slice(0, 8);
}

export const PriorityMap: Record<string, string> = {
  "highest": "1", "1": "1",
  "high": "2", "2": "2",
  "medium": "3", "3": "3",
  "low": "4", "4": "4",
  "lowest": "5", "5": "5",
};

export const PriorityNames = ["", "Highest", "High", "Medium", "Low", "Lowest"];

export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
}
