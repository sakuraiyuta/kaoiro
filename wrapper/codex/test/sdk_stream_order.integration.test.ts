import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

describe("pinned Codex SDK handoff boundary", () => {
  it("does not spawn before runStreamed resolves; first stdout value follows stdin close", async () => {
    const root = await mkdtemp(join(tmpdir(), "momo432-codex-sdk."));
    const executable = join(root, "codex-fixture");
    const spawned = join(root, "spawned");
    const inputFile = join(root, "input");
    const script = [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.SPAWN_MARKER, 'spawned');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.INPUT_MARKER, input);",
      "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-fixture' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n');",
      "});",
    ].join("\n");
    try {
      await writeFile(executable, script, "utf8");
      await chmod(executable, 0o700);
      const thread = new Codex({
        codexPathOverride: executable,
        env: { PATH: process.env.PATH ?? "", SPAWN_MARKER: spawned, INPUT_MARKER: inputFile },
      }).startThread();
      const { events } = await thread.runStreamed("handoff-marker");
      await expect(readFile(spawned, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const iterator = events[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ type: "thread.started" });
      expect(await readFile(spawned, "utf8")).toBe("spawned");
      expect(await readFile(inputFile, "utf8")).toContain("handoff-marker");
      while (!(await iterator.next()).done) {}
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
