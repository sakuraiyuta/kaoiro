import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { captureCodexPermissionRolloutCursor, codexPermissionContextAfter } from "../src/rollout.js";
import manifest from "./fixtures/permission-compaction/manifest.json" with { type: "json" };

const fixtureRoot = new URL("./fixtures/permission-compaction/", import.meta.url);

describe("permission observations across real compaction records", () => {
  it.each(manifest)("reads $file through the compiled production default rollout path", async (record) => {
    const bytes = await readFile(new URL(record.file, fixtureRoot));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256);
    const home = await mkdtemp(join(tmpdir(), "fuji340-default-rollout-"));
    try {
      // A fresh process uses the production homedir root and the compiled
      // reader. The recorded SDK contexts are replayed byte-for-byte; no
      // permission resolver or observation result is injected.
      const source = `
        import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { captureCodexPermissionRolloutCursor, codexPermissionContextAfter, codexRolloutsRoot } from ${JSON.stringify(new URL("../dist/rollout.js", import.meta.url).href)};
        const root = codexRolloutsRoot();
        mkdirSync(root, {recursive:true});
        const path = join(root, 'rollout-${record.sessionId}.jsonl');
        writeFileSync(path, '');
        const cursor = captureCodexPermissionRolloutCursor(root, '${record.sessionId}');
        appendFileSync(path, readFileSync(${JSON.stringify(fileURLToPath(new URL(record.file, fixtureRoot)))}));
        const observed = codexPermissionContextAfter(cursor, '${record.sessionId}');
        process.stdout.write(JSON.stringify({root, observed}));
        if (observed === null) process.exitCode = 1;
      `;
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source], {
        env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toEqual({ root: join(home, ".codex", "sessions"), observed: record.expected });
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each(["turn_id", "sandbox", "network", "approval"])("rejects a conflicting %s instead of choosing the newest context", async (axis) => {
    const root = await mkdtemp(join(tmpdir(), "fuji340-conflict-"));
    try {
      const path = join(root, "rollout-conflict-session.jsonl");
      await writeFile(path, "");
      const cursor = captureCodexPermissionRolloutCursor(root, "conflict-session");
      const first = { type: "turn_context", payload: { turn_id: "same-turn", approval_policy: "never",
        sandbox_policy: { type: "workspace-write", network_access: false } } };
      const next = structuredClone(first);
      if (axis === "turn_id") next.payload.turn_id = "another-turn";
      if (axis === "sandbox") next.payload.sandbox_policy.type = "read-only";
      if (axis === "network") next.payload.sandbox_policy.network_access = true;
      if (axis === "approval") next.payload.approval_policy = "on-request";
      await appendFile(path, JSON.stringify(first) + "\n" + JSON.stringify(next) + "\n");
      expect(codexPermissionContextAfter(cursor, "conflict-session")).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
