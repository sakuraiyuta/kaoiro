import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [rawRoot, outputPath] = process.argv.slice(2);

if (!rawRoot || !outputPath) {
  throw new Error("usage: summarizeIssue304.mjs <raw-root> <output-path>");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const rawFiles = fs
  .readdirSync(rawRoot)
  .filter((file) => file.endsWith(".json"))
  .sort();

const grouped = new Map();
const raw = rawFiles.map((file) => {
  const absolutePath = path.join(rawRoot, file);
  const result = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const key = `${result.scenario}\u0000${result.mode}\u0000${result.run}`;
  const entry = grouped.get(key) ?? {
    scenario: result.scenario,
    mode: result.mode,
    run: result.run,
  };

  entry[result.variant] = {
    p95: result.primary.dispatchToInput.p95,
    median: result.primary.dispatchToInput.median,
    longtasks: result.longTasks.length,
    formatTime: result.formatWork,
  };
  grouped.set(key, entry);

  return { file, sha256: sha256(absolutePath) };
});

const summary = {
  generator: {
    path: path.relative(path.dirname(outputPath), fileURLToPath(import.meta.url)),
    sha256: sha256(fileURLToPath(import.meta.url)),
  },
  raw: { path: rawRoot, files: raw },
  results: [...grouped.values()].sort(
    (left, right) =>
      left.scenario.localeCompare(right.scenario) ||
      left.mode.localeCompare(right.mode) ||
      left.run - right.run,
  ),
};

fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
