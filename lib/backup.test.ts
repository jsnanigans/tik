import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { findFieldBackup } from "./cache";

test("findFieldBackup picks the newest backup, narrowed by field and timestamp prefix", () => {
  process.env.HOME = mkdtempSync(`${tmpdir()}/tik-`);
  const dir = `${process.env.HOME}/.cache/tik/backups/ABC-1`;
  mkdirSync(dir, { recursive: true });
  for (const name of ["description-2026-01-01T10-00-00-000Z", "description-2026-02-01T10-00-00-000Z", "comment-7-2026-03-01T10-00-00-000Z"]) {
    writeFileSync(`${dir}/${name}.json`, JSON.stringify({ field: name.split("-")[0] }));
  }
  expect(findFieldBackup("ABC-1").path).toContain("comment-7-2026-03");
  expect(findFieldBackup("ABC-1", "description").path).toContain("2026-02-01");
  expect(findFieldBackup("ABC-1", "description", "2026-01-01T10:00").path).toContain("2026-01-01");
  expect(() => findFieldBackup("ABC-1", "acceptanceCriteria")).toThrow("No backup");
});
