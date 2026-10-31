#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeEntries } from "./check.mjs";
import { NODE_CI_EXCEPTIONS } from "./node-ci-exceptions.mjs";

const REPORTER = fileURLToPath(new URL("./node-reporter.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function entryProblem(path, row, exempt) {
  if (!row.reached) return `${path}: no Node test event`;
  if (exempt && row.real) return `${path}: stale exception, a real test ran`;
  if (!exempt && !row.real) return `${path}: no real test ran`;
  return undefined;
}

export function runNodeEntries(root, entries, exceptions = NODE_CI_EXCEPTIONS, { stderr = "inherit" } = {}) {
  root = realpathSync(root);
  const problems = [];
  const exempt = new Set();
  for (const record of exceptions) {
    const path = record?.path;
    if (!record || Object.keys(record).sort().join(",") !== "issue,path,reason" ||
        typeof path !== "string" || !entries.includes(path) || exempt.has(path) ||
        !existsSync(resolve(root, path)) || !Number.isSafeInteger(record.issue) || record.issue <= 0 ||
        typeof record.reason !== "string" || !record.reason.trim() ||
        spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: root, stdio: "ignore" }).status !== 0) {
      problems.push(`invalid or stale exception: ${String(path)}`);
    } else exempt.add(path);
  }
  if (!entries.length) problems.push("no canonical Node test entries");
  if (problems.length) return problems;
  const absolute = entries.map(path => resolve(root, path));
  const env = { ...process.env };
  env.KAOIRO_PREGATE_REAL = "1";
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-reporter=${REPORTER}`, "--test-reporter-destination=stdout",
    "--test-reporter=spec", "--test-reporter-destination=stderr", ...absolute],
    { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", stderr], maxBuffer: 64 * 1024 * 1024 });
  if (run.error || run.status !== 0) problems.push(`Node test runner failed: ${run.error?.message ?? run.status}`);
  const seen = new Map(absolute.map(path => [path, { reached: false, real: 0 }]));
  for (const line of run.stdout.trim().split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { problems.push("Node test reporter returned invalid JSON"); continue; }
    if (!event || !["test:pass", "test:fail"].includes(event.event) || typeof event.file !== "string" ||
        !isAbsolute(event.file) || typeof event.name !== "string" || typeof event.nesting !== "number" ||
        typeof event.line !== "number" || typeof event.column !== "number" || typeof event.type !== "string" ||
        typeof event.skip !== "boolean" || typeof event.todo !== "boolean") {
      problems.push("Node test reporter returned an invalid event");
      continue;
    }
    const file = resolve(event.file);
    const row = seen.get(file);
    if (!row) { problems.push(`unexpected Node test event: ${file}`); continue; }
    row.reached = true;
    if (event.event === "test:fail") problems.push(`${file}: test failed: ${event.name}: ${event.error ?? "unknown"}`);
    const synthetic = event.nesting === 0 && event.name === file && event.line === 1 && event.column === 1;
    if (event.event === "test:pass" && event.type === "test" && !event.skip && !event.todo && !synthetic) row.real++;
  }
  for (const [index, file] of absolute.entries()) {
    const row = seen.get(file);
    const problem = entryProblem(entries[index], row, exempt.has(entries[index]));
    if (problem) problems.push(problem);
    else console.log(`${entries[index]}: ${row.real} real test(s)${exempt.has(entries[index]) ? " (exception)" : ""}`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { entries, problems } = nodeEntries(ROOT);
  if (!problems.length) problems.push(...runNodeEntries(ROOT, entries));
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}
