import { mkdirSync } from "fs";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { renderAdf } from "../lib/term-render";
import type { AdfNode } from "../lib/markdown";
import { commentFields, confluenceFields, jiraFields, type Field } from "./fields";

const WIDTH = 100;
const NARROW = 40;
const LEAK = /:[A-Za-z]+\[|tikmedia:/g;
const EXAMPLES = 5;

const OSC = /\x1b\]8;;[^\x07]*\x07/g;
const visible = (line: string) => stripAnsi(line.replace(OSC, ""));

const pct = (n: number, total: number) => (total === 0 ? 0 : Math.round((n / total) * 10000) / 100);
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

function evaluate(fields: Iterable<Field>) {
  const times: number[] = [];
  const problems = { throws: [] as string[], overWidth: [] as string[], narrowOverWidth: [] as string[], leaks: [] as string[], plainEscapes: [] as string[] };
  let tested = 0;
  for (const { label, adf } of fields) {
    if (adf?.type !== "doc") continue;
    tested++;
    try {
      const started = performance.now();
      const lines = renderAdf(adf as AdfNode, { width: WIDTH, color: "truecolor", links: true });
      times.push(performance.now() - started);
      if (lines.some((line) => stringWidth(line) > WIDTH)) problems.overWidth.push(label);
      const source = JSON.stringify(adf);
      const leaked = lines.flatMap((line) => visible(line).match(LEAK) ?? []).filter((text) => !source.includes(text));
      if (leaked.length > 0) problems.leaks.push(`${label} ${leaked[0]}`);
      if (renderAdf(adf as AdfNode, { width: NARROW, color: "truecolor", links: true }).some((line) => stringWidth(line) > NARROW)) problems.narrowOverWidth.push(label);
      if (renderAdf(adf as AdfNode, { width: WIDTH, color: "none", links: false }).some((line) => line.includes("\x1b"))) problems.plainEscapes.push(label);
    } catch (error) {
      problems.throws.push(`${label}: ${error instanceof Error ? error.message : error}`);
    }
  }
  times.sort((a, b) => a - b);
  return {
    tested,
    throws: problems.throws.length,
    overWidth: problems.overWidth.length,
    narrowOverWidth: problems.narrowOverWidth.length,
    leaks: problems.leaks.length,
    plainEscapes: problems.plainEscapes.length,
    p50Ms: Math.round(percentile(times, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(times, 0.95) * 100) / 100,
    maxMs: Math.round((times.at(-1) ?? 0) * 100) / 100,
    okRate: pct(tested - new Set(Object.values(problems).flat().map((entry) => entry.split(/[: ]/)[0])).size, tested),
    examples: Object.fromEntries(Object.entries(problems).map(([name, labels]) => [name, labels.slice(0, EXAMPLES)])),
  };
}

const started = performance.now();
const sources: Record<string, Iterable<Field> | null> = { jira: jiraFields(), confluence: await confluenceFields(), comments: await commentFields() };
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), width: WIDTH, sources: {} };
for (const [name, fields] of Object.entries(sources)) {
  if (!fields) {
    console.log(`${name}: no samples (run eval/fetch-samples.ts)`);
    continue;
  }
  const result = evaluate(fields);
  (report.sources as Record<string, unknown>)[name] = result;
  console.log(
    `${name}: ${result.tested} tested, throws ${result.throws}, over width ${result.overWidth} (at ${NARROW}: ${result.narrowOverWidth}), ` +
      `leaks ${result.leaks}, plain escapes ${result.plainEscapes}, p50 ${result.p50Ms} ms, p95 ${result.p95Ms} ms, max ${result.maxMs} ms`
  );
  for (const [kind, labels] of Object.entries(result.examples)) if (labels.length > 0) console.log(`  ${kind}: ${labels.join("; ")}`);
}
report.seconds = Math.round((performance.now() - started) / 100) / 10;
const reportsDir = `${import.meta.dir}/../reports`;
mkdirSync(reportsDir, { recursive: true });
const path = `${reportsDir}/render-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
console.log(`${report.seconds}s, report: ${path}`);
