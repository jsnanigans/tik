import { mkdirSync } from "fs";
import Ajv from "ajv";
import { constructs, equivalent, reconcile } from "../lib/adf-reconcile";
import { adfToEditMarkdown, markdownToAdf } from "../lib/adf-codec";
import type { AdfNode } from "../lib/markdown";
import { checkProperties } from "./properties";
import { commentFields, confluenceFields, jiraFields, type Field } from "./fields";

const toMarkdown = adfToEditMarkdown;
const toAdf = markdownToAdf;

// Readable: no placeholder and no generic directive (`adf=` / `marks=` attributes).
const GENERIC_RE = /\]\(tikmedia:|:+([A-Za-z]+)(?:\[[^\n]*?\])?\{[^}\n]*\b(?:adf|marks)=/g;
const genericUses = (markdown: string) => [...new Set([...markdown.matchAll(GENERIC_RE)].map((match) => match[1] ?? "placeholder"))];
const TOP_DIFFS = 15;
const CRASH_EXAMPLES = 5;

type Outcome = { exact: boolean; readable: boolean; idempotent: boolean; valid: boolean; noOp: boolean; crash?: string; diffs: string[]; generic: string[] };

const ajv = new Ajv({ schemaId: "auto", extendRefs: true });
ajv.addMetaSchema(await Bun.file(require.resolve("ajv/lib/refs/json-schema-draft-04.json")).json());
const validate = ajv.compile(await Bun.file(`${import.meta.dir}/adf-schema-full.json`).json());

function differingConstructs(original: AdfNode, result: AdfNode): string[] {
  const before = constructs(original);
  const after = constructs(result);
  const diffs = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));
  return diffs.length > 0 ? diffs : ["same counts, different order or values"];
}

function roundTrip(adf: AdfNode): Outcome {
  const outcome: Outcome = { exact: false, readable: false, idempotent: false, valid: false, noOp: false, diffs: [], generic: [] };
  try {
    const markdown = toMarkdown(adf);
    const once = toAdf(markdown);
    const twice = toAdf(toMarkdown(once));
    outcome.exact = equivalent(adf, once);
    outcome.generic = genericUses(markdown);
    outcome.readable = outcome.exact && outcome.generic.length === 0;
    outcome.idempotent = equivalent(once, twice);
    outcome.noOp = JSON.stringify(reconcile(adf, once).doc) === JSON.stringify(adf);
    outcome.valid = validate(once) as boolean;
    if (!outcome.exact) outcome.diffs = differingConstructs(adf, once);
  } catch (err) {
    outcome.crash = err instanceof Error ? err.message : String(err);
  }
  return outcome;
}

const pct = (n: number, total: number) => (total === 0 ? 0 : Math.round((n / total) * 10000) / 100);

function evaluate(fields: Iterable<Field>) {
  let tested = 0;
  let exact = 0;
  let readable = 0;
  let idempotent = 0;
  let valid = 0;
  let noOp = 0;
  let originalValid = 0;
  let skipped = 0;
  const crashes: { field: string; error: string }[] = [];
  const diffs = new Map<string, { fields: number; example: string }>();
  const generic = new Map<string, { fields: number; example: string }>();
  for (const { label, adf } of fields) {
    if (adf?.type !== "doc") {
      skipped++;
      continue;
    }
    tested++;
    if (validate(adf)) originalValid++;
    const outcome = roundTrip(adf);
    if (outcome.crash !== undefined) {
      crashes.push({ field: label, error: outcome.crash });
      continue;
    }
    if (outcome.exact) exact++;
    if (outcome.readable) readable++;
    if (outcome.idempotent) idempotent++;
    if (outcome.valid) valid++;
    if (outcome.noOp) noOp++;
    for (const [counts, names] of [[diffs, outcome.diffs], [generic, outcome.generic]] as const) {
      for (const name of names) {
        const entry = counts.get(name) ?? { fields: 0, example: label };
        entry.fields++;
        counts.set(name, entry);
      }
    }
  }
  const top = (counts: typeof diffs) =>
    [...counts]
      .sort((a, b) => b[1].fields - a[1].fields)
      .slice(0, TOP_DIFFS)
      .map(([construct, { fields, example }]) => ({ construct, fields, example }));
  return {
    tested,
    skipped,
    exactRate: pct(exact, tested),
    readableRate: pct(readable, tested),
    idempotenceRate: pct(idempotent, tested),
    schemaValidRate: pct(valid, tested),
    noOpIdentityRate: pct(noOp, tested),
    originalSchemaValidRate: pct(originalValid, tested),
    crashes: crashes.length,
    crashExamples: crashes.slice(0, CRASH_EXAMPLES),
    topDiffs: top(diffs),
    genericUses: top(generic),
  };
}

const started = performance.now();
const sources: Record<string, Iterable<Field> | null> = {
  jira: jiraFields(),
  confluence: await confluenceFields(),
  comments: await commentFields(),
};

const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), sources: {} };
for (const [name, fields] of Object.entries(sources)) {
  if (!fields) {
    console.log(`${name}: no samples (run eval/fetch-samples.ts)`);
    continue;
  }
  const result = evaluate(fields);
  (report.sources as Record<string, unknown>)[name] = result;
  console.log(
    `${name}: ${result.tested} tested, exact ${result.exactRate}%, readable ${result.readableRate}%, ` +
      `idempotent ${result.idempotenceRate}%, schema-valid ${result.schemaValidRate}% (originals ${result.originalSchemaValidRate}%), no-op identity ${result.noOpIdentityRate}%, ` +
      `crashes ${result.crashes}, skipped ${result.skipped}`
  );
  for (const crash of result.crashExamples) console.log(`  crash ${crash.field}: ${crash.error}`);
  for (const diff of result.topDiffs) console.log(`  ${String(diff.fields).padStart(6)}  ${diff.construct}  (${diff.example})`);
  for (const use of result.genericUses) console.log(`  ${String(use.fields).padStart(6)}  generic ${use.construct}  (${use.example})`);
}

const sampleSources = [...jiraFields(), ...((await confluenceFields()) ?? []), ...((await commentFields()) ?? [])];
const properties = checkProperties(sampleSources.filter((field) => field.adf?.type === "doc"));
report.properties = properties;
console.log(`properties (sample of ${properties.sampled}):`);
for (const [name, { tested, passed, rate, failures }] of Object.entries(properties.checks)) {
  console.log(`  ${name}: ${passed}/${tested} (${rate}%)${failures.length > 0 ? `  e.g. ${failures.join(", ")}` : ""}`);
}

report.seconds = Math.round((performance.now() - started) / 100) / 10;
const reportsDir = `${import.meta.dir}/../reports`;
mkdirSync(reportsDir, { recursive: true });
const path = `${reportsDir}/roundtrip-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
console.log(`${report.seconds}s, report: ${path}`);
