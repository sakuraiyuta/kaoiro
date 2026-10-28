#!/usr/bin/env node
// Enforces the test isolation contract (docs/contributing/test-isolation.md).
// The canonical Node entries come from the declared trees; test modules are
// selected by static imports and checked for the guard as their first import.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeSources, CANARIES as CONTENT_CANARIES, HELPERS as VITEST_HELPERS, PACKAGES as CONTENT_PACKAGES } from "./selection.mjs";

export const MODULE = "scripts/test/fixtures/test-isolation.mjs";
export const NODE_TREES = ["scripts/test", "server/deploy/test"];
// Programs and modules in a node --test tree that are not entries.
export const NODE_HELPERS = ["scripts/test/mock-github-api.mjs"];
export const VITEST_PACKAGES = CONTENT_PACKAGES;
export const CANARY = "test/test-isolation.canary.test.ts";
export const CANARIES = CONTENT_CANARIES;
const CANARY_HELPER = "scripts/test/fixtures/test-isolation-canary.mjs";
const DASHBOARD_SETUP = "dashboard/test/isolation.setup.ts";
const TYPESCRIPT = createRequire(new URL("../../runner/package.json", import.meta.url))("typescript");
const VITEST_HELPER_APIS = new Set(["vi", "expect"]);
const CANARY_MODULES = new Set(["vitest", CANARY_HELPER]);
const BUILTIN_MODULES = new Set(createRequire(import.meta.url)("node:module").builtinModules
  .flatMap(name => [name, `node:${name}`]));
export const EXEMPT = [
  { pattern: /^protocol\/src\/[^/]+\.type-test\.ts$/, reason: "compile-time type tests run by tsc" },
  { pattern: /^dashboard\/e2e\//, reason: "Playwright specs with their own runner; not in CI" },
];
// Files allowed to call permitHostAccess; the guard enforces their kinds.
export const PERMIT_ALLOW = createRequire(import.meta.url)("../test/fixtures/test-isolation-permits.cjs");

const SOURCE = /\.(?:js|cjs|mjs|ts|cts|mts)$/;
const PERMIT_SOURCE = /\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx|svelte)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_NAME = /(?:^|\/)(?:[^/]+[.\-_](?:test|spec)\.[^/]+|test[-.][^/]+)$/;
const TEST_DIR = /(?:^|\/)tests?\//;
const NO_MATCH = "^kaoiro-test-isolation-match-nothing$";

function files(root) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return [...new Set(result.stdout.split("\0").filter(Boolean))]
    .filter(path => !/(?:^|\/)node_modules\//.test(path) && existsSync(join(root, path))).sort();
}

const within = (path, tree) => path === tree || path.startsWith(`${tree}/`);

/** The module path the first import statement names, or undefined. */
export function firstImport(text) {
  const body = text.replace(/^#!.*\n/, "").replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return body.match(/^import\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/)?.[1];
}

function classifyNodeTrees(root, all, problems) {
  const entries = [];
  for (const path of all) {
    const tree = NODE_TREES.find(candidate => within(path, candidate));
    if (!tree || !SOURCE.test(path) || DECLARATION.test(path)) continue;
    if (path === MODULE || within(path, `${tree}/fixtures`) || NODE_HELPERS.includes(path)) continue;
    if (!path.endsWith(".test.mjs")) {
      problems.push(`${path}: not an entry (*.test.mjs) or a declared helper`);
      continue;
    }
    const imported = firstImport(readFileSync(join(root, path), "utf8"));
    if (!imported || posix.normalize(posix.join(posix.dirname(path), imported)) !== MODULE) {
      problems.push(`${path}: first import is not ${MODULE}`);
    }
    entries.push(path);
  }
  if (entries.length === 0) problems.push("node --test trees have no entries");
  return entries;
}

export function nodeEntries(root) {
  const problems = [];
  const entries = classifyNodeTrees(root, files(root), problems);
  return { entries, problems };
}

function recorder(scratch) {
  const path = join(scratch, "recorder.mjs");
  writeFileSync(path, `import { appendFileSync } from "node:fs";
if (process.env.NODE_TEST_CONTEXT && !process.env.KAOIRO_ISOLATION_RECORDED) {
  process.env.KAOIRO_ISOLATION_RECORDED = "1";
  const file = process.argv[1];
  process.on("exit", () => appendFileSync(process.env.KAOIRO_ISOLATION_RECORD, JSON.stringify({ file,
    marker: Boolean(globalThis[Symbol.for("kaoiro.test.isolation")]) }) + "\\n"));
}
`);
  return path;
}

// Runs the canonical node --test entries with a filter that matches no test,
// so each file process only loads its imports; the recorder reports its marker.
// `env -u` drops an isolation guard and test-runner context inherited from a
// calling test process, so the marker shows only what each file loads itself.
// A file without the guard still runs its top level here, so credentials are
// removed and host pointers lead nowhere.
const SCRUBBED = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "DOCKER_CONTEXT"];
function cleanEnvironment(scratch) {
  const nowhere = join(scratch, "nowhere");
  return ["-u", "NODE_OPTIONS", "-u", "KAOIRO_TEST_ISOLATION_CHILD", "-u", "NODE_TEST_CONTEXT",
    "-u", "KAOIRO_ISOLATION_RECORDED", ...SCRUBBED.flatMap(key => ["-u", key]),
    `DBUS_SESSION_BUS_ADDRESS=unix:path=${nowhere}/bus`, `XDG_RUNTIME_DIR=${nowhere}`,
    `DOCKER_HOST=unix://${nowhere}/docker.sock`, `DOCKER_CONFIG=${nowhere}`, `GH_CONFIG_DIR=${nowhere}`];
}

