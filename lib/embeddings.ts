import { createHash } from "crypto";

const OLLAMA_BASE = "http://localhost:11434";
const MODEL = "nomic-embed-text";
const DIMENSIONS = 768;
const BATCH_SIZE = 10;
const MAX_TOKENS = 8192;
const DOC_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";

export { DIMENSIONS };

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(OLLAMA_BASE, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function isModelAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    return !!data.models?.some((m) => m.name.startsWith(MODEL));
  } catch {
    return false;
  }
}

export async function generateEmbedding(text: string, opts?: { query?: boolean }): Promise<Float32Array> {
  const input = opts?.query ? QUERY_PREFIX + text : text;
  const resp = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embed failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  if (!data.embeddings?.[0]) throw new Error("Ollama returned no embeddings");
  return new Float32Array(data.embeddings[0]);
}

export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const resp = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: batch }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama embed failed: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as { embeddings: number[][] };
    if (!data.embeddings) throw new Error("Ollama returned no embeddings");
    for (const emb of data.embeddings) {
      results.push(new Float32Array(emb));
    }
  }
  return results;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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

export function prepareEmbeddingText(issue: {
  key: string;
  summary: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  testingInstructions?: string | null;
}): string {
  const parts: string[] = [];
  parts.push(issue.summary);
  if (issue.description) parts.push(stripMarkdown(issue.description));
  if (issue.acceptanceCriteria) parts.push(stripMarkdown(issue.acceptanceCriteria));
  if (issue.testingInstructions) parts.push(stripMarkdown(issue.testingInstructions));

  let text = parts.join("\n");
  const maxChars = (MAX_TOKENS * 4) - DOC_PREFIX.length;
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return DOC_PREFIX + text;
}

const EMBED_VERSION = 2; // Bump to invalidate all embeddings (e.g. after changing prepareEmbeddingText)

export function computeContentHash(fields: {
  summary: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  testingInstructions?: string | null;
}): string {
  const content = [
    String(EMBED_VERSION),
    fields.summary || "",
    fields.description || "",
    fields.acceptanceCriteria || "",
    fields.testingInstructions || "",
  ].join("\0");
  return createHash("md5").update(content).digest("hex").slice(0, 16);
}
