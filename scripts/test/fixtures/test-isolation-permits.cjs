// Files allowed to call permitHostAccess, with the kinds each may relax.
// test-isolation.cjs enforces it at run time against the calling file;
// scripts/test-isolation/check.mjs reads it to flag other mentions early.
// Plain data so the checker can read it without installing the guard.
"use strict";
const grok = ["history", "inspect", "lifecycle", "mcp", "permission-answer", "permission-switch",
  "rate-limits", "resume", "sandbox"].map(name => [`wrapper/grok/test/native-${name}.test.ts`, ["network"]]);

const table = {
  "scripts/test/test-isolation.test.mjs": ["systemd"],
  "scripts/test/fixtures/test-isolation-permit-probe.cjs": ["systemd"],
  "scripts/test/runner-pairing.test.mjs": ["docker"],
  "runner/test/grok_sessions.native.test.ts": ["network"],
  "wrapper/antigravity/test/agy131_native.test.ts": ["network"],
  "wrapper/antigravity/test/live_agy_stream_input.test.ts": ["network"],
  "wrapper/claude-code/test/haiku55_native.test.ts": ["network"],
  ...Object.fromEntries(grok),
};

module.exports = Object.freeze(Object.fromEntries(Object.entries(table)
  .map(([file, kinds]) => [file, Object.freeze(kinds)])));
