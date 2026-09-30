import MiniSearch, { type Options as MiniSearchOptions } from "minisearch";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { getCacheDir } from "./util";
import { stripMarkdown } from "./embeddings";

const INDEX_VERSION = 2;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for",
  "from", "had", "has", "have", "he", "her", "his", "how", "i", "if",
  "in", "into", "is", "it", "its", "me", "my", "no", "not", "of", "on",
  "or", "our", "out", "she", "so", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "up", "us", "was", "we",
  "what", "when", "which", "who", "will", "with", "you", "your",
]);

export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase());
}

function getIndexPath(): string {
  return `${getCacheDir()}/search-index.json`;
}

type IndexEnvelope = {
  version: number;
  index: string;
};

const MINISEARCH_OPTS: MiniSearchOptions = {
  fields: ["key", "summary", "description", "acceptance_criteria", "testing_instructions"],
  storeFields: ["key"],
  idField: "key",
  processTerm: (term) => {
    const lower = term.toLowerCase();
    if (STOP_WORDS.has(lower)) return null;
    return lower;
  },
  searchOptions: {
    prefix: true,
    combineWith: "AND",
    fuzzy: (term) => {
      if (term.length <= 4) return false;
      return 1;
    },
    weights: { fuzzy: 0.2, prefix: 0.5 },
    boost: { key: 10, summary: 5, description: 1, acceptance_criteria: 1, testing_instructions: 1 },
  },
};

let cachedIndex: MiniSearch | null = null;

export function getSearchIndex(): MiniSearch {
  if (cachedIndex) return cachedIndex;

  const indexPath = getIndexPath();
  if (existsSync(indexPath)) {
    try {
      const raw = readFileSync(indexPath, "utf-8");
      const envelope: IndexEnvelope = JSON.parse(raw);
      if (envelope.version === INDEX_VERSION) {
        cachedIndex = MiniSearch.loadJSON(envelope.index, MINISEARCH_OPTS);
        return cachedIndex;
      }
    } catch {
      // Corrupted index — will rebuild
    }
  }

  cachedIndex = buildSearchIndex();
  return cachedIndex;
}

export function buildSearchIndex(): MiniSearch {
  const dbPath = `${getCacheDir()}/tickets.db`;
  if (!existsSync(dbPath)) {
    const idx = new MiniSearch(MINISEARCH_OPTS);
    cachedIndex = idx;
    return idx;
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db.query(
    "SELECT key, summary, description, acceptance_criteria, testing_instructions FROM issues"
  ).all() as Array<{
    key: string;
    summary: string;
    description: string | null;
    acceptance_criteria: string | null;
    testing_instructions: string | null;
  }>;
  db.close();

  const index = new MiniSearch(MINISEARCH_OPTS);
  index.addAll(rows.map(r => ({
    key: r.key,
    summary: r.summary || "",
    description: r.description ? stripMarkdown(r.description) : "",
    acceptance_criteria: r.acceptance_criteria ? stripMarkdown(r.acceptance_criteria) : "",
    testing_instructions: r.testing_instructions ? stripMarkdown(r.testing_instructions) : "",
  })));

  // Persist to disk
  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  const envelope: IndexEnvelope = {
    version: INDEX_VERSION,
    index: JSON.stringify(index),
  };
  const tmpPath = `${getIndexPath()}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(envelope));
  renameSync(tmpPath, getIndexPath());

  cachedIndex = index;
  return index;
}

export function invalidateSearchIndex(): void {
  cachedIndex = null;
  const indexPath = getIndexPath();
  try {
    if (existsSync(indexPath)) {
      unlinkSync(indexPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