function discover(scratch, cwd, { files = [] }, label) {
  const record = join(scratch, `record-${Math.random().toString(16).slice(2)}.jsonl`);
  const command = `exec "$0" --test --test-name-pattern='${NO_MATCH}' "$@"`;
  const result = spawnSync("env", [...cleanEnvironment(scratch),
    `NODE_OPTIONS=--import=${pathToFileURL(recorder(scratch)).href}`, `KAOIRO_ISOLATION_RECORD=${record}`,
    "sh", "-c", command, process.execPath, ...files], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { label, status: result.status, output: `${result.stdout}${result.stderr}`.slice(0, 4_000), rows };
}

function runtimeProof(root, entries, scratch, problems) {
  const run = discover(scratch, root, { files: entries }, "canonical entries");
  if (run.status !== 0) problems.push(`canonical entries: node --test exited ${run.status}\n${run.output}`);
  const seen = new Map(run.rows.map(row => [relative(root, realpathSync(row.file)), row.marker]));
  for (const entry of entries) {
    if (!seen.has(entry)) problems.push(`${entry}: no file process reported (load failure or not discovered)`);
    else if (!seen.get(entry)) problems.push(`${entry}: loaded without the isolation marker`);
  }
  for (const file of seen.keys()) if (!entries.includes(file)) problems.push(`${file}: reported but not a canonical entry`);
}

function strayFiles(all, problems) {
  for (const path of all) {
    if (!SOURCE.test(path) || DECLARATION.test(path) || !(TEST_NAME.test(path) || TEST_DIR.test(path))) continue;
    if (NODE_TREES.some(tree => within(path, tree)) || VITEST_PACKAGES.some(pkg => within(path, `${pkg}/test`))) continue;
    if (EXEMPT.some(exempt => exempt.pattern.test(path))) continue;
    problems.push(`${path}: test file outside every declared tree`);
  }
}

function resolvedImport(path, specifier) {
  return posix.normalize(posix.join(posix.dirname(path), specifier));
}

function firstStatementIsTypeOnly(sourceFile) {
  const first = sourceFile.statements[0];
  return first && TYPESCRIPT.isImportDeclaration(first) && first.importClause?.isTypeOnly === true;
}

function importDeclarations(sourceFile) {
  return sourceFile.statements.filter(TYPESCRIPT.isImportDeclaration);
}

function canaryProblems(row, problems) {
  const imports = importDeclarations(row.sourceFile);
  const modules = imports.map(declaration => declaration.moduleSpecifier.text);
  if (!modules.includes("vitest")) problems.push(`${row.path}: setup probe must statically import vitest`);
  if (!modules.some(specifier => resolvedImport(row.path, specifier) === CANARY_HELPER)) {
    problems.push(`${row.path}: setup probe must import ${CANARY_HELPER}`);
  }
  for (const declaration of imports) {
    const specifier = declaration.moduleSpecifier.text;
    const resolved = specifier === "vitest" ? specifier : resolvedImport(row.path, specifier);
    if (resolved === MODULE || resolved === "dashboard/test/isolation.setup.ts") {
      problems.push(`${row.path}: setup probe must not import the isolation guard or package setup`);
    } else if (!CANARY_MODULES.has(resolved)) {
      problems.push(`${row.path}: setup probe imports unexpected module ${specifier}`);
    }
  }
}

function helperProblems(row, problems) {
  const declarations = importDeclarations(row.sourceFile).filter(declaration => declaration.moduleSpecifier.text === "vitest");
  if (declarations.length === 0) {
    problems.push(`${row.path}: stale Vitest helper exception; no static vitest import remains`);
    return;
  }
  for (const declaration of declarations) {
    const clause = declaration.importClause;
    const bindings = clause?.namedBindings;
    if (clause?.isTypeOnly || clause?.name || !bindings || !TYPESCRIPT.isNamedImports(bindings)) {
      problems.push(`${row.path}: Vitest helper may import only named vi/expect bindings`);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (!VITEST_HELPER_APIS.has(imported)) {
        problems.push(`${row.path}: Vitest helper imports unsupported API ${imported}`);
      }
    }
  }
}

function testModuleImports(root, all, entries, problems) {
  const { rows, problems: scanProblems } = analyzeSources(root, TYPESCRIPT, all);
  const byPath = new Map(rows.map(row => [row.path, row]));
  problems.push(...scanProblems);

  const dashboardSetup = byPath.get(DASHBOARD_SETUP);
  if (!all.includes(DASHBOARD_SETUP) || !dashboardSetup) {
    problems.push(`${DASHBOARD_SETUP}: missing`);
  } else {
    const first = firstImport(dashboardSetup.text);
    if (!first || resolvedImport(DASHBOARD_SETUP, first) !== MODULE) {
      problems.push(`${DASHBOARD_SETUP}: first import is not ${MODULE}`);
    } else if (firstStatementIsTypeOnly(dashboardSetup.sourceFile)) {
      problems.push(`${DASHBOARD_SETUP}: first import is type-only; ${MODULE} must load at runtime`);
    }
  }

  for (const helper of VITEST_HELPERS) {
    const row = byPath.get(helper);
    if (!all.includes(helper) || !row) problems.push(`${helper}: declared Vitest helper is missing`);
    else helperProblems(row, problems);
  }

  for (const row of rows) {
    if (row.imports.length === 0) continue;
    const { path } = row;
    if (row.imports.includes("node:test") && !entries.includes(path)) {
      problems.push(`${path}: node:test importer is not a canonical entry`);
    }
    if (CONTENT_CANARIES.includes(path)) {
      continue;
    }
    if (VITEST_HELPERS.includes(path)) continue;
    if (path === MODULE || path === "scripts/test/fixtures/test-isolation.cjs" || NODE_HELPERS.includes(path) ||
        NODE_TREES.some(tree => within(path, `${tree}/fixtures`))) continue;

    if (row.imports.includes("vitest") && !VITEST_PACKAGES.some(pkg => within(path, pkg))) {
      problems.push(`${path}: imports vitest outside a declared package`);
    }
    const expected = path.startsWith("dashboard/") ? "dashboard/test/isolation.setup" : MODULE;
    const first = firstImport(row.text);
    if (!first || resolvedImport(path, first) !== expected) {
      problems.push(`${path}: first import is not ${expected}`);
    } else if (firstStatementIsTypeOnly(row.sourceFile)) {
      problems.push(`${path}: first import is type-only; ${expected} must load at runtime`);
    }
  }

  return byPath;
}

// Runs each declared package's default Vitest listing. The guard-free canaries
// are setup probes: missing setup makes their module-scope assertion fail.
// This observes selected files and one default environment, not arbitrary
// config branches or isolation and pool values.
export function observeVitest(root, pkg, scratch) {
  const directory = join(root, pkg);
  const vitest = join(directory, "node_modules", ".bin", "vitest");
  if (!existsSync(vitest)) return [`${pkg}: cannot observe the suite: vitest is not installed (install dependencies first)`];
  const result = spawnSync("env", [...cleanEnvironment(scratch), vitest, "list", "--json"],
    { cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { rows = undefined; }
  if (result.status !== 0 || !Array.isArray(rows)) {
    return [`${pkg}: vitest list exited ${result.status}\n${`${result.stdout}${result.stderr}`.slice(-4_000)}`];
  }
  const problems = [];
  const projects = new Set(rows.map(row => row.projectName ?? ""));
  if (projects.size !== 1) problems.push(`${pkg}: vitest selects ${projects.size} projects; exactly one is required`);
  const files = new Set(rows.map(row => relative(root, realpathSync(row.file))));
  for (const canary of CANARIES.filter(path => within(path, pkg))) {
    const short = canary.slice(pkg.length + 1);
    if (!files.has(canary)) problems.push(`${pkg}: vitest does not select ${short}`);
  }
  return problems;
}

function vitestWiring(root, all, sourceRows, scratch, observe, problems) {
  const owners = new Set();
  for (const path of all) {
    const base = posix.basename(path);
    const config = /^(?:vitest\.(?:config|workspace)|vite\.config)\.[cm]?[jt]s$/.test(base);
    if (config && (base.startsWith("vitest") || /\btest\s*:/.test(readFileSync(join(root, path), "utf8")))) owners.add(posix.dirname(path));
  }
  for (const owner of owners) if (!VITEST_PACKAGES.includes(owner)) problems.push(`${owner}: vitest package outside the declared inventory`);
  for (const canary of CONTENT_CANARIES) {
    const pkg = VITEST_PACKAGES.find(candidate => within(canary, candidate));
    const short = canary.slice(pkg.length + 1);
    const row = sourceRows.get(canary);
    if (!all.includes(canary) || !row) {
      problems.push(`${pkg}: missing ${short}`);
      continue;
    }
    if (!/^await assertIsolationActive\(\);$/m.test(row.text)) {
      problems.push(`${canary}: does not assert the guard at module scope (await assertIsolationActive();)`);
    }
    canaryProblems(row, problems);
  }
  const helper = sourceRows.get(CANARY_HELPER);
  if (!helper) problems.push(`${CANARY_HELPER}: missing`);
  else for (const declaration of importDeclarations(helper.sourceFile)) {
    const specifier = declaration.moduleSpecifier.text;
    if (!BUILTIN_MODULES.has(specifier)) {
      problems.push(`${CANARY_HELPER}: imports non-builtin module ${specifier}`);
    }
  }
  for (const pkg of VITEST_PACKAGES) {
    problems.push(...observe(root, pkg, scratch));
  }
  setupOrder(root, all, problems);
}

const SETUP_EXEMPT = ["scripts/test-isolation/check.mjs", "scripts/test/check-test-isolation.test.mjs"];
const PACKAGE_CONFIG = /^(?:vitest|vite)\.config\.[cm]?[jt]s$/;

// Order is not observable from the listing, so readable setupFiles declarations
// in the declared package configs are checked as source text. Config code that
// changes resolved values remains outside this declaration check.
function setupOrder(root, all, problems) {
  for (const path of all) {
    if (!PERMIT_SOURCE.test(path) || DECLARATION.test(path) || SETUP_EXEMPT.includes(path)) continue;
    const text = readFileSync(join(root, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (!/\bsetupFiles\b/.test(text)) continue;
    if (!VITEST_PACKAGES.includes(posix.dirname(path)) || !PACKAGE_CONFIG.test(posix.basename(path))) {
      problems.push(`${path}: setupFiles outside a declared package's vitest or vite config`);
      continue;
    }
    const sequences = text.match(/\bsequence\s*:\s*\{[^}]*\}/g) ?? [];
    const rest = sequences.reduce((current, block) => current.replace(block, ""), text);
    const list = rest.match(/\bsetupFiles\s*:\s*\[([^\]]*)\]/)?.[1];
    if ((rest.match(/\bsetupFiles\b/g) ?? []).length !== 1 || sequences.length > 1 || list === undefined ||
        list.replace(/"[^"]*"|'[^']*'/g, "").replace(/[\s,]/g, "") !== "") {
      problems.push(`${path}: setupFiles must be a single list of string literals the checker can read`);
      continue;
    }
    const entries = [...list.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
    if (entries.length > 1 && !sequences.some(block => /setupFiles\s*:\s*["']list["']/.test(block))) {
      problems.push(`${path}: several setupFiles run in parallel unless sequence.setupFiles is "list"`);
    }
    let loaded = entries[0] && posix.normalize(posix.join(posix.dirname(path), entries[0]));
    // One hop: a package-local setup file whose first import is the module.
    if (loaded && loaded !== MODULE && all.includes(loaded)) {
      const hop = firstImport(readFileSync(join(root, loaded), "utf8"));
      loaded = hop && posix.normalize(posix.join(posix.dirname(loaded), hop));
    }
    if (loaded !== MODULE) problems.push(`${path}: setupFiles does not load ${MODULE} first`);
  }
}

const PERMIT_EXEMPT = [MODULE, "scripts/test/fixtures/test-isolation.cjs", "scripts/test/fixtures/test-isolation-permits.cjs",
  "scripts/test-isolation/check.mjs"];

// Early notice only: the guard checks the calling file and its kinds at run
// time. Any mention counts, so an aliased import cannot hide a call site.
function permitCalls(root, all, problems) {
  for (const path of all) {
    if (!PERMIT_SOURCE.test(path) || DECLARATION.test(path) || PERMIT_EXEMPT.includes(path)) continue;
    if (!PERMIT_ALLOW[path] && readFileSync(join(root, path), "utf8").includes("permitHostAccess")) {
      problems.push(`${path}: permitHostAccess outside the allow-list`);
    }
  }
}

/** Returns the contract violations for the repository at root. */
export function checkTestIsolation(root, { observe = observeVitest } = {}) {
  const problems = [];
  root = realpathSync(root);
  const all = files(root);
  if (!all.includes(MODULE)) problems.push(`${MODULE}: missing`);
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro-isolation-check-"));
  try {
    const entries = classifyNodeTrees(root, all, problems);
    const sourceRows = testModuleImports(root, all, entries, problems);
    if (entries.length > 0) runtimeProof(root, entries, scratch, problems);
    strayFiles(all, problems);
    vitestWiring(root, all, sourceRows, scratch, observe, problems);
    permitCalls(root, all, problems);
    return { entries: entries.length, problems };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const CI_WORKFLOW = ".github/workflows/ci.yml";
const CI_JOB = "test-isolation";
// The job's two steps must stay connected: the checker is the one real
// observation, and the tests keep its CLI and this reader honest. Each side
// checks the other, so dropping either step fails the one that remains.
const CI_STEPS = ["- run: node scripts/test-isolation/check.mjs",
  "- run: node scripts/test-isolation/run-node-tests.mjs",
  "- run: node --test scripts/test/test-isolation.test.mjs scripts/test/check-test-isolation.test.mjs scripts/test/child-process-environment.test.mjs scripts/test/codex-backend-compatibility.test.mjs"];
const CI_UNSAFE_KEY = /^(?:-\s+)?(?:continue-on-error|if)\s*:/;

/** Returns how the test-isolation job of a workflow fails to run the checker and its tests. */
export function ciWiringProblems(text) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${CI_JOB}:`);
  if (start < 0) return [`${CI_WORKFLOW}: job ${CI_JOB} not found`];
  const next = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  const job = lines.slice(start + 1, next < 0 ? undefined : next).map(line => line.trim());
  const problems = CI_STEPS.filter(step => !job.includes(step))
    .map(step => `${CI_WORKFLOW} job ${CI_JOB}: missing the step \`${step}\``);
  for (const line of job.filter(line => CI_UNSAFE_KEY.test(line))) {
    problems.push(`${CI_WORKFLOW} job ${CI_JOB}: \`${line}\` can skip a step or let it fail without failing the job`);
  }
  return problems;
}

/** The checker's own problems plus the workflow wiring problems of the same tree. */
export function checkRepository(root, options) {
  const { entries, problems } = checkTestIsolation(root, options);
  const workflow = join(root, CI_WORKFLOW);
  problems.push(...(existsSync(workflow) ? ciWiringProblems(readFileSync(workflow, "utf8")) : [`${CI_WORKFLOW}: missing`]));
  return { entries, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)));
  const { entries, problems } = checkRepository(root);
  for (const problem of problems) console.error(problem);
  console.log(JSON.stringify({ entries, problems: problems.length }));
  process.exitCode = problems.length === 0 ? 0 : 1;
}
