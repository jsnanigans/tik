import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { customFields } from "../lib/config";
import type { AdfNode } from "../lib/markdown";

export type Field = { label: string; adf: AdfNode };

export const cacheDir = `${homedir()}/.cache/tik`;

export function* jiraFields(): Generator<Field> {
  const db = new Database(`file:${cacheDir}/tickets.db?immutable=1`, { readonly: true });
  const names = {
    description: "description",
    acceptanceCriteria: customFields.acceptanceCriteria,
    testingInstructions: customFields.testingInstructions,
  };
  for (const row of db.query<{ key: string; raw: string }, []>("SELECT key, raw FROM issues WHERE raw IS NOT NULL").iterate()) {
    const fields = JSON.parse(row.raw).fields ?? {};
    for (const [name, id] of Object.entries(names)) {
      if (id && fields[id]?.type === "doc") yield { label: `${row.key} ${name}`, adf: fields[id] };
    }
  }
}

export async function sampleFields(file: string, label: (item: any) => string): Promise<Field[] | null> {
  const path = `${cacheDir}/eval/${file}`;
  if (!existsSync(path)) return null;
  return (await Bun.file(path).json()).map((item: any) => ({ label: label(item), adf: item.adf }));
}

export const confluenceFields = () => sampleFields("confluence.json", (page) => `confluence ${page.id}`);
export const commentFields = () => sampleFields("comments.json", (comment) => `${comment.key} comment ${comment.id}`);
