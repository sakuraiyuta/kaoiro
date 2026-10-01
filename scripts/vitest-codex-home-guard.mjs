// A suite must reject an inherited Codex state home before loading test files.
if (process.env.CODEX_HOME) {
  throw new Error("Vitest inherited CODEX_HOME; run tests with env -u CODEX_HOME");
}
