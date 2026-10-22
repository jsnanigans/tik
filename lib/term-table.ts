import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { type Painter, type Style, type Theme, BAR } from "./term-style";

export type TableCell = {
  header: boolean;
  colspan: number;
  rowspan: number;
  align?: "left" | "center" | "right";
  /** Lines of the cell content at `width`, drawn over `base`. */
  render: (width: number, base: Style) => string[];
  base?: Style;
};

export type TableInput = {
  rows: TableCell[][];
  width: number;
  numbered: boolean;
  /** Relative column widths, used when the natural widths do not fit. */
  hints?: number[];
  painter: Painter;
  theme: Theme;
};

type Placed = { cell: TableCell; row: number; col: number; span: number; rows: number; lines: string[] };

const HEADER_BG: Record<Theme, string> = { dark: "#2f3b52", light: "#e3e8f2" };
export const headerStyle = (theme: Theme): Style => ({ bold: true, bg: HEADER_BG[theme] });
const MAX_MIN_WIDTH = 15;
const MEASURE_WIDTH = 1000;
const STACK_BELOW = 40;
const NO_STYLE: Style = {};

const pad = (line: string, width: number, base: Style, painter: Painter, align?: TableCell["align"]) => {
  const room = Math.max(0, width - stringWidth(line));
  const fill = (n: number) => (n > 0 ? painter.paint(" ".repeat(n), base) : "");
  if (align === "right") return fill(room) + line;
  if (align === "center") return fill(Math.floor(room / 2)) + line + fill(room - Math.floor(room / 2));
  return line + fill(room);
};

