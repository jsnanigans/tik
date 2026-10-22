import { C } from "./colors";
import type { AdfNode } from "./markdown";
import { renderAdf, renderMarkdownText, type RenderOptions } from "./term-render";

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

export async function renderMarkdown(md: string, options?: Partial<RenderOptions>): Promise<string> {
  return renderMarkdownText(md, options).join("\n");
}

/** Renders the ADF when there is one, else the markdown it was derived from. */
export async function renderRichText(adf: AdfNode | null | undefined, md: string, options?: Partial<RenderOptions>): Promise<string> {
  return adf ? renderAdf(adf, options).join("\n") : renderMarkdown(md, options);
}
