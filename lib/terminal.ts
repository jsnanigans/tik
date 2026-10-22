import { C } from "./colors";
import { localConfig } from "./config";
import type { AdfNode } from "./markdown";
import { loadCredentials } from "./credentials";
import { imagesEnabled, type ImageMode } from "./kitty";
import type { AttachmentData } from "./parser";
import { createMediaProvider } from "./term-media";
import { collectMedia, renderAdf, renderMarkdownText, type ImageProvider, type RenderOptions } from "./term-render";

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

const withConfig = (options?: Partial<RenderOptions>): Partial<RenderOptions> => ({ theme: localConfig.terminal?.theme, ...options });

export async function renderMarkdown(md: string, options?: Partial<RenderOptions>): Promise<string> {
  return renderMarkdownText(md, withConfig(options)).join("\n");
}

/** Renders the ADF when there is one, else the markdown it was derived from. */
export async function renderRichText(adf: AdfNode | null | undefined, md: string, options?: Partial<RenderOptions>): Promise<string> {
  return adf ? renderAdf(adf, withConfig(options)).join("\n") : renderMarkdown(md, options);
}

/**
 * A provider for the media of `docs`, or null when they have none. `mode` is the command line choice and falls back to the
 * `terminal.images` setting; `inline` is false where an image cannot be printed (Ink output), leaving only the placeholder notes.
 */
export async function mediaProviderFor(
  docs: (AdfNode | null | undefined)[],
  key: string,
  attachments: AttachmentData[],
  { inline, mode }: { inline: boolean; mode?: ImageMode }
): Promise<ImageProvider | null> {
  const refs = docs.flatMap((doc) => (doc ? collectMedia(doc) : []));
  if (refs.length === 0) return null;
  const terminal = localConfig.terminal ?? {};
  return createMediaProvider(refs, {
    jiraBase: localConfig.jiraBase,
    key,
    attachments,
    images: inline && imagesEnabled(mode ?? terminal.images ?? "auto"),
    tmux: Boolean(process.env.TMUX),
    maxBytes: terminal.maxImageBytes,
    maxRows: terminal.maxImageRows,
    getCredentials: () => loadCredentials(false),
  });
}
