import { isOllamaAvailable, generateEmbeddings, prepareEmbeddingText, computeContentHash } from "./embeddings";
import { getIssuesNeedingEmbedding, cacheEmbeddings } from "./cache";

const BATCH_SIZE = 10;

export async function syncEmbeddings(
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const available = await isOllamaAvailable();
  if (!available) return 0;

  const issues = getIssuesNeedingEmbedding();
  if (issues.length === 0) return 0;

  const total = issues.length;
  let done = 0;

  for (let i = 0; i < issues.length; i += BATCH_SIZE) {
    const batch = issues.slice(i, i + BATCH_SIZE);
    const texts = batch.map((issue) =>
      prepareEmbeddingText({
        key: issue.key,
        summary: issue.summary,
        description: issue.description,
        acceptanceCriteria: issue.acceptance_criteria,
        testingInstructions: issue.testing_instructions,
      }),
    );

    try {
      const embeddings = await generateEmbeddings(texts);

      const data = batch.map((issue, idx) => ({
        key: issue.key,
        embedding: embeddings[idx],
        hash: computeContentHash({
          summary: issue.summary,
          description: issue.description,
          acceptanceCriteria: issue.acceptance_criteria,
          testingInstructions: issue.testing_instructions,
        }),
      }));

      cacheEmbeddings(data);
      done += batch.length;
      onProgress?.(done, total);
    } catch {
      // Best effort — save progress so far, skip this batch
      done += batch.length;
      onProgress?.(done, total);
    }
  }

  return done;
}
