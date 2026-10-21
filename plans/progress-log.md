# Progress log: search embeddings

All steps done, uncommitted. `just check` green; verified with the compiled binary (`semantic: true`; model cache removed gives `semantic: false` with the dim hint).

- Locked TUNING (`rrfK 20, keywordWeight 1, vectorWeight 1, minSimilarity 0.4`); chunk bonus removed; 256 dims kept. Results table in the plan.
- Open: Brendan to review `eval/queries.json` expected keys (weak: BACK-5874, "appointments not getting cancelled", BACK-4838). `just install` not run.

Suggested commits, in order:
1. `build(cli): bundle onnxruntime in compiled binary` (build.ts, justfile, package.json, bun.lock)
2. `feat(search): relax keyword matching to OR`
3. `feat(search): embed in-process with EmbeddingGemma` (lib/embeddings.ts, lib/index.ts)
4. `feat(search): store and sync per-chunk embeddings` (cache.ts, embed-sync.ts, main.ts embed)
5. `feat(search): tune hybrid ranking and report semantic state` (hybrid-search.ts, main.ts search)
6. `docs(search): document EmbeddingGemma embeddings`

# Progress log: lossless ADF codec

## Phase 0: measurement (baseline, current codec, 2026-10-21)

`just verify-roundtrip` runs in 1.4 s. Report: `reports/roundtrip-2026-10-21.json` (`--preserve-unknown` variant: `reports/roundtrip-2026-10-21-preserve-unknown.json`). Samples fetched read-only by `eval/fetch-samples.ts`: 300 Confluence pages (no `syncSpaces` configured, so the latest pages across all spaces) and 1,016 comments from the 300 most recently updated cached issues.

| Source (default mode) | Fields | Exact | Readable | Idempotent | Schema-valid | Crashes |
|---|---|---|---|---|---|---|
| Jira cache | 17,984 | 54.45% | 51.32% | 99.62% | 99.96% (originals 100%) | 6 |
| Confluence sample | 300 | 5.33% | 4.67% | 82.00% | 99.00% (originals 92%) | 0 |
| Comment sample | 1,016 | 55.81% | 53.25% | 97.44% | 100% (originals 100%) | 0 |

- `--preserve-unknown` exact: Jira 59.53%, Confluence 22.67%, comments 73.13%.
- Readable = exact and no `tikmedia:`/`tikadf:` placeholder in the markdown. Schema-valid = produced ADF passes the vendored `eval/adf-schema-full.json` (`@atlaskit/adf-schema` 57.7.21). Idempotent = a second round trip equals the first.
- Crashes (all `parseList` null destructure): PROD-1072, PROD-1050, PMP-1265, PROD-50, FEWEB-1091 and one more; the report lists the first 5.
- Top Jira differences, in fields: inlineCard 3,531; hardBreak 1,722; emoji 547; mention 402; textColor 302. The report has the full list with example keys.
- Against requirements §3 (51.5% exact, 56.2% with `preserveUnknown`, 6 crashes): the harness applies the §5 defaults rule (absent attribute equals default, so `orderedList order=1` and default table attrs are not losses). With that rule off the same run gives 9,271 exact (51.55%); the remaining gap to 9,257 is the trailing-empty-paragraph rule. Crashes match exactly.
- Golden fixtures for R20: `lib/fixtures/{ticket-pmp-1838,agents-examples,edge-cases}.json` (`name`, `markdown`, `adf`; `localId` stripped because the old parser generates random ones). They record today's output, including its quirks (snake_case split into text runs, ordered start dropped, tables without a separator get a header row).
- `lib/adf-reconcile.ts`: `canonicalize`, `equivalent`. `eval/` is git-ignored, so its files were added with `git add -f`. New dev dependency: `ajv@6` (draft-04 schema support).
- `just check` passes.