function topUp(widths: number[], caps: number[], room: number): void {
  while (room > 0) {
    let moved = false;
    for (let c = 0; c < widths.length && room > 0; c++) {
      if (widths[c] < caps[c]) {
        widths[c]++;
        room--;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

function place(rows: TableCell[][]): { placed: Placed[]; cols: number } {
  const occupied: boolean[][] = [];
  const placed: Placed[] = [];
  let cols = 0;
  rows.forEach((cells, row) => {
    let col = 0;
    for (const cell of cells) {
      while (occupied[row]?.[col]) col++;
      const span = Math.max(1, cell.colspan);
      const height = Math.max(1, Math.min(cell.rowspan, rows.length - row));
      for (let r = row; r < row + height; r++) for (let c = col; c < col + span; c++) (occupied[r] ??= [])[c] = true;
      placed.push({ cell, row, col, span, rows: height, lines: [] });
      col += span;
      cols = Math.max(cols, col);
    }
  });
  return { placed, cols };
}

function columnWidths(placed: Placed[], cols: number, avail: number, hints?: number[]): number[] | null {
  const min = new Array<number>(cols).fill(1);
  const max = new Array<number>(cols).fill(1);
  for (const { cell, col, span } of placed) {
    if (span !== 1) continue;
    const lines = cell.render(MEASURE_WIDTH, NO_STYLE).map(stripAnsi);
    max[col] = Math.max(max[col], ...lines.map((line) => stringWidth(line)));
    const word = Math.max(1, ...lines.flatMap((line) => line.split(/\s+/).map((word) => stringWidth(word))));
    min[col] = Math.max(min[col], Math.min(word, MAX_MIN_WIDTH));
  }
  const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
  max.forEach((value, c) => (max[c] = Math.max(value, min[c])));
  if (total(max) <= avail) return max;
  if (total(min) > avail) return null;
  const hinted = hints && hints.length === cols && total(hints) > 0 ? hints : null;
  if (hinted) {
    const desired = hinted.map((hint, c) => Math.max(min[c], Math.floor((avail * hint) / total(hinted))));
    if (total(desired) <= avail) {
      topUp(desired, max, avail - total(desired));
      return desired.map((value, c) => Math.min(value, Math.max(max[c], min[c])));
    }
  }
  const widths = [...min];
  topUp(widths, max, avail - total(widths));
  return widths;
}

/** One `Label: value` block per body row, for a table whose columns cannot fit. */
function stacked(rows: TableCell[][], headerRow: boolean, input: TableInput): string[] {
  const { painter, width } = input;
  const [head, ...body] = headerRow ? rows : [[], ...rows];
  const labelCap = Math.max(1, Math.floor(width / 3) - 2);
  const out: string[] = [];
  body.forEach((row, index) => {
    if (index > 0) out.push(painter.paint("┈".repeat(width), { dim: true }));
    row.forEach((cell, c) => {
      const text = head[c] ? stripAnsi(head[c].render(MEASURE_WIDTH, NO_STYLE).join(" ")).trim().slice(0, labelCap) : "";
      const label = text ? `${text}: ` : "";
      const labelWidth = stringWidth(label);
      const lines = cell.render(Math.max(1, width - labelWidth), cell.base ?? NO_STYLE);
      if (lines.length === 0) out.push(painter.paint(label, { dim: true }));
      lines.forEach((line, i) => out.push((i === 0 ? painter.paint(label, { dim: true }) : " ".repeat(labelWidth)) + line));
    });
  });
  return out;
}

export function renderTable(input: TableInput): string[] {
  const { painter, theme } = input;
  const rows = input.rows.filter((row) => row.length > 0);
  if (rows.length === 0) return [];
  const headerRow = rows[0].every((cell) => cell.header);
  const model = input.numbered
    ? rows.map((row, r): TableCell[] => [
        {
          header: headerRow && r === 0,
          colspan: 1,
          rowspan: 1,
          align: "right",
          base: headerRow && r === 0 ? headerStyle(theme) : undefined,
          render: () => (headerRow && r === 0 ? [""] : [String(r + (headerRow ? 0 : 1))]),
        },
        ...row,
      ])
    : rows;
  const { placed, cols } = place(model);
  const avail = input.width - (cols + 1) - 2 * cols;
  const hints = input.hints && input.numbered ? [1, ...input.hints] : input.hints;
  const widths = input.width < STACK_BELOW ? null : columnWidths(placed, cols, avail, hints);
  if (!widths) return stacked(model, headerRow, input);

  const spanWidth = (p: Placed) => widths.slice(p.col, p.col + p.span).reduce((sum, w) => sum + w, 0) + 3 * (p.span - 1);
  for (const p of placed) p.lines = p.cell.render(spanWidth(p), p.cell.base ?? NO_STYLE);

  const heights = model.map((_, r) => Math.max(1, ...placed.filter((p) => p.row === r && p.rows === 1).map((p) => p.lines.length)));
  for (const p of placed.filter((p) => p.rows > 1)) {
    const have = heights.slice(p.row, p.row + p.rows).reduce((sum, h) => sum + h, 0);
    heights[p.row + p.rows - 1] += Math.max(0, p.lines.length - have);
  }

  const border = (style: Style = { fg: BAR }) => (text: string) => painter.paint(text, style);
  const dim = border();
  const rule = (left: string, mid: string, right: string) =>
    dim(left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right);
  const out = [rule("┌", "┬", "┐")];

  model.forEach((_, r) => {
    const starting = placed.filter((p) => p.row <= r && r < p.row + p.rows).sort((a, b) => a.col - b.col);
    for (let line = 0; line < heights[r]; line++) {
      const offset = (p: Placed) => heights.slice(p.row, r).reduce((sum, h) => sum + h, 0) + line;
      const cells = starting.map((p) => {
        const base = p.cell.base ?? NO_STYLE;
        const content = pad(p.lines[offset(p)] ?? "", spanWidth(p), base, painter, p.cell.align);
        const gap = painter.paint(" ", base);
        return gap + content + gap;
      });
      out.push(dim("│") + cells.join(dim("│")) + dim("│"));
    }
    const crossed = placed.some((p) => p.row <= r && r + 1 < p.row + p.rows);
    if (r < model.length - 1 && !crossed && r === 0 && headerRow) out.push(rule("├", "┼", "┤"));
  });
  out.push(rule("└", "┴", "┘"));
  return out;
}
