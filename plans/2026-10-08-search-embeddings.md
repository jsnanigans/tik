# Plan: hybrid search with EmbeddingGemma

## Goal

Make `tik search` a working hybrid of keyword ranking (BM25) and vector search:

- Switch to EmbeddingGemma 1 (`embeddinggemma-300m`), run in-process with no Ollama.
- Make the vector side actually run, and say so when it does not.
- Embed each ticket in several parts instead of one truncated vector.
- Relax the rule that every query word must match.
- Tune everything against a small test set.

Images and attachments are out of scope.

## Current state

- **Keyword side:** MiniSearch (BM25+, prefix and typo matching, `combineWith: "AND"`) by default, or SQLite FTS5 `bm25()` with `--no-fuzzy`.
- **Vector side:** `nomic-embed-text` through Ollama, one 768-dimension vector per ticket stored in `issues.embedding`. Both lists are merged with weighted RRF (`lib/hybrid-search.ts`: keyword weight 2, vector weight 1, minimum similarity 0.45 for results only the vector side found).
- **In practice:** 0 of 11,556 issues have an embedding and Ollama is not installed. Every search silently falls back to keyword only.
- **Embedded text:** summary, description, acceptance criteria and testing instructions, truncated at about 8k tokens. Comments are not in the cache.

## Spike results (2026-10-08, scratchpad)

- `@huggingface/transformers` 3.x with `onnx-community/embeddinggemma-300m-ONNX`, run with dtype `q8`, works under `bun run` without the `onnxruntime-node` postinstall.
- **Timings:**
  - First load takes about 33 s, including about 325 MB of downloads.
  - A warm load takes about 0.4 s.
  - A query embedding takes about 0.1 s.
  - 64 docs of about 500 tokens take about 4.1 s, roughly 15 docs/s on CPU.
- The sanity check ranks correctly: "sign-in button broken" scores 0.53 against the login ticket and about 0.16 against unrelated ones.
- **Blocker:** a `bun build --compile` binary does not run the model. Bundling `onnxruntime-node` gets the process killed (exit 137). With `--external`, nothing is printed. The `wasm` device is not available in the Node build. `just install` ships the compiled binary, so step 1 must solve this.

## Design decisions

- **Model:** `onnx-community/embeddinggemma-300m-ONNX`, `q8`.
  - Query prompt: `task: search result | query: `.
  - Document prompt: `title: <summary> | text: `.
  - Vectors are normalized, so similarity is a dot product.
  - The model cache lives in `~/.cache/tik/models` (set `env.cacheDir`), not in `node_modules`.
- **Dimensions:** truncate to 256 using Matryoshka (MRL), which the model supports. That keeps the vectors loaded per search at about 25 MB, not about 75 MB. The test set decides between 256 and 768.
- **Drop Ollama:** remove `isOllamaAvailable`, `isModelAvailable` and the fetch-based client (YAGNI). There is no second backend.
- **Chunks:** a new table `issue_chunks(key, part, idx, text_hash, embedding)`.
  - **Parts:** `summary+description`, `ac`, `ti`.
  - **Windows:** long parts are split into about 400-token windows, by paragraph, with no overlap. Each window carries the summary as its title.
  - **Ticket score:** the best chunk score, plus a small bonus if more than one chunk matches. The test set tunes the bonus.
  - The `issues.embedding` and `embedding_hash` columns are no longer used. A schema migration drops their contents.
- **Relaxed matching:** run the AND query first. If it returns fewer than `RELAX_MIN` results (for example 5), run an OR query and append its results below the AND results. Apply this the same way in MiniSearch and FTS5 (`term1 OR term2`). In hybrid mode RRF already favours tickets found by both sides.
- **Test set:** `eval/queries.json`, git-ignored because it holds internal ticket keys and wording. Each entry is `{ query, expected: [keys], kind: "exact" | "paraphrase" | "vague" }`.

## Steps

1. **Compiled-binary support (spike, time-boxed to about 1 h).** Try these in order:
   - (a) Import the `onnxruntime-node` `.node` addon so that `bun build --compile` embeds it, and fix the exit-137 crash (likely signing or native load).
   - (b) Run embeddings in a small sidecar script (`lib/embed-worker.ts`) that the binary spawns with `bun`, resolved from the tik source directory.
   - Pick the first one that works with `just install`, and document it in this plan.
2. **Embedder** (`lib/embeddings.ts`): replace the Ollama client with a lazy transformers.js pipeline.
   - Functions: `embedQuery(text)`, `embedDocuments(chunks)` with batches of 16, and `isEmbedderReady()`, which is true once the model files are cached.
   - Remove the Ollama code. Bump `EMBED_VERSION`.
   - Add `@huggingface/transformers` to `package.json`.
3. **Chunking and storage** (`lib/embeddings.ts`, `lib/cache.ts`):
   - `chunkIssue(issue)` returns `{part, idx, text}[]`.
   - Add the `issue_chunks` table and a migration that bumps `SCHEMA_VERSION`.
   - `getChunksNeedingEmbedding()` compares hashes per chunk, and only for issues whose `cached_at` is newer than the last embed run.
   - `cacheChunkEmbeddings()` writes the vectors. `getAllChunkEmbeddings()` returns per-key arrays and is cached in memory.
