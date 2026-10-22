import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { renderAdf, renderMarkdownText, type RenderOptions } from "./term-render";
import { clampContrast, contrast, parseHex } from "./term-style";
import { encodePlaceholder, type AdfNode } from "./markdown";

const plain: Partial<RenderOptions> = { width: 40, color: "none", links: false };
const text = (markdown: string, options: Partial<RenderOptions> = {}) => renderMarkdownText(markdown, { ...plain, ...options }).join("\n");
const ansi = (markdown: string, options: Partial<RenderOptions> = {}) => text(markdown, { color: "truecolor", ...options });
const visible = (value: string) => stripAnsi(value.replace(/\x1b\]8;;[^\x07]*\x07/g, ""));

const heading = (level: number, content: string): AdfNode => ({ type: "heading", attrs: { level }, content: [{ type: "text", text: content }] });
const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", version: 1, content } as AdfNode);

describe("constructs", () => {
  test.each([
    ["paragraph wraps at the width", "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii", "aaaa bbbb cccc dddd eeee ffff gggg hhhh\niiii"],
    ["h1 has a rule", "# Title", "Title\n═════"],
    ["h2 has a rule", "## Title", "Title\n─────"],
    ["h3 has none", "### Title", "Title"],
    ["inline marks", "**b** _i_ ~~s~~ `c`", "b i s c"],
    ["link without a terminal shows its url", "[docs](https://x.y/a)", "docs (https://x.y/a)"],
    ["autolink shows the url once", "<https://x.y/a>", "https://x.y/a"],
    ["bullets by depth", "- a\n  - b\n    - c", "• a\n  ◦ b\n    ‣ c"],
    ["ordered keeps the start and aligns", "9. a\n10. b", " 9. a\n10. b"],
    ["task list", "- [ ] a\n- [x] b", "[ ] a\n[x] b"],
    ["blockquote", "> q", "▎ q"],
    ["rule", "---", "─".repeat(40)],
    ["code block with a language", "```ts\nlet a\n```", `${" ".repeat(37)}ts\n let a`],
    ["panel", ":::panel{type=warning}\nwatch out\n:::", "▎ ▲ watch out"],
    ["custom panel icon", ":::panel{type=custom color=#ff0000 iconText=★}\nx\n:::", "▎ ★ x"],
    ["expand", "::::expand{title=More}\nbody\n::::", "▾ More\n│ body"],
    ["status pill", "a :status[in progress]{color=blue}", "a [IN PROGRESS]"],
    ["mention, date, emoji", ":mention[Ann] :date[2026-11-03] :emoji[:x:]{text=✅}", "@Ann 2026-11-03 ✅"],
    ["sup and sub", "x:span[2]{sup} H:span[2]{sub}O", "x² H₂O"],
    ["sup without a glyph", ":span[q]{sup}", "^(q)"],
    ["hard break", "a\\\nb", "a\nb"],
    ["card", "::card[https://x.y]{appearance=embed}", `╭${"─".repeat(21)}╮\n│ → https://x.y embed │\n╰${"─".repeat(21)}╯`],
    ["macro label", "::macro{key=toc type=com.x}", "⟨macro toc⟩"],
    ["media placeholder", "::media[shot.png]{_id=1 type=file}", "▣ shot.png"],
    ["video placeholder", "::media[clip.mov]{_id=1 type=file}", "► clip.mov"],
    ["unknown directive keeps its children", ":::foo{adf='{}'}\nkept\n:::", "‹foo›\nkept"],
    ["prose colon is not a directive", "see:foo and 10:30", "see:foo and 10:30"],
  ])("%s", (_name, markdown, expected) => {
    expect(text(markdown)).toBe(expected);
  });

  test("media placeholder from the display markdown", () => {
    const placeholder = encodePlaceholder({ type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "1", type: "file", alt: "a.png" } }] });
    expect(text(`before\n\n${placeholder}\n\nafter`)).toBe("before\n\n▣ a.png\n\nafter");
  });

  test("task items and placeholders written as generic nodes", () => {
    const item = (state: string, text: string): AdfNode => ({ type: "taskItem", attrs: { localId: "1", state }, content: [{ type: "text", text }] });
    const tasks = { type: "taskList", attrs: { localId: "2" }, content: [item("DONE", "a"), item("TODO", "b")] } as AdfNode;
    const placeholder = { type: "paragraph", content: [{ type: "placeholder", attrs: { text: "Type here" } }] } as AdfNode;
    expect(renderAdf(doc(tasks, placeholder), plain).join("\n")).toBe("[x] a\n[ ] b\n\nType here");
  });

  test("an unknown node renders its text and never throws", () => {
    expect(visible(renderAdf(doc({ type: "mystery", content: [{ type: "paragraph", content: [{ type: "text", text: "inside" }] }] } as AdfNode), plain).join("\n"))).toContain("inside");
  });
});

