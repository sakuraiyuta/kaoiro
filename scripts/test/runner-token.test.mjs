import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = process.env.RUNNER_TOKEN_HELPER ??
  fileURLToPath(new URL("../lib/runner-token.sh", import.meta.url));

function tokenFor(input, host = "h") {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; runner_token_for_host "$2"', "bash", helper, host],
    { input, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function tokensFromEnvFile(content) {
  const directory = mkdtempSync(join(tmpdir(), "momo-runner-token-test-"));
  const envFile = join(directory, ".env");

  try {
    writeFileSync(envFile, content);
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; runner_tokens_from_env_file "$2"', "bash", helper, envFile],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function dogfoodTokenFor(content, host = "h") {
  const directory = mkdtempSync(join(tmpdir(), "momo-runner-token-test-"));
  const envFile = join(directory, ".env");

  try {
    writeFileSync(envFile, content);
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; value=$(runner_tokens_from_env_file "$2"); printf "%s" "$value" | runner_token_for_host "$3"',
        "bash",
        helper,
        envFile,
        host,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("runner token helper follows the server pair parser for supported inputs", () => {
  const cases = [
    ["h:ab:cd", "h", "ab:cd\n"],
    [" \th\t : \tab\t ", "h", "ab\n"],
    ["h:old,h:new", "h", "new\n"],
    ["h:old,h:   ", "h", ""],
    ["h:old,h:", "h", "old\n"],
    ["h:old,h:\r\n", "h", ""],
    ["h:old,h:\n", "h", ""],
    ["h:tok\r\n", "h", "tok\n"],
    ["h:one\ntwo", "h", ""],
    ["missing,h:token", "h", "token\n"],
    ["a:token", "h", ""],
    ["h.x\\y:token", "h.x\\y", "token\n"],
    ["", "h", ""],
  ];

  for (const [input, host, expected] of cases) {
    assert.equal(tokenFor(input, host), expected, JSON.stringify({ input, host }));
  }
});

test("runner token env extraction strips only the record terminator", () => {
  const cases = [
    ["KAOIRO_RUNNER_TOKENS=h:old,h:\n", "h:old,h:"],
    ["KAOIRO_RUNNER_TOKENS=h:old,h:\r\n", "h:old,h:"],
    ["KAOIRO_RUNNER_TOKENS=\"h:old,h:\"\n", "h:old,h:"],
    ["# KAOIRO_RUNNER_TOKENS=h:ignored\n  KAOIRO_RUNNER_TOKENS=h:first\nKAOIRO_RUNNER_TOKENS=h:last\n", "h:last"],
    ["  # KAOIRO_RUNNER_TOKENS=h:ignored\n", ""],
    ["", ""],
  ];

  for (const [content, expected] of cases) {
    assert.equal(tokensFromEnvFile(content), expected, JSON.stringify({ content }));
  }
});

test("dogfood extraction preserves the server parser's raw-empty distinction", () => {
  assert.equal(dogfoodTokenFor("KAOIRO_RUNNER_TOKENS=h:old,h:\n"), "old\n");
  assert.equal(dogfoodTokenFor("KAOIRO_RUNNER_TOKENS=h:old,h:   \n"), "");
});
