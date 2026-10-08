import { type CacheSearchOpts, type CachedIssue, searchCache, searchCacheWithScores, getAllChunkEmbeddings, getCachedIssue } from "./cache";
import { embedQuery, similarity, isEmbedderReady } from "./embeddings";

export const TUNING = {
  rrfK: 20,
  keywordWeight: 1,
  vectorWeight: 1,
  minSimilarity: 0.4,
};

const VECTOR_POOL_SIZE = 50;
const KEYWORD_SCORE_CUTOFF = 0.2; // Drop keyword results below 20% of top keyword score

export type HybridSearchOpts = CacheSearchOpts & {
  noSemantic?: boolean;
};

export type HybridRanking = {
  keywordResults: CachedIssue[];
  vectorKeys: string[];
  fusedKeys: string[];
  semantic: boolean;
};

export type HybridSearchResult = {
  issues: CachedIssue[];
  semantic: boolean;
};

async function embedQueryOrNull(text: string): Promise<Float32Array | null> {
  try {
    return isEmbedderReady() ? await embedQuery(text) : null;
  } catch {
    return null;
  }
}

function ticketScore(queryEmbedding: Float32Array, chunks: Float32Array[]): number | null {
  const best = Math.max(...chunks.map((chunk) => similarity(queryEmbedding, chunk)));
  return best >= TUNING.minSimilarity ? best : null;
}

function rankByVector(
  queryEmbedding: Float32Array,
  embeddings: Map<string, Float32Array[]>,
  filterKeys?: Set<string>,
): string[] {
  const scored: Array<{ key: string; score: number }> = [];
  for (const [key, chunks] of embeddings) {
    if (filterKeys && !filterKeys.has(key)) continue;
    const score = ticketScore(queryEmbedding, chunks);
    if (score !== null) scored.push({ key, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, VECTOR_POOL_SIZE).map((r) => r.key);
}

function fuseRankings(keywordKeys: string[], vectorKeys: string[]): string[] {
  const scores = new Map<string, number>();
  const add = (keys: string[], weight: number) =>
    keys.forEach((key, i) => scores.set(key, (scores.get(key) ?? 0) + weight / (TUNING.rrfK + i + 1)));
  add(keywordKeys, TUNING.keywordWeight);
  add(vectorKeys, TUNING.vectorWeight);
  return [...scores].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

export async function rankHybrid(opts: HybridSearchOpts): Promise<HybridRanking> {
  const keywordOnly = async (): Promise<HybridRanking> => {
    const keywordResults = await searchCache(opts);
    return { keywordResults, vectorKeys: [], fusedKeys: keywordResults.map((r) => r.key), semantic: false };
  };

  if (!opts.text || opts.noSemantic) return keywordOnly();

  const embeddings = getAllChunkEmbeddings();
  const queryEmbedding = embeddings.size > 0 ? await embedQueryOrNull(opts.text) : null;
  if (!queryEmbedding) return keywordOnly();

  const { results, scoreMap, filterKeys } = await searchCacheWithScores(opts);
  const cutoff = scoreMap ? Math.max(...scoreMap.values(), 0) * KEYWORD_SCORE_CUTOFF : 0;
  const keywordResults = scoreMap ? results.filter((r) => (scoreMap.get(r.key) ?? 0) >= cutoff) : results;

  const vectorKeys = rankByVector(queryEmbedding, embeddings, filterKeys);
  const fusedKeys = fuseRankings(keywordResults.map((r) => r.key), vectorKeys);
  return { keywordResults, vectorKeys, fusedKeys, semantic: true };
}

export async function searchCacheHybrid(opts: HybridSearchOpts): Promise<HybridSearchResult> {
  const { keywordResults, fusedKeys, semantic } = await rankHybrid(opts);
  const limit = opts.limit || 100;
  const rankedKeys = fusedKeys.slice(0, limit);
  const byKey = new Map(keywordResults.map((r) => [r.key, r]));

  const missing = rankedKeys.filter((key) => !byKey.has(key));
  for (const issue of await Promise.all(missing.map((key) => getCachedIssue(key)))) {
    if (issue) byKey.set(issue.key, issue);
  }

  const issues = rankedKeys.flatMap((key) => byKey.get(key) ?? []);
  return { issues, semantic };
}
