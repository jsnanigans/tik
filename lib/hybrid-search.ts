import { type CacheSearchOpts, type CachedIssue, searchCache, searchCacheWithScores, getAllEmbeddings, getCachedIssue } from "./cache";
import { generateEmbedding, cosineSimilarity, isOllamaAvailable } from "./embeddings";

const RRF_K = 60;
const KEYWORD_WEIGHT = 2.0;
const VECTOR_WEIGHT = 1.0;
const MIN_SIMILARITY = 0.3;
const MIN_SIMILARITY_VECTOR_ONLY = 0.45;
const VECTOR_POOL_SIZE = 50;
const KEYWORD_SCORE_CUTOFF = 0.2; // Drop keyword results below 20% of top keyword score

export type HybridSearchOpts = CacheSearchOpts & {
  noSemantic?: boolean;
};

export async function searchCacheHybrid(opts: HybridSearchOpts): Promise<CachedIssue[]> {
  if (!opts.text || opts.noSemantic) {
    return searchCache(opts);
  }

  const embeddings = getAllEmbeddings();
  if (embeddings.size === 0) {
    return searchCache(opts);
  }

  let queryEmbedding: Float32Array | null = null;
  try {
    const available = await isOllamaAvailable();
    if (available) {
      queryEmbedding = await generateEmbedding(opts.text, { query: true });
    }
  } catch {
    // Fall back to keyword only
  }

  if (!queryEmbedding) {
    return searchCache(opts);
  }

  // Run keyword search with scores
  const { results: keywordResults, scoreMap: kwScoreMap } = await searchCacheWithScores(opts);

  // Filter marginal keyword results by score
  const topKwScore = kwScoreMap ? Math.max(...kwScoreMap.values(), 0) : 0;
  const kwScoreCutoff = topKwScore * KEYWORD_SCORE_CUTOFF;
  const filteredKeywordResults = kwScoreMap
    ? keywordResults.filter(r => (kwScoreMap.get(r.key) ?? 0) >= kwScoreCutoff)
    : keywordResults;

  // Run vector search — brute-force cosine similarity, filtered by minimum threshold
  const vectorScores: Array<{ key: string; score: number }> = [];
  for (const [key, emb] of embeddings) {
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score >= MIN_SIMILARITY) {
      vectorScores.push({ key, score });
    }
  }
  vectorScores.sort((a, b) => b.score - a.score);

  // Build similarity lookup for threshold checks later
  const similarityMap = new Map(vectorScores.map((r) => [r.key, r.score]));

  // Build rank maps
  const keywordRank = new Map<string, number>();
  filteredKeywordResults.forEach((r, i) => keywordRank.set(r.key, i + 1));

  const vectorRank = new Map<string, number>();
  vectorScores.slice(0, VECTOR_POOL_SIZE).forEach((r, i) => vectorRank.set(r.key, i + 1));

  // Weighted RRF scoring
  const allKeys = new Set([...keywordRank.keys(), ...vectorRank.keys()]);
  const rrfScores: Array<{ key: string; score: number }> = [];
  for (const key of allKeys) {
    const kwRank = keywordRank.get(key);
    const vecRank = vectorRank.get(key);

    // Vector-only results need higher similarity to be included
    if (kwRank === undefined) {
      const sim = similarityMap.get(key) || 0;
      if (sim < MIN_SIMILARITY_VECTOR_ONLY) continue;
    }

    let score = 0;
    if (kwRank !== undefined) score += KEYWORD_WEIGHT / (RRF_K + kwRank);
    if (vecRank !== undefined) score += VECTOR_WEIGHT / (RRF_K + vecRank);
    rrfScores.push({ key, score });
  }
  rrfScores.sort((a, b) => b.score - a.score);

  const limit = opts.limit || 100;
  const rankedKeys = rrfScores.slice(0, limit).map((r) => r.key);
  const keywordMap = new Map(filteredKeywordResults.map((r) => [r.key, r]));

  // Fetch vector-only results from cache
  const needFetch = rankedKeys.filter((k) => !keywordMap.has(k));
  const fetchedMap = new Map<string, CachedIssue>();
  if (needFetch.length > 0) {
    const fetched = await Promise.all(needFetch.map((k) => getCachedIssue(k)));
    for (const issue of fetched) {
      if (!issue) continue;
      // Apply structured filters to vector-only results
      if (opts.project?.length && !opts.project.includes(issue.project)) continue;
      if (opts.status?.length && !opts.status.includes(issue.status)) continue;
      fetchedMap.set(issue.key, issue);
    }
  }

  // Assemble final results in RRF rank order
  const results: CachedIssue[] = [];
  for (const key of rankedKeys) {
    const issue = keywordMap.get(key) || fetchedMap.get(key);
    if (issue) results.push(issue);
    if (results.length >= limit) break;
  }

  return results;
}
