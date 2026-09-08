import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [rawRoot, outputPath, v1RawRoot, v1LogPath, v1ExitCode] =
  process.argv.slice(2);

if (
  !rawRoot ||
  !outputPath ||
  (v1RawRoot !== undefined && (!v1LogPath || v1ExitCode === undefined))
) {
  throw new Error(
    "usage: summarizeIssue304.mjs <raw-root> <output-path> [<v1-raw-root> <v1-log-path> <v1-exit-code>]",
  );
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function rawRecords(root) {
  return fs
    .readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const absolutePath = path.join(root, file);
      return {
        file,
        sha256: sha256(absolutePath),
        result: JSON.parse(fs.readFileSync(absolutePath, "utf8")),
      };
    });
}

function relativeGate(records, mode) {
  const p95s = (scenario) =>
    records
      .filter(
        ({ result }) =>
          result.variant === "after" &&
          result.mode === mode &&
          result.scenario === scenario,
      )
      .map(({ result }) => result.primary.dispatchToInput.p95);
  const expanded = median(p95s("h1000-expanded"));
  const tail = median(p95s("h1000-tail"));
  return {
    expanded,
    tail,
    limit: tail + 8,
    excess: expanded - tail - 8,
  };
}

function v1SourceBinding(records) {
  const sources = records.map(({ result }) => result.source);
  const first = sources[0];
  if (!first) throw new Error("v1 raw directory is empty");
  const stable = ({ buildSha256: _build, ...source }) => source;
  const expected = JSON.stringify(stable(first));
  if (sources.some((source) => JSON.stringify(stable(source)) !== expected)) {
    throw new Error("v1 raw records disagree on their source binding");
  }
  return {
    ...stable(first),
    buildSha256ByVariant: Object.fromEntries(
      [...new Set(records.map(({ result }) => result.variant))]
        .sort()
        .map((variant) => [
          variant,
          [...new Set(
            records
              .filter(({ result }) => result.variant === variant)
              .map(({ result }) => result.source.buildSha256),
          )].sort(),
        ]),
    ),
  };
}

const records = rawRecords(rawRoot);

const grouped = new Map();
const failures = [];
const raw = records.map(({ file, sha256: fileSha256, result }) => {
  const manifest = { file, sha256: fileSha256 };
  if (result.status === "failed") {
    failures.push({
      ...manifest,
      stage: result.stage,
      error: result.error,
    });
    return manifest;
  }
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

  return manifest;
});

const v1 =
  v1RawRoot === undefined
    ? undefined
    : (() => {
        const records = rawRecords(v1RawRoot);
        const parsedExitCode = Number.parseInt(v1ExitCode, 10);
        if (!Number.isInteger(parsedExitCode) || parsedExitCode === 0) {
          throw new Error("v1 exit code must be a nonzero integer");
        }
        return {
          status: "failed",
          generatorExitCode: parsedExitCode,
          raw: {
            path: v1RawRoot,
            files: records.map(({ file, sha256 }) => ({ file, sha256 })),
          },
          log: { path: v1LogPath, sha256: sha256(v1LogPath) },
          source: v1SourceBinding(records),
          relativeGate: Object.fromEntries(
            ["ascii", "ime"].map((mode) => [mode, relativeGate(records, mode)]),
          ),
        };
      })();

const summary = {
  generator: {
    path: path.relative(path.dirname(outputPath), fileURLToPath(import.meta.url)),
    sha256: sha256(fileURLToPath(import.meta.url)),
  },
  raw: { path: rawRoot, files: raw },
  failures,
  ...(v1 === undefined ? {} : { historicalV1RelativeGate: v1 }),
  results: [...grouped.values()].sort(
    (left, right) =>
      left.scenario.localeCompare(right.scenario) ||
      left.mode.localeCompare(right.mode) ||
      left.run - right.run,
  ),
};

fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
