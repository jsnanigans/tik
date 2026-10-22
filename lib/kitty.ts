import { getCacheDir } from "./util";

export type ImageMode = "auto" | "on" | "off";
export type PngSize = { width: number; height: number };

const ESC = "\x1b";
const CHUNK_BYTES = 4096;
/** A terminal cell is about this many pixels. */
const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 16;
const MAX_WIDTH_SHARE = 0.8;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const mediaCachePath = (attachmentId: string) => `${getCacheDir()}/media/${attachmentId}.png`;

export function kittyDetected(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR || env.WEZTERM_EXECUTABLE || env.TERM_PROGRAM === "WezTerm" || /ghostty|kitty/.test(env.TERM ?? "")
  );
}

export function tmuxAllowsPassthrough(): boolean {
  try {
    const result = Bun.spawnSync(["tmux", "show", "-gv", "allow-passthrough"]);
    return result.exitCode === 0 && ["on", "all"].includes(result.stdout.toString().trim());
  } catch {
    return false;
  }
}

/** Images need a terminal and, inside tmux, passthrough; `auto` also needs a terminal known to speak the protocol. */
export function imagesEnabled(mode: ImageMode, env: Record<string, string | undefined> = process.env, isTTY = process.stdout.isTTY === true): boolean {
  if (mode === "off" || !isTTY) return false;
  if (mode === "auto" && !kittyDetected(env)) return false;
  return !env.TMUX || tmuxAllowsPassthrough();
}

/** Width and height from the IHDR chunk of a PNG, or null when the bytes are not one. */
export function pngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The `mediaSingle` width percent of `width`, else the natural size, capped by the width and `maxRows`. */
export function imageCells(size: PngSize, widthPct: number | undefined, width: number, maxRows: number): { cols: number; rows: number } {
  const wanted = widthPct ? Math.floor((width * widthPct) / 100) : Math.round(size.width / CELL_WIDTH_PX);
  const cols = Math.max(1, Math.min(wanted, Math.floor(width * MAX_WIDTH_SHARE)));
  const rows = Math.max(1, Math.round((cols * CELL_WIDTH_PX * size.height) / (size.width * CELL_HEIGHT_PX)));
  if (rows <= maxRows) return { cols, rows };
  return { cols: Math.max(1, Math.round((maxRows * CELL_HEIGHT_PX * size.width) / (size.height * CELL_WIDTH_PX))), rows: maxRows };
}

/** tmux forwards a wrapped sequence to the outer terminal, with its escapes doubled. */
export const wrapTmux = (sequence: string) => `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`;

/** Transmits and places a PNG at the cursor in `cols` x `rows` cells, leaving the cursor where it was. */
export function placementSequence(png: Uint8Array, cols: number, rows: number, tmux: boolean): string {
  const data = Buffer.from(png).toString("base64");
  const count = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
  return Array.from({ length: count }, (_, index) => {
    const more = index < count - 1 ? 1 : 0;
    const control = index === 0 ? `a=T,f=100,q=2,C=1,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    const sequence = `${ESC}_G${control};${data.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)}${ESC}\\`;
    return tmux ? wrapTmux(sequence) : sequence;
  }).join("");
}

/** The lines of an image block: the placement on the first line, then a blank (not empty, so it is kept) line for each row it covers. */
export const imageLines = (sequence: string, rows: number): string[] => [sequence, ...Array<string>(rows - 1).fill(" ")];
