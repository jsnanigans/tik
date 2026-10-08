import { embedDocuments } from "./embeddings";
import { getChunksNeedingEmbedding, cacheChunkEmbeddings, setLastEmbedTime } from "./cache";

const BATCH_SIZE = 16;

export async function syncEmbeddings(
  onProgress?: (done: number, total: number) => void,
  opts: { full?: boolean; download?: boolean } = {},
): Promise<number> {
  const startedAt = new Date().toISOString();
  const pending = getChunksNeedingEmbedding(opts.full);

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const embeddings = await embedDocuments(batch, { download: opts.download });
    cacheChunkEmbeddings(batch.map((chunk, idx) => ({ ...chunk, embedding: embeddings[idx] })));
    onProgress?.(i + batch.length, pending.length);
  }

  setLastEmbedTime(startedAt);
  return pending.length;
}
