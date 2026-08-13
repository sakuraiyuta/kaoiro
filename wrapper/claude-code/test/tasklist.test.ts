import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeTasklist } from "../src/tasklist.js";

const temporaryRoots: string[] = [];

async function makeTaskRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaoiro-claude-tasklist-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("readClaudeTasklist", () => {
  it("session directory の JSON を id 順の whole-list snapshot に写す", async () => {
    const root = await makeTaskRoot();
    const directory = join(root, "session-1");
    await mkdir(directory);
    await writeFile(
      join(directory, "10.json"),
      JSON.stringify({ id: "10", subject: "十番", status: "completed" }),
    );
    await writeFile(
      join(directory, "2.json"),
      JSON.stringify({ id: "2", subject: "二番", status: "in_progress" }),
    );

    await expect(readClaudeTasklist("session-1", root)).resolves.toEqual({
      kind: "updated",
      items: [
        { text: "二番", status: "in_progress" },
        { text: "十番", status: "completed" },
      ],
    });
  });

  it("不存在 directory は private source contract の破断として invalid にする", async () => {
    const root = await makeTaskRoot();
    await expect(readClaudeTasklist("session-1", root)).resolves.toEqual({
      kind: "invalid",
      reason: "Claude task directory is missing",
    });
  });

  it("存在する空 directory だけを空 snapshot とする", async () => {
    const root = await makeTaskRoot();
    await mkdir(join(root, "session-1"));
    await expect(readClaudeTasklist("session-1", root)).resolves.toEqual({
      kind: "updated",
      items: [],
    });
  });

  it("traversal と 128 文字超の session_id を filesystem に渡さない", async () => {
    const root = await makeTaskRoot();
    await expect(readClaudeTasklist("../other", root)).resolves.toEqual({
      kind: "invalid",
      reason: "Claude tasklist session_id is invalid",
    });
    await expect(readClaudeTasklist("a".repeat(129), root)).resolves.toEqual({
      kind: "invalid",
      reason: "Claude tasklist session_id is invalid",
    });
  });

  it("schema 破断は stale snapshot にせず invalid として返す", async () => {
    const root = await makeTaskRoot();
    const directory = join(root, "session-1");
    await mkdir(directory);
    await writeFile(
      join(directory, "1.json"),
      JSON.stringify({ id: "1", subject: "壊れた status", status: "deleted" }),
    );

    await expect(readClaudeTasklist("session-1", root)).resolves.toEqual({
      kind: "invalid",
      reason: "Claude task file 1.json status is invalid",
    });
  });
});
