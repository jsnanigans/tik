import { existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { makeAuthHeader, type Credentials } from "./credentials";
import { imageLines, imageCells, mediaCachePath, pngSize, placementSequence, type PngSize } from "./kitty";
import type { AttachmentData } from "./parser";
import type { ImageProvider, MediaRef } from "./term-render";

export const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_ROWS = 20;
const DOWNLOAD_TIMEOUT_MS = 10_000;

export type MediaOptions = {
  jiraBase: string;
  /** Ticket key, for the `tik get` hint. */
  key?: string;
  attachments: AttachmentData[];
  /** Show PNGs inline; otherwise only the size and download hint are added to the placeholder. */
  images: boolean;
  tmux: boolean;
  maxBytes?: number;
  maxRows?: number;
  getCredentials: () => Promise<Credentials>;
};

type Entry = { note: string; png?: Uint8Array; size?: PngSize };

const refKey = (ref: MediaRef) => `${ref.id ?? ""}|${ref.name}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** By media id when the attachment carries it, else by the filename the media node uses as its alt (the newest of that name). */
export function matchAttachment(ref: MediaRef, attachments: AttachmentData[]): AttachmentData | undefined {
  return (ref.id ? attachments.find((attachment) => attachment.mediaId === ref.id) : undefined) ?? [...attachments].reverse().find((attachment) => attachment.filename === ref.name);
}

async function download(attachment: AttachmentData, jiraBase: string, getCredentials: () => Promise<Credentials>): Promise<Uint8Array | null> {
  const path = mediaCachePath(attachment.id);
  if (existsSync(path)) return new Uint8Array(await Bun.file(path).arrayBuffer());
  try {
    const response = await fetch(`${jiraBase}/rest/api/3/attachment/content/${attachment.id}`, {
      headers: { Authorization: makeAuthHeader(await getCredentials()) },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!pngSize(bytes)) return null;
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(`${path}.part`, bytes);
    renameSync(`${path}.part`, path);
    return bytes;
  } catch {
    return null;
  }
}

async function resolve(ref: MediaRef, options: MediaOptions): Promise<Entry | undefined> {
  const attachment = matchAttachment(ref, options.attachments);
  if (!attachment) return undefined;
  const size = formatBytes(attachment.size);
  const name = /[^\w.-]/.test(attachment.filename) ? `'${attachment.filename.replaceAll("'", "'\\''")}'` : attachment.filename;
  const fetchHint = options.key ? `tik get ${options.key} ${name}` : "";
  const hint = (extra: string) => [size, extra, fetchHint].filter(Boolean).join(" · ");
  if (!options.images || attachment.mimeType !== "image/png") return { note: hint("") };
  if (attachment.size > (options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES)) return { note: hint("too large") };
  const png = await download(attachment, options.jiraBase, options.getCredentials);
  const dimensions = png ? pngSize(png) : null;
  if (!png || !dimensions) return { note: hint("(download failed)") };
  return { note: size, png, size: dimensions };
}

/** Looks up every media node's attachment, and fetches the PNGs to show, in parallel before the render. */
export async function createMediaProvider(refs: MediaRef[], options: MediaOptions): Promise<ImageProvider> {
  const entries = new Map<string, Entry>();
  await Promise.all(
    [...new Map(refs.map((ref) => [refKey(ref), ref])).values()].map(async (ref) => {
      const entry = await resolve(ref, options);
      if (entry) entries.set(refKey(ref), entry);
    })
  );
  const maxRows = options.maxRows ?? DEFAULT_MAX_IMAGE_ROWS;
  return {
    render(ref, width) {
      const entry = entries.get(refKey(ref));
      if (!entry) return undefined;
      if (!entry.png || !entry.size) return { suffix: entry.note };
      const { cols, rows } = imageCells(entry.size, ref.widthPct, width, maxRows);
      return { lines: imageLines(placementSequence(entry.png, cols, rows, options.tmux), rows) };
    },
  };
}
