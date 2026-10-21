import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { loadCredentials } from "../lib/credentials";
import { jiraGet } from "../lib/api";
import { confluenceRequest, resolveSpaceId } from "../lib/confluence";
import { localConfig } from "../lib/config";
import type { AdfNode } from "../lib/markdown";

const PAGE_TARGET = 300;
const ISSUE_TARGET = 300;
const CONCURRENCY = 8;

const cacheDir = `${homedir()}/.cache/tik`;
const outDir = `${cacheDir}/eval`;
mkdirSync(outDir, { recursive: true });
const creds = await loadCredentials(false);

async function fetchPages() {
  const spaces = localConfig.confluence?.syncSpaces ?? [];
  const listings = spaces.length
    ? await Promise.all(spaces.map(async (key) => `/api/v2/spaces/${await resolveSpaceId(creds, key)}/pages`))
    : ["/api/v2/pages"];
  const perListing = Math.ceil(PAGE_TARGET / listings.length);
  const pages: { id: string; title: string; adf: AdfNode }[] = [];
  for (const listing of listings) {
    let next: string | null = `${listing}?body-format=atlas_doc_format&sort=-modified-date&limit=50`;
    let count = 0;
    while (next && count < perListing) {
      const data = await confluenceRequest(creds, "GET", next);
      for (const page of data.results ?? []) {
        const value = page.body?.atlas_doc_format?.value;
        if (!value || count >= perListing) continue;
        pages.push({ id: page.id, title: page.title, adf: JSON.parse(value) });
        count++;
      }
      next = data._links?.next?.replace(/^\/wiki/, "") ?? null;
    }
  }
  return pages;
}

async function fetchComments() {
  const cache = new Database(`file:${cacheDir}/tickets.db?immutable=1`, { readonly: true });
  const keys = cache
    .query<{ key: string }, [number]>("SELECT key FROM issues ORDER BY updated DESC LIMIT ?")
    .all(ISSUE_TARGET)
    .map((row) => row.key);
  const comments: { key: string; id: string; adf: AdfNode }[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const res = (await jiraGet(creds, `/rest/api/3/issue/${key}/comment?maxResults=100`)) as {
        comments?: { id: string; body?: AdfNode }[];
      };
      for (const comment of res.comments ?? []) {
        if (comment.body?.type === "doc") comments.push({ key, id: comment.id, adf: comment.body });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return comments;
}

const pages = await fetchPages();
await Bun.write(`${outDir}/confluence.json`, JSON.stringify(pages));
console.log(`confluence pages: ${pages.length}`);

const comments = await fetchComments();
await Bun.write(`${outDir}/comments.json`, JSON.stringify(comments));
console.log(`comments: ${comments.length} (from ${ISSUE_TARGET} issues)`);
