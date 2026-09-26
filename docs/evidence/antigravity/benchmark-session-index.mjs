import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const { listAntigravitySessionsFrom } = await import(
  pathToFileURL(join(process.cwd(), "runner/dist/sessions.js")).href
);
const totalRows = 12_000;
const nestedRows = 500;
const runCount = 30;
const matchEvery = Number(process.env.MATCH_EVERY ?? "2");
if (!Number.isInteger(matchEvery) || matchEvery < 1) {
  throw new Error("MATCH_EVERY must be a positive integer");
}
const pad = (value, width) => String(value).padStart(width, "0");
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};
const format = (values) => ({
  p50_ms: Number(percentile(values, 0.5).toFixed(2)),
  p95_ms: Number(percentile(values, 0.95).toFixed(2)),
  max_ms: Number(Math.max(...values).toFixed(2)),
});

const root = mkdtempSync(join(tmpdir(), "hiiro386-session-index-bench-"));
try {
  const cwd = join(root, "workspace");
  const dbPath = join(root, "conversation_summaries.db");
  mkdirSync(cwd);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA user_version=3;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      last_modified_time datetime NOT NULL,
      workspace_uris TEXT NOT NULL,
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      killed numeric NOT NULL DEFAULT false
    );
    CREATE INDEX idx_last_modified_time
      ON conversation_summaries(last_modified_time);
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, preview, last_modified_time, workspace_uris, nesting_depth)
    VALUES (?, ?, '', ?, ?, ?)
  `);
  db.exec("BEGIN");
  for (let i = 0; i < totalRows; i += 1) {
    const workspace = i % matchEvery === 0
      ? cwd
      : join(root, `other-${i % 37}`);
    const customization = join(root, `custom-${pad(i, 6)}`);
    const timestamp = `2026-${pad(1 + (i % 9), 2)}-${pad(1 + (i % 28), 2)} ${pad(i % 24, 2)}:${pad(i % 60, 2)}:${pad((i * 7) % 60, 2)}.${pad((i * 977) % 1_000_000_000, 9)}+00:00`;
    const id = `${pad(i, 8)}-0000-4000-8000-000000000000`;
    const uris = JSON.stringify([
      pathToFileURL(workspace).href,
      pathToFileURL(customization).href,
    ]);
    insert.run(id, `title ${i}`, timestamp, uris, 0);
  }
  for (let i = 0; i < nestedRows; i += 1) {
    insert.run(
      `nested00-${pad(i, 4)}-4000-8000-000000000000`,
      "nested",
      "2026-09-26 10:00:00.000000000+00:00",
      JSON.stringify([pathToFileURL(cwd).href]),
      1,
    );
  }
  db.exec("COMMIT");
  const actualRows = db.prepare(
    "SELECT COUNT(*) AS count FROM conversation_summaries WHERE nesting_depth = 0",
  ).get().count;
  const candidates = db.prepare(`
    SELECT workspace_uris
    FROM conversation_summaries
    WHERE nesting_depth = 0
    ORDER BY last_modified_time DESC
    LIMIT 10000
  `).all();
  db.close();
  if (actualRows !== totalRows) {
    throw new Error(`expected ${totalRows} top-level fixture rows, found ${actualRows}`);
  }

  const first = listAntigravitySessionsFrom(dbPath, cwd, { warn: () => {} });
  const cwdUri = pathToFileURL(cwd).href;
  let matcherCalls = 0;
  let candidateMatches = 0;
  for (const row of candidates) {
    matcherCalls += 1;
    if (JSON.parse(row.workspace_uris).includes(cwdUri)) candidateMatches += 1;
    if (candidateMatches >= 500) break;
  }
  const samples = [];
  for (let i = 0; i < runCount; i += 1) {
    const started = performance.now();
    listAntigravitySessionsFrom(dbPath, cwd, { warn: () => {} });
    samples.push(performance.now() - started);
  }
  process.stdout.write(`${JSON.stringify({
    node: process.version,
    candidate_window: 10_000,
    fixture_top_level_rows: totalRows,
    fixture_nested_rows: nestedRows,
    match_every: matchEvery,
    candidate_matches: candidates.filter((row) => JSON.parse(row.workspace_uris).includes(cwdUri)).length,
    matcher_calls_until_limit: matcherCalls,
    returned_rows: first.length,
    listing: format(samples),
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
