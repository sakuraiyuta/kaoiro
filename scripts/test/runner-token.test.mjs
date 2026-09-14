import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("runner token helper follows the server pair parser for supported inputs", () => {
  const cases = [
    ["h:ab:cd", "h", "ab:cd\n"],
    [" \th\t : \tab\t ", "h", "ab\n"],
    ["h:old,h:new", "h", "new\n"],
    ["h:old,h:   ", "h", ""],
    ["h:old,h:", "h", "old\n"],
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