describe("layout", () => {
  test("a nested list hangs its wrapped lines", () => {
    expect(text("- aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii")).toBe("• aaaa bbbb cccc dddd eeee ffff gggg\n  hhhh iiii");
  });

  test("a quote around a panel nests the prefixes", () => {
    expect(text("> :::panel{type=info}\n> x\n> :::")).toBe("▎ ▎ ⓘ x");
  });

  test("no line is wider than the width, including CJK and emoji", () => {
    const lines = renderMarkdownText("日本語のテキストが折り返されます 😀😀😀😀 and some more latin text to wrap", plain);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });

  test("layout columns sit side by side from 100 columns and stack below", () => {
    const markdown = "::::layout\n:::column{width=50}\nleft\n:::\n:::column{width=50}\nright\n:::\n::::";
    expect(text(markdown, { width: 100 })).toBe(`left${" ".repeat(44)} │ right`);
    expect(text(markdown, { width: 60 })).toContain("┈");
  });

  test("marks align and indent", () => {
    expect(text(":::marks{align=center}\nab\n:::", { width: 10 })).toBe("    ab");
    expect(text(":::marks{indent=1}\nab\n:::")).toBe("  ab");
  });
});

describe("tables", () => {
  test("box drawing with a header rule", () => {
    expect(text("| a | b |\n| - | - |\n| 1 | 2 |")).toBe("┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ 1 │ 2 │\n└───┴───┘");
  });

  test("colspan, rowspan and block content in cells", () => {
    const markdown = ":::::table\n::::row\n:::cell{colspan=2}\nwide\n:::\n::::\n::::row\n:::cell{rowspan=2}\ntall\n:::\n:::cell\n- x\n:::\n::::\n::::row\n:::cell\nlast\n:::\n::::\n:::::";
    const lines = text(markdown).split("\n");
    expect(lines[1]).toBe("│ wide        │");
    expect(lines.join("\n")).toContain("• x");
    for (const line of lines) expect(stringWidth(line)).toBe(stringWidth(lines[0]));
  });

  test("an expand and a list nest in a cell", () => {
    const markdown = ":::::table\n::::row\n:::cell\n:::::expand{title=More}\n- x\n:::::\n:::\n::::\n:::::";
    expect(text(markdown)).toContain("│ ▾ More");
  });

  test("colwidths split a table that does not fit", () => {
    const long = "word ".repeat(12).trim();
    const rows = `| a | b |\n| - | - |\n| ${long} | ${long} |`;
    const equal = text(rows).split("\n")[0];
    const weighted = text(`:::table{colwidths=100,300}\n${rows}\n:::`).split("\n")[0];
    expect(equal.indexOf("┬")).toBeGreaterThan(weighted.indexOf("┬"));
  });

  test("shrinks wide columns to fit and keeps the borders aligned", () => {
    const lines = renderMarkdownText(`| name | note |\n| - | - |\n| a | ${"word ".repeat(30)} |`, plain);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40);
    expect(new Set(lines.map((line) => stringWidth(line))).size).toBe(1);
  });

  test("falls back to labelled rows when it cannot fit", () => {
    expect(text("| name | note |\n| - | - |\n| a | b |", { width: 30 })).toBe("name: a\nnote: b");
  });

  test("a numbered column", () => {
    expect(text(":::::table{numbered}\n::::row\n:::cell{header}\nh\n:::\n::::\n::::row\n:::cell\nv\n:::\n::::\n:::::")).toContain("│ 1 │ v │");
  });

  test("emoji and CJK cells keep the borders aligned", () => {
    const lines = renderMarkdownText("| a | b |\n| - | - |\n| 日本 | 😀 |", plain);
    expect(new Set(lines.map((line) => stringWidth(line))).size).toBe(1);
  });
});