4. **Sync** (`lib/embed-sync.ts`, `main.ts`):
   - `tik sync` embeds new or changed chunks after the ticket phase, as it does today.
   - `tik embed sync` does a full backfill. Rough estimate for about 25k chunks: 15 to 30 minutes, run once.
   - `tik embed` shows stats: chunks embedded, chunks pending, model cached or not.
5. **Hybrid search** (`lib/hybrid-search.ts`):
   - The vector side scores by best chunk per ticket.
   - Similarity thresholds are re-tuned for EmbeddingGemma, starting from the test set and not from the nomic values.
   - Keep weighted RRF, with weights and thresholds collected in one constants block.
6. **Relaxed keyword matching** (`lib/cache.ts` search, MiniSearch options in `lib/search.ts`): AND first, then an OR fallback, as described above. Exact key and identifier queries must keep ranking first.
7. **Make the semantic state visible:**
   - In table mode, when there are no embeddings, search prints one dim line: `semantic search off — run tik embed sync`.
   - `--json` adds `"semantic": true|false` to the result envelope.
   - Search never fails because of the embedder: if it is not ready, search runs keyword only and says so.
8. **Test set and evaluation script** (`eval/search-eval.ts`, git-ignored, run with `bun run eval/search-eval.ts`):
   - **Queries:** 25–30 total. I draft them from real tickets (10 exact identifiers or error strings, 10 paraphrases with no summary words, 5–10 vague ones such as "that bug where the scheduler double-books"). You review them and correct the expected keys.
   - **Metrics:** Recall@10 and MRR, overall and per `kind`.
   - **Configurations compared:**
     - keyword-only AND
     - keyword with the OR fallback
     - vector-only
     - hybrid at RRF keyword weights 1, 2 and 3
     - 256 vs 768 dimensions
     - with and without the multi-chunk bonus
   - The configurations are swept by temporary overrides in the script, not by new CLI flags.
9. **Tune and lock:** set the constants from the evaluation results. Record the results table at the end of this plan.
10. **Docs:** update `README.md` (setup: no Ollama, model download on first `embed sync`), `AGENTS.md` (`embed`, semantic flag, relaxed matching) and `claude_skill/jira-cli/`.

## Order and parallelism

- Step 1 first: it decides how the embedder is loaded.
- Then steps 2–4 (embedder, storage, sync) in sequence.
- Steps 6 (keyword relax) and 8 (test-set drafting) can run in parallel with them.
- Then step 5, step 7, steps 8–9 (evaluation, tuning) and step 10.

## Verification

- `just check` passes.
- `bun run main.ts embed sync` completes, and `tik embed` shows 0 pending.
- `just install` followed by `tik search "<paraphrase>"` returns semantic results from the compiled binary.
- With the model cache removed and `--json`, search still works keyword only and reports `"semantic": false`.
- The evaluation shows hybrid beating keyword-only on the paraphrase and vague queries, without losing on the exact ones.

## Risks

- **Compiled binary and native ONNX runtime:** see step 1. If both options fail, the fallback is to install `tik` as a `bun run` wrapper script, at the cost of startup time.
- **Model licence:** EmbeddingGemma is under the Gemma terms. That is fine for personal internal use.
- **First-run download:** about 325 MB. Only `tik embed sync` and the embed phase of `tik sync` trigger it; plain search never downloads.
- **Memory:** about 25k chunks × 256 dims × 4 bytes is about 25 MB per search, which is acceptable. If 768 dims win, consider int8 storage.

## Results

27 queries (draft set, expected keys pending review). Recall@10 / MRR, 256 dims unless noted.

| Config | All | Exact | Paraphrase | Vague |
|---|---|---|---|---|
| Keyword AND | 0.35 / 0.37 | 0.95 / 1.00 | 0.00 / 0.00 | 0.00 / 0.00 |
| Keyword + OR fallback | 0.64 / 0.53 | 1.00 / 1.00 | 0.40 / 0.32 | 0.45 / 0.16 |
| Vector only | 0.67 / 0.54 | 0.75 / 0.73 | 0.60 / 0.36 | 0.64 / 0.54 |
| Hybrid, keyword weight 2, rrfK 60 | 0.64 / 0.59 | 1.00 / 1.00 | 0.40 / 0.33 | 0.45 / 0.40 |
| Hybrid, keyword weight 1, rrfK 60 | 0.72 / 0.64 | 1.00 / 1.00 | 0.50 / 0.36 | 0.64 / 0.53 |
| **Hybrid, keyword weight 1, rrfK 20, minSimilarity 0.4 (locked)** | **0.83 / 0.64** | 1.00 / 1.00 | 0.70 / 0.37 | 0.79 / 0.53 |

- **Locked:** `rrfK: 20, keywordWeight: 1, vectorWeight: 1, minSimilarity: 0.4`.
- **Multi-chunk bonus:** no measurable gain, removed.
- **Vector weight 2 or 3:** hurts exact queries (1.00 to 0.75).
- **256 vs 768 dims:** 768 gave +0.02 to 0.04 MRR and no recall gain (best hybrid recall 0.83 at 256 vs 0.77 to 0.82 at 768), at 3x the storage (about 65 MB vs 21 MB). Stay at 256.
- **Step 1 outcome:** option (a). `build.ts` bundles `onnxruntime-node`, stubs `sharp` and ad-hoc signs the binary. transformers.js is pinned at 4.3.1. darwin-arm64 only.
