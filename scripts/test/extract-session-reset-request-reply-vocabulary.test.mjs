import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const extractor = fileURLToPath(
  new URL("../extract-session-reset-request-reply-vocabulary.mjs", import.meta.url)
);
const transport = fileURLToPath(new URL("../../wrapper/core/src/transport.ts", import.meta.url));

function extract(sourcePath) {
  return spawnSync(process.execPath, [extractor, sourcePath], { encoding: "utf8" });
}

test("extracts the transport session reset reply vocabulary", () => {
  const result = extract(transport);

  assert.equal(result.status, 0, result.stderr);
  const values = JSON.parse(result.stdout);
  assert.deepEqual(values, [...values].sort());

  for (const value of [
    "agent_busy",
    "runner_unavailable",
    "session_reset_pending",
    "unsupported_session_reset"
  ]) {
    assert(values.includes(value));
  }
});

test("rejects a non-literal reply vocabulary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momo326-vocabulary-"));
  const sourcePath = join(directory, "transport.ts");

  try {
    await writeFile(
      sourcePath,
      'const SESSION_RESET_ERROR_REASONS: ReadonlySet<string> = new Set(["agent_busy", ...reasons]);\n'
    );

    const result = extract(sourcePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Malformed SESSION_RESET_ERROR_REASONS literal/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
