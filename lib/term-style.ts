import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

export type ColorDepth = "truecolor" | "256" | "16" | "none";
export type Theme = "dark" | "light";
export type Style = { bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; fg?: string; bg?: string };
type Rgb = [number, number, number];

const ESC = "\x1b";
const MIN_CONTRAST = 4.5;
const PAGE_BG: Record<Theme, Rgb> = { dark: [28, 28, 28], light: [255, 255, 255] };

export const BLUE = "#4c9aff";
export const CYAN = "#00b8d9";
export const BAR = "#6b778c";
export const CODE_BG: Record<Theme, string> = { dark: "#2b2b2b", light: "#f1f2f4" };

/** Jira's subtle lozenge colors. */
export const STATUS: Record<string, { bg: string; fg: string }> = {
  neutral: { bg: "#dfe1e6", fg: "#42526e" },
  purple: { bg: "#eae6ff", fg: "#403294" },
  blue: { bg: "#deebff", fg: "#0747a6" },
  red: { bg: "#ffebe6", fg: "#bf2600" },
  yellow: { bg: "#fff0b3", fg: "#7a5200" },
  green: { bg: "#e3fcef", fg: "#006644" },
};

/** Glyphs are chosen so that `string-width` agrees with the terminal: it counts text-presentation symbols such as ℹ ✔ ⚠ ↗ ▶ as two cells. */
export const PANEL: Record<string, { icon: string; color: string }> = {
  info: { icon: "ⓘ", color: "#4c9aff" },
  note: { icon: "✎", color: "#998dd9" },
  success: { icon: "✓", color: "#36b37e" },
  warning: { icon: "▲", color: "#ffab00" },
  error: { icon: "✘", color: "#ff5630" },
};

export function detectColorDepth(env: Record<string, string | undefined>): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (env.TERM?.includes("256")) return "256";
  return "16";
}

/** `COLORFGBG` is `fg;bg` (or `fg;default;bg`) as ANSI color indexes; 7 and 9-15 are light backgrounds. */
export function detectTheme(env: Record<string, string | undefined>): Theme {
  const bg = Number(env.COLORFGBG?.split(";").pop());
  return bg === 7 || bg >= 9 ? "light" : "dark";
}

export function parseHex(hex: string | undefined): Rgb | null {
  const match = hex?.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

const luminance = ([r, g, b]: Rgb) => {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: Rgb): Rgb {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]: Rgb): Rgb {
  const hue = (p: number, q: number, t: number) => {
    const u = (t + 1) % 1;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) => Math.round(v * 255)) as Rgb;
}

/** Moves the lightness (not the hue) of `fg` toward the pole that contrasts more with `bg`, until the contrast passes. */
export function clampContrast(fg: Rgb, bg: Rgb): Rgb {
  if (contrast(fg, bg) >= MIN_CONTRAST) return fg;
  const toward = contrast([255, 255, 255], bg) >= contrast([0, 0, 0], bg) ? 1 : -1;
  const [h, s, l] = toHsl(fg);
  let current = fg;
  for (let step = 1; step <= 50; step++) {
    current = fromHsl([h, s, Math.min(1, Math.max(0, l + (toward * step) / 50))]);
    if (contrast(current, bg) >= MIN_CONTRAST) break;
  }
  return current;
}

/** The more readable of near-black and near-white over `bg`. */
export function readableOn(bg: Rgb): string {
  return contrast([255, 255, 255], bg) >= contrast([23, 43, 77], bg) ? "#ffffff" : "#172b4d";
}

const ANSI16: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];

const distance = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearestIndex = (rgb: Rgb, candidates: Rgb[]) =>
  candidates.reduce((best, candidate, index) => (distance(rgb, candidate) < distance(rgb, candidates[best]) ? index : best), 0);

function xterm256(rgb: Rgb): number {
  const cube = rgb.map((v) => CUBE.reduce((best, c, i) => (Math.abs(c - v) < Math.abs(CUBE[best] - v) ? i : best), 0));
  const cubeRgb = cube.map((i) => CUBE[i]) as Rgb;
  const gray = Math.min(23, Math.max(0, Math.round((rgb[0] + rgb[1] + rgb[2]) / 30 - 0.8)));
  const grayRgb: Rgb = [8 + gray * 10, 8 + gray * 10, 8 + gray * 10];
  return distance(rgb, grayRgb) < distance(rgb, cubeRgb) ? 232 + gray : 16 + 36 * cube[0] + 6 * cube[1] + cube[2];
}

function colorCode(rgb: Rgb, depth: ColorDepth, background: boolean): string {
  if (depth === "truecolor") return `${background ? 48 : 38};2;${rgb.join(";")}`;
  if (depth === "256") return `${background ? 48 : 38};5;${xterm256(rgb)}`;
  const index = nearestIndex(rgb, ANSI16);
  return String((index < 8 ? (background ? 40 : 30) : background ? 100 : 90) + (index % 8));
}

export type Painter = {
  depth: ColorDepth;
  theme: Theme;
  /** Opening SGR sequence of a style; empty when the style has nothing to show or color is off. */
  open: (style: Style) => string;
  /** `text` with the style opened before it and reset after it. */
  paint: (text: string, style: Style) => string;
};

export function createPainter(depth: ColorDepth, theme: Theme): Painter {
  const open = (style: Style): string => {
    if (depth === "none") return "";
    const codes: (string | number)[] = [];
    if (style.bold) codes.push(1);
    if (style.dim) codes.push(2);
    if (style.italic) codes.push(3);
    if (style.underline) codes.push(4);
    if (style.strike) codes.push(9);
    const bg = parseHex(style.bg);
    const fg = parseHex(style.fg);
    if (bg) codes.push(colorCode(bg, depth, true));
    if (fg) codes.push(colorCode(clampContrast(fg, bg ?? PAGE_BG[theme]), depth, false));
    return codes.length > 0 ? `${ESC}[${codes.join(";")}m` : "";
  };
  return {
    depth,
    theme,
    open,
    paint: (text, style) => {
      const prefix = open(style);
      return prefix ? `${prefix}${text}${ESC}[0m` : text;
    },
  };
}

export const hyperlink = (text: string, url: string) => `${ESC}]8;;${url}\x07${text}${ESC}]8;;\x07`;

/** Cells a styled string takes; `string-width` is slow, so plain ASCII, the common case, skips it. */
export function cellWidth(text: string): number {
  const plain = stripAnsi(text);
  return /^[\x20-\x7e]*$/.test(plain) ? plain.length : stringWidth(plain);
}
