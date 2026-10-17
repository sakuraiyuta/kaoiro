import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const extractor = fileURLToPath(
  new URL("../extract-peer-session-reset-reply-vocabulary.mjs", import.meta.url)
);
const transport = fileURLToPath(new URL("../../wrapper/core/src/transport.ts", import.meta.url));

function extract(sourcePath) {
  return spawnSync(process.execPath, [extractor, sourcePath], { encoding: "utf8" });
}

async function withSource(source, callback) {
  const directory = await mkdtemp(join(tmpdir(), "ao677-vocabulary-"));
  const sourcePath = join(directory, "transport.ts");

  try {
    await writeFile(sourcePath, source);
    await callback(sourcePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertRejected(source, error) {
  await withSource(source, (sourcePath) => {
    const result = extract(sourcePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  });
}

test("extracts the transport peer session reset reply vocabulary", () => {
  const result = extract(transport);

  assert.equal(result.status, 0, result.stderr);
  const values = JSON.parse(result.stdout);
  assert.deepEqual(values, [...values].sort());

  assert.deepEqual(values, [
    "agent_busy",
    "agent_in_conversation",
    "reset_not_authorized",
    "runner_unavailable",
    "session_reset_pending",
    "unknown_agent",
    "unsupported_session_reset",
    "work_control_unavailable"
  ]);
});

test("accepts a trailing comma and newlines in the reply vocabulary", async () => {
  await withSource(
    `const PEER_SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set([
  "agent_busy",
  "runner_unavailable",
]);
`,
    (sourcePath) => {
      const result = extract(sourcePath);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["agent_busy", "runner_unavailable"]);
    }
  );
});

test("rejects a non-literal reply vocabulary", async () => {
  await assertRejected(
    'const PEER_SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set(["agent_busy", ...reasons]);\n',
    /Malformed PEER_SESSION_RESET_ERROR_REASONS literal/
  );
});

test("rejects a comment inside the reply vocabulary literal", async () => {
  await assertRejected(
    `const PEER_SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set([
  "agent_busy", // no comments in the extracted literal
  "runner_unavailable",
]);
`,
    /Malformed PEER_SESSION_RESET_ERROR_REASONS literal/
  );
});

test("rejects an assertion after the reply vocabulary literal", async () => {
  await assertRejected(
    'const PEER_SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set(["agent_busy"] as const);\n',
    /Could not extract PEER_SESSION_RESET_ERROR_REASONS/
  );
});

test("rejects single-quoted reply vocabulary values", async () => {
  await assertRejected(
    "const PEER_SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set(['agent_busy']);\n",
    /Malformed PEER_SESSION_RESET_ERROR_REASONS literal/
  );
});

test("does not read the self-reset vocabulary constant", async () => {
  await assertRejected(
    'const SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set(["agent_busy"]);\n',
    /Could not extract PEER_SESSION_RESET_ERROR_REASONS/
  );
});

test("rejects a duplicate reply vocabulary value", async () => {
  await assertRejected(
    'const PEER_SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set(["agent_busy", "agent_busy"]);\n',
    /Duplicate peer session reset reply reason "agent_busy"/
  );
});

test("rejects an empty reply vocabulary", async () => {
  await assertRejected(
    "const PEER_SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set([]);\n",
    /PEER_SESSION_RESET_ERROR_REASONS is empty/
  );
});
