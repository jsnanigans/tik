import { C } from "./colors";

export function getTerminalWidth(): number {
  return process.stdout.columns || 100;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Waits for queued stdout writes to reach the OS. Without this a large --json
 * payload is truncated when the process exits before a slow pipe consumer drains it.
 */
export async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
}

let quietProgress = false;

/** Silences spinners and cursor control so they can't corrupt --json/--plain output. */
export function setQuietProgress(quiet: boolean): void {
  quietProgress = quiet;
}

function progressVisible(): boolean {
  return !quietProgress && process.stdout.isTTY === true;
}

export function showLoading(message: string): void {
  if (!progressVisible()) return;
  process.stdout.write(`${C.dim}${message}${C.reset}`);
}

export function clearLoading(): void {
  if (!progressVisible()) return;
  process.stdout.write(`${C.cursorToStart}${C.clearLine}`);
}

export function clearScreen(): void {
  if (!progressVisible()) return;
  process.stdout.write(C.clearScreen);
}

export function progressBar(percent: number, width: number = 20): string {
  const clampedPercent = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round((clampedPercent / 100) * width);
  const empty = width - filled;
  return `${C.green}${"█".repeat(filled)}${C.dim}${"░".repeat(empty)}${C.reset}`;
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

let _markedReady: Promise<(md: string) => string> | null = null;

function getMarked(): Promise<(md: string) => string> {
  if (!_markedReady) {
    _markedReady = (async () => {
      const { marked } = await import("marked");
      const { markedTerminal } = await import("marked-terminal");
      marked.use(markedTerminal({ reflowText: true, width: getTerminalWidth() - 4 }));
      return (md: string) => (marked.parse(md) as string).trimEnd();
    })();
  }
  return _markedReady;
}

let _hasGlow: boolean | null = null;

function hasGlow(): boolean {
  if (_hasGlow === null) {
    try {
      const proc = Bun.spawnSync(["which", "glow"]);
      _hasGlow = proc.exitCode === 0;
    } catch {
      _hasGlow = false;
    }
  }
  return _hasGlow;
}

function renderWithGlow(md: string): string | null {
  try {
    const width = getTerminalWidth() - 4;
    const proc = Bun.spawnSync(["glow", "-s", "dark", "-w", String(width), "-"], {
      stdin: new TextEncoder().encode(md),
      env: { ...process.env, CLICOLOR_FORCE: "1", COLORTERM: "truecolor" },
    });
    if (proc.exitCode === 0 && proc.stdout.length > 0) {
      return new TextDecoder().decode(proc.stdout).trimEnd();
    }
  } catch {}
  return null;
}

export async function renderMarkdown(md: string): Promise<string> {
  if (hasGlow()) {
    const result = renderWithGlow(md);
    if (result !== null) return result;
  }
  const render = await getMarked();
  return render(md);
}
