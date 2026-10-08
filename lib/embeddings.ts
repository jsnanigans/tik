import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { getCacheDir } from "./util";

const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const MODEL_DIR = join(getCacheDir(), "models");
const MODEL_FILES = ["config.json", "tokenizer.json", "onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data"];
const DIMENSIONS = 256;
const BATCH_SIZE = 16;
const WINDOW_CHARS = 1600;
const QUERY_PROMPT = "task: search result | query: ";
const EMBED_VERSION = 3;

export { DIMENSIONS };

export type EmbedChunk = { title: string; text: string };
export type IssueChunk = { part: "summary+description" | "ac" | "ti"; idx: number; text: string };

type Embedder = {
  tokenizer: (texts: string[], opts: object) => Promise<object>;
  model: (inputs: object) => Promise<{ sentence_embedding: { data: Float32Array; dims: number[] } }>;
};

let embedder: Promise<Embedder> | undefined;

export function isEmbedderReady(): boolean {
  return MODEL_FILES.every((file) => existsSync(join(MODEL_DIR, MODEL_ID, file)));
}

async function loadEmbedder(download: boolean): Promise<Embedder> {
  if (!download && !isEmbedderReady()) throw new Error("Embedding model is not downloaded");
  embedder ??= (async () => {
    const { env, AutoTokenizer, AutoModel } = await import("@huggingface/transformers");
    env.cacheDir = MODEL_DIR;
    env.allowRemoteModels = download;
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      AutoModel.from_pretrained(MODEL_ID, { dtype: "q8" }),
    ]);
    return { tokenizer, model } as unknown as Embedder;
  })();
  return embedder;
}

function truncateAndNormalize(vector: Float32Array): Float32Array {
  const truncated = vector.slice(0, DIMENSIONS);
  const norm = Math.hypot(...truncated);
  return truncated.map((x) => x / norm);
}

async function embed(texts: string[], download: boolean): Promise<Float32Array[]> {
  const { tokenizer, model } = await loadEmbedder(download);
  const { sentence_embedding } = await model(await tokenizer(texts, { padding: true, truncation: true }));
  const [count, width] = sentence_embedding.dims;
  return Array.from({ length: count }, (_, i) =>
    truncateAndNormalize(sentence_embedding.data.subarray(i * width, (i + 1) * width)),
  );
}

export async function embedQuery(text: string): Promise<Float32Array> {
  return (await embed([QUERY_PROMPT + text], false))[0];
}

export async function embedDocuments(
  chunks: EmbedChunk[],
  opts?: { download?: boolean },
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const prompts = chunks.slice(i, i + BATCH_SIZE).map((c) => `title: ${c.title} | text: ${c.text}`);
    results.push(...(await embed(prompts, opts?.download ?? false)));
  }
  return results;
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")       // code blocks
    .replace(/`([^`]+)`/g, "$1")            // inline code
    .replace(/!\[.*?\]\(.*?\)/g, "")        // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → keep text
    .replace(/^#{1,6}\s+/gm, "")           // heading markers
    .replace(/\*\*([^*]+)\*\*/g, "$1")      // bold
    .replace(/\*([^*]+)\*/g, "$1")          // italic
    .replace(/~~([^~]+)~~/g, "$1")          // strikethrough
    .replace(/^\s*[-*+]\s+/gm, "")         // bullet markers
    .replace(/^\s*\d+\.\s+/gm, "")         // numbered list markers
    .replace(/^\s*>\s+/gm, "")             // blockquote markers
    .replace(/\|/g, " ")                    // table pipes
    .replace(/---+/g, "")                   // horizontal rules
    .replace(/\s+/g, " ")                   // collapse whitespace
    .trim();
}

function toWindows(paragraphs: string[]): string[] {
  const windows: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    for (let i = 0; i < paragraph.length; i += WINDOW_CHARS) {
      const piece = paragraph.slice(i, i + WINDOW_CHARS);
      if (current && current.length + piece.length + 1 > WINDOW_CHARS) {
        windows.push(current);
        current = "";
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) windows.push(current);
  return windows;
}

function splitParagraphs(markdown?: string | null): string[] {
  return (markdown ?? "")
    .split(/\n\s*\n/)
    .map(stripMarkdown)
    .filter(Boolean);
}

export function chunkIssue(issue: {
  summary: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  testingInstructions?: string | null;
}): IssueChunk[] {
  const parts: Array<[IssueChunk["part"], string[]]> = [
    ["summary+description", [issue.summary, ...splitParagraphs(issue.description)].filter(Boolean)],
    ["ac", splitParagraphs(issue.acceptanceCriteria)],
    ["ti", splitParagraphs(issue.testingInstructions)],
  ];
  return parts.flatMap(([part, paragraphs]) =>
    toWindows(paragraphs).map((text, idx) => ({ part, idx, text })),
  );
}

export function computeChunkHash(chunk: EmbedChunk): string {
  return createHash("md5")
    .update([EMBED_VERSION, chunk.title, chunk.text].join("\0"))
    .digest("hex")
    .slice(0, 16);
}