describe("styling", () => {
  test("plain mode has no escape bytes", () => {
    expect(text("# T\n\n**b** [l](https://x.y) `c` :status[ok]{color=green}\n\n> q")).not.toContain("\x1b");
  });

  test("a status pill has a background", () => {
    expect(ansi("a :status[done]{color=green}")).toContain("48;2;227;252;239");
  });

  test("links are OSC 8 hyperlinks on a terminal", () => {
    expect(ansi("[docs](https://x.y/a)", { links: true })).toContain("\x1b]8;;https://x.y/a\x07");
  });

  test("control characters in the text and the url are dropped", () => {
    expect(ansi("a\x1b[31mred\x07", { links: true })).not.toContain("\x1b[31m");
    const link = { type: "link", attrs: { href: "https://x.y/\x07\x1b]8;;evil" } };
    const linked = doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [link] }] } as AdfNode);
    expect(renderAdf(linked, { ...plain, color: "truecolor", links: true }).join("").match(/\x1b\]8;;/g)).toHaveLength(2);
  });

  test("a dark span color is lifted on a dark terminal", () => {
    const rendered = ansi(":span[dark]{color=#172b4d}");
    const [r, g, b] = rendered.match(/38;2;(\d+);(\d+);(\d+)/)!.slice(1).map(Number);
    expect(contrast([r, g, b], [28, 28, 28])).toBeGreaterThanOrEqual(4.5);
  });

  test("clampContrast keeps the hue family and lightens or darkens", () => {
    const fg = parseHex("#172b4d")!;
    expect(clampContrast(fg, [28, 28, 28])[2]).toBeGreaterThan(fg[2]);
    expect(clampContrast([250, 250, 200], [255, 255, 255])[0]).toBeLessThan(250);
  });

  test("a span background gets a readable foreground", () => {
    expect(ansi(":span[x]{bg=#ffffe0}")).toContain("38;2;23;43;77");
  });

  test("color depth falls back to 256 and 16", () => {
    expect(ansi("a :status[x]{color=red}", { color: "256" })).toMatch(/48;5;\d+/);
    expect(ansi("a :status[x]{color=red}", { color: "16" })).toContain("\x1b[1;47;31m");
  });
});

describe("renderAdf", () => {
  test("renders from the ADF without the markdown round trip", () => {
    expect(visible(renderAdf(doc(heading(3, "T"), { type: "paragraph", content: [{ type: "text", text: "x" }] }), plain).join("\n"))).toBe("T\n\nx");
  });

  test("raw nodes of the codec, an inline card and a media placeholder, render", () => {
    const card = { type: "inlineCard", attrs: { url: "https://x.y/z" } };
    const media = { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "1", type: "file", alt: "a.png" } }] };
    expect(renderAdf(doc({ type: "paragraph", content: [{ type: "text", text: "see " }, card] } as AdfNode, media as AdfNode), plain).join("\n")).toBe("see https://x.y/z\n\n▣ a.png");
  });

  test("a heading with an extra attribute falls back to its text", () => {
    const lines = renderAdf(doc({ type: "heading", attrs: { level: 2, extra: 1 }, content: [{ type: "text", text: "H" }] } as AdfNode), plain);
    expect(lines.join("\n")).toContain("H");
  });
});
