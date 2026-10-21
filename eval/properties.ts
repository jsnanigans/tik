import { adfToEditMarkdown, markdownToAdf } from "../lib/adf-codec";
import { constructs, equivalent, lostConstructs, reconcile } from "../lib/adf-reconcile";
import type { AdfNode } from "../lib/markdown";

type Field = { label: string; adf: AdfNode };
type Check = { label: string; ok: boolean };

const SAMPLE_SIZE = 500;
const GUARDED = ["panel", "table"];
const MERGING_BLOCKS = new Set(["bulletList", "orderedList", "taskList", "blockquote"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isEmptyParagraph = (block: AdfNode) => block.type === "paragraph" && !block.content?.length;
const doc = (content: AdfNode[]): AdfNode => ({ type: "doc", content });
const inserted: AdfNode = { type: "paragraph", content: [{ type: "text", text: "Inserted paragraph" }] };

/** Blocks without the trailing empty paragraphs, which the equivalence ignores. */
function blocksOf(adf: AdfNode): AdfNode[] {
  const blocks = [...(adf.content ?? [])];
  while (blocks.length > 0 && isEmptyParagraph(blocks[blocks.length - 1])) blocks.pop();
  return blocks;
}

/** Edits `edited` as a user would in markdown: writes it out, reads it back, reconciles with the original. */
const apply = (original: AdfNode, edited: AdfNode) => reconcile(original, markdownToAdf(adfToEditMarkdown(edited))).doc;

/** Fields that together cover every node type, mark type and attribute, filled up with an even spread. */
function pickSample(fields: Field[]): Field[] {
  const seen = new Set<string>();
  const sample = new Set<Field>();
  for (const field of fields) {
    const keys = [...constructs(field.adf).keys()];
    if (keys.some((key) => !seen.has(key))) {
      keys.forEach((key) => seen.add(key));
      sample.add(field);
    }
  }
  const stride = Math.max(1, Math.floor(fields.length / Math.max(1, SAMPLE_SIZE - sample.size)));
  for (let i = 0; i < fields.length && sample.size < SAMPLE_SIZE; i += stride) sample.add(fields[i]);
  return [...sample];
}

function withEditedSentence(adf: AdfNode): { edited: AdfNode; index: number } | null {
  const blocks = blocksOf(adf);
  const index = blocks.findIndex(
    (block) => (block.type === "paragraph" || block.type === "heading") && !block.marks && block.content?.some((run) => run.type === "text")
  );
  if (index === -1) return null;
  const edited = structuredClone(doc(blocks));
  const run = edited.content![index].content!.find((child) => child.type === "text")!;
  run.text += " (edited)";
  return { edited, index };
}

function insertionPoint(blocks: AdfNode[]): number {
  for (let index = 1; index < blocks.length - 1; index++) {
    const [before, after] = [blocks[index - 1].type, blocks[index + 1].type];
    if (before !== after || !MERGING_BLOCKS.has(before)) return index;
  }
  return -1;
}

function checkField({ label, adf }: Field): Record<string, Check | undefined> {
  const blocks = blocksOf(adf);
  const checks: Record<string, Check | undefined> = {};
  const check = (name: string, ok: boolean) => (checks[name] = { label, ok });

  check("noOpIdentity", same(apply(adf, adf), adf));

  const sentence = withEditedSentence(adf);
  if (sentence) {
    const result = apply(adf, sentence.edited);
    const resultBlocks = blocksOf(result);
    const othersIdentical =
      resultBlocks.length === blocks.length &&
      blocks.every((block, i) => i === sentence.index || same(resultBlocks[i], block));
    const editApplied = equivalent(resultBlocks[sentence.index] ?? {}, sentence.edited.content![sentence.index]);
    check("singleSentenceEdit", othersIdentical && editApplied);
    check("guardQuietWhenKept", lostConstructs(adf, result).length === 0);
  }

  const index = insertionPoint(blocks);
  if (index !== -1) {
    const removed = apply(adf, doc(blocks.filter((_, i) => i !== index)));
    const expected = blocks.filter((_, i) => i !== index);
    check("deleteBlock", same(blocksOf(removed), expected));

    const added = blocksOf(apply(adf, doc([...blocks.slice(0, index), inserted, ...blocks.slice(index)])));
    check(
      "insertBlock",
      added.length === blocks.length + 1 &&
        added.every((block, i) => (i === index ? equivalent(block, inserted) : same(block, blocks[i - (i > index ? 1 : 0)])))
    );
  }

  for (const construct of GUARDED) {
    if (!constructs(adf).has(construct)) continue;
    const without = doc(blocks.filter((block) => !constructs(block).has(construct)));
    check(`guardFiresWhenDropped:${construct}`, lostConstructs(adf, apply(adf, without)).includes(construct));
  }
  return checks;
}

export function checkProperties(fields: Field[]) {
  const sample = pickSample(fields);
  const totals = new Map<string, { tested: number; passed: number; failures: string[] }>();
  for (const field of sample) {
    for (const [name, result] of Object.entries(checkField(field))) {
      if (!result) continue;
      const total = totals.get(name) ?? { tested: 0, passed: 0, failures: [] };
      total.tested++;
      if (result.ok) total.passed++;
      else if (total.failures.length < 5) total.failures.push(result.label);
      totals.set(name, total);
    }
  }
  return {
    sampled: sample.length,
    checks: Object.fromEntries(
      [...totals].map(([name, { tested, passed, failures }]) => [
        name,
        { tested, passed, rate: Math.round((passed / tested) * 10000) / 100, failures },
      ])
    ),
  };
}
