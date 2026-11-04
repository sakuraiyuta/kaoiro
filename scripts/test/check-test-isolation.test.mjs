import "./fixtures/test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANARIES, checkRepository, checkTestIsolation, ciWiringProblems, MODULE, observeVitest, VITEST_PACKAGES } from "../test-isolation/check.mjs";
import { analyzeSources } from "../test-isolation/selection.mjs";

const REAL_MODULE = fileURLToPath(new URL("./fixtures/test-isolation.mjs", import.meta.url));
const REAL_REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));
// Built by concatenation so this file is not itself a permit call site.
const PERMIT = "permit" + "HostAccess";
const CANARY_HELPER = "scripts/test/fixtures/test-isolation-canary.mjs";
const TYPESCRIPT = createRequire(new URL("../../runner/package.json", import.meta.url))("typescript");

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const importLine = path => `import "${posix.relative(posix.dirname(path), MODULE).replace(/^(?!\.)/, "./")}";\n`;
const entry = path => `${importLine(path)}import { test } from "node:test";\ntest("fixture", () => {});\n`;
const canaryText = path => {
  const helper = posix.relative(posix.dirname(path), CANARY_HELPER);
  return `import { it } from "vitest";\nimport { assertIsolationActive } from "${helper}";\n` +
    'await assertIsolationActive();\nit("canary", async () => { await assertIsolationActive(); });\n';
};

// A minimal repository that satisfies the contract; each test breaks one thing.
function fixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "kaoiro577-checker-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, MODULE, readFileSync(REAL_MODULE, "utf8"));
  for (const suffix of [".cjs", "-permits.cjs", "-canary.mjs"]) {
    write(root, MODULE.replace(/\.mjs$/, suffix), readFileSync(REAL_MODULE.replace(/\.mjs$/, suffix), "utf8"));
  }
  for (const helper of ["wrapper/codex/test/app_server_approval_harness.ts", "wrapper/codex/test/fixtures/cli_app_server.ts",
    "wrapper/codex/test/fixtures/notice_tap.ts"]) {
    write(root, helper, readFileSync(join(REAL_REPOSITORY, helper), "utf8"));
  }
  write(root, "scripts/test/mock-github-api.mjs", "export {};\n");
  write(root, "scripts/test/a.test.mjs", entry("scripts/test/a.test.mjs"));
  write(root, "scripts/test/fixtures/helper.mjs", "export {};\n");
  write(root, "server/deploy/test/b.test.mjs", entry("server/deploy/test/b.test.mjs"));
  write(root, "server/deploy/package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  for (const pkg of VITEST_PACKAGES) {
    const setupFile = pkg === "dashboard" ? "test/isolation.setup.ts" : posix.relative(pkg, MODULE);
    write(root, `${pkg}/vitest.config.ts`, `export default { test: { setupFiles: ["${setupFile}"] } };\n`);
    if (pkg === "dashboard") write(root, "dashboard/test/isolation.setup.ts", importLine("dashboard/test/isolation.setup.ts"));
    write(root, `${pkg}/test/other.test.ts`, "export {};\n");
    write(root, `${pkg}/package.json`, JSON.stringify({ scripts: { test: "vitest run" } }));
  }
  for (const path of CANARIES) write(root, path, canaryText(path));
  write(root, ".github/workflows/ci.yml", [
    "on:", "  push:", "jobs:", "  scripts:", "    runs-on: ubuntu-latest", "    steps:",
    "      - run: node --test scripts/test/a.test.mjs", "  deploy:", "    defaults:", "      run:",
    "        working-directory: server/deploy", "    steps:", "      - run: node --test", ""].join("\n"));
  return root;
}

function problemsAfter(mutate) {
  const root = fixtureRepository();
  try {
    mutate(root);
    // Grammar and wiring only; observeVitest is exercised against a real
    // Vitest below and by the real repository test.
    return checkTestIsolation(root, { observe: () => [] }).problems;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a repository that follows the contract has no problems", () => {
  assert.deepEqual(problemsAfter(() => {}), []);
});

test("a guard-first sequential setup list is accepted", () => {
  assert.deepEqual(problemsAfter(root => write(root, "runner/vitest.config.ts",
    'export default { test: { sequence: { setupFiles: "list" }, setupFiles: ["' +
      posix.relative("runner", MODULE) + '", "test/setup.ts"] } };\n')), []);
});

test("a package-local setup file that imports the module first is accepted", () => {
  assert.deepEqual(problemsAfter(root => {
    write(root, "dashboard/test/isolation.setup.ts", 'import "../../scripts/test/fixtures/test-isolation.mjs";\n');
    write(root, "dashboard/vitest.config.ts", 'export default { test: { setupFiles: ["test/isolation.setup.ts"] } };\n');
  }), []);
});

test("the dashboard first-import hop must load the shared guard directly", () => {
  const path = "dashboard/test/isolation.setup.ts";
  const problems = problemsAfter(root => write(root, path, 'import "./other.ts";\n'));
  assert.ok(problems.includes(`${path}: first import is not ${MODULE}`), problems.join("\n"));
});

test("the dashboard first-import hop must load the guard at runtime", () => {
  const path = "dashboard/test/isolation.setup.ts";
  const problems = problemsAfter(root => write(root, path,
    'import type {} from "../../scripts/test/fixtures/test-isolation.mjs";\n'));
  assert.ok(problems.includes(`${path}: first import is type-only; ${MODULE} must load at runtime`), problems.join("\n"));
});

test("a missing dashboard first-import hop is reported", () => {
  const path = "dashboard/test/isolation.setup.ts";
  const problems = problemsAfter(root => rmSync(join(root, path)));
  assert.ok(problems.includes(`${path}: missing`), problems.join("\n"));
});

test("a dashboard setup with no import is rejected", () => {
  const path = "dashboard/test/isolation.setup.ts";
  const problems = problemsAfter(root => write(root, path, "export {};\n"));
  assert.ok(problems.includes(`${path}: first import is not ${MODULE}`), problems.join("\n"));
  assert.equal(problems.some(problem => problem.includes("first import is type-only")), false, problems.join("\n"));
});

test("source selection ignores node_modules, declarations, non-source files, and deleted paths", () => {
  const root = fixtureRepository();
  const ignored = [
    "runner/node_modules/fixture.test.ts",
    "runner/test/fixture.test.d.ts",
    "runner/test/fixture.test.md",
    "runner/test/deleted.test.ts",
  ];
  try {
    for (const path of ignored) {
      write(root, path, 'import { it } from "vitest";\n');
      execFileSync("git", ["add", "-f", path], { cwd: root });
    }
    rmSync(join(root, "runner/test/deleted.test.ts"));
    const { rows } = analyzeSources(root, TYPESCRIPT);
    for (const path of ignored) assert.equal(rows.some(row => row.path === path), false, path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit source selection applies the same exclusions", () => {
  const root = fixtureRepository();
  const selected = "runner/test/selected.test.ts";
  const ignored = [
    "runner/node_modules/fixture.test.ts",
    "runner/test/fixture.test.d.ts",
    "runner/test/fixture.test.md",
    "runner/test/deleted.test.ts",
  ];
  try {
    write(root, selected, "export {};\n");
    for (const path of ignored) write(root, path, "export {};\n");
    rmSync(join(root, "runner/test/deleted.test.ts"));
    const { rows } = analyzeSources(root, TYPESCRIPT, [selected, ...ignored]);
    assert.deepEqual(rows.map(row => row.path), [selected]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source selection reports a git listing failure", () => {
  const root = mkdtempSync(join(tmpdir(), "kaoiro-selection-not-repository-"));
  try {
    assert.throws(() => analyzeSources(root, TYPESCRIPT), /git ls-files failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("content selection parses JSX syntax in TSX files", () => {
  const path = "wrapper/core/test/component.test.tsx";
  const problems = contentProblems(path,
    importLine(path) + 'import { it } from "vitest";\nconst view = <div />;\nit("x", () => {});\n');
  assert.deepEqual(problems, []);
});

function contentProblems(path, text, tracked = false) {
  const root = fixtureRepository();
  try {
    write(root, path, text);
    if (tracked) execFileSync("git", ["add", path], { cwd: root });
    return checkTestIsolation(root, { observe: () => [] }).problems;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const mutations = {
  "an existing scripts entry loses its first import": [
    root => write(root, "scripts/test/a.test.mjs", 'import { test } from "node:test";\ntest("x", () => {});\n'),
    /scripts\/test\/a\.test\.mjs: first import is not/],
  "an existing deploy entry loses its first import": [
    root => write(root, "server/deploy/test/b.test.mjs", 'import { test } from "node:test";\ntest("x", () => {});\n'),
    /server\/deploy\/test\/b\.test\.mjs: first import is not/],
  "a new entry without the import": [
    root => write(root, "scripts/test/new.test.mjs", 'import { test } from "node:test";\n'),
    /scripts\/test\/new\.test\.mjs: first import is not/],
  "an unlisted helper in a node:test tree": [
    root => write(root, "scripts/test/helper.mjs", "export {};\n"),
    /scripts\/test\/helper\.mjs: not an entry/],
  "a named test outside every declared tree": [
    root => write(root, "server/deploy/new.test.mjs", entry("server/deploy/new.test.mjs")),
    /server\/deploy\/new\.test\.mjs: test file outside every declared tree/],
  "a Vitest file without a guard": [
    root => write(root, "wrapper/core/test/named-oddly.ts", 'import { it } from "vitest";\n'),
    /wrapper\/core\/test\/named-oddly\.ts: first import is not/],
  "a setup probe gains the shared guard": [
    root => write(root, "runner/test/test-isolation.canary.test.ts",
      importLine("runner/test/test-isolation.canary.test.ts") + canaryText("runner/test/test-isolation.canary.test.ts")),
    /setup probe must not import the isolation guard/],
  "a dashboard setup file does not load the guard first": [
    root => write(root, "dashboard/test/isolation.setup.ts", 'import "./other.ts";\n'),
    /dashboard\/vitest\.config\.ts: setupFiles does not load/],
  "a helper gains a test registration API through an alias": [
    root => write(root, "wrapper/codex/test/fixtures/notice_tap.ts",
      readFileSync(join(root, "wrapper/codex/test/fixtures/notice_tap.ts"), "utf8") + 'import { it as register } from "vitest";\n'),
    /Vitest helper imports unsupported API it/],
  "a declared helper becomes stale": [
    root => rmSync(join(root, "wrapper/codex/test/fixtures/notice_tap.ts")),
    /wrapper\/codex\/test\/fixtures\/notice_tap\.ts: declared Vitest helper is missing/],
  "a non-exempt fixture sibling lacks the guard": [
    root => write(root, "wrapper/codex/test/fixtures/new-helper.ts", 'import { it } from "vitest";\n'),
    /wrapper\/codex\/test\/fixtures\/new-helper\.ts: first import is not/],
  "a canary helper imports a non-builtin module": [
    root => write(root, "scripts/test/fixtures/test-isolation-canary.mjs",
      'import "../test-isolation.mjs";\nexport async function assertIsolationActive() {}\n'),
    /test-isolation-canary\.mjs: imports non-builtin module/],
  "a vitest config outside the declared packages remains an error": [
    root => write(root, "extra/vitest.config.ts", "export default { test: {} };\n"),
    /extra: vitest package outside the declared inventory/],
  "a canary is missing its module-scope assertion": [
    root => write(root, "runner/test/test-isolation.canary.test.ts",
      canaryText("runner/test/test-isolation.canary.test.ts").replace("await assertIsolationActive();\n", "")),
    /runner\/test\/test-isolation\.canary\.test\.ts: does not assert the guard at module scope/],
  "several setup files run in parallel": [
    root => write(root, "runner/vitest.config.ts",
      'export default { test: { setupFiles: ["' + posix.relative("runner", MODULE) + '", "test/setup.ts"] } };\n'),
    /runner\/vitest\.config\.ts: several setupFiles run in parallel/],
  "a setup list reverses the guard order": [
    root => write(root, "runner/vitest.config.ts",
      'export default { test: { sequence: { setupFiles: "list" }, setupFiles: ["test/setup.ts", "' +
        posix.relative("runner", MODULE) + '"] } };\n'),
    /runner\/vitest\.config\.ts: setupFiles does not load/],
  "an aliased permit import is outside the allow-list": [
    root => write(root, "scripts/test/a.test.mjs",
      importLine("scripts/test/a.test.mjs") + 'import { ' + PERMIT + ' as allow } from "./fixtures/test-isolation.mjs";\n' +
        'allow({ kinds: ["network"], optIn: "X", reason: "r" });\n'),
    new RegExp("scripts/test/a\\.test\\.mjs: " + PERMIT + " outside the allow-list")],
  "a correctly named import does not install the runtime guard": [
    root => write(root, MODULE, "export {};\n"),
    /scripts\/test\/a\.test\.mjs: loaded without the isolation marker/],
};

test("a canary import outside Vitest and the canonical helper is rejected", () => {
  const path = CANARIES.find(candidate => candidate.startsWith("runner/"));
  const unexpected = contentProblems(path, canaryText(path) + 'import "./unexpected.mjs";\n');
  assert.ok(unexpected.includes(`${path}: setup probe imports unexpected module ./unexpected.mjs`), unexpected.join("\n"));
});

test("a canary may not import the shared guard", () => {
  const path = CANARIES.find(candidate => candidate.startsWith("runner/"));
  const relativeGuard = posix.relative(posix.dirname(path), MODULE);
  const problems = contentProblems(path, canaryText(path) + `import "${relativeGuard}";\n`);
  const diagnostic = `${path}: setup probe must not import the isolation guard or package setup`;
  assert.equal(problems.filter(problem => problem === diagnostic).length, 1, problems.join("\n"));
});

test("a dashboard canary may not import its package setup", () => {
  const path = CANARIES.find(candidate => candidate.startsWith("dashboard/"));
  const problems = contentProblems(path, canaryText(path) + 'import "./isolation.setup.ts";\n');
  assert.ok(problems.includes(`${path}: setup probe must not import the isolation guard or package setup`), problems.join("\n"));
});

test("a missing canary helper is reported", () => {
  const problems = problemsAfter(root => rmSync(join(root, CANARY_HELPER)));
  assert.ok(problems.includes(`${CANARY_HELPER}: missing`), problems.join("\n"));
});

test("a missing package canary is reported", () => {
  const path = CANARIES.find(candidate => candidate.startsWith("runner/"));
  const short = path.slice("runner/".length);
  const problems = problemsAfter(root => rmSync(join(root, path)));
  assert.ok(problems.includes(`runner: missing ${short}`), problems.join("\n"));
});

test("a canary must statically import Vitest", () => {
  const path = CANARIES.find(candidate => candidate.startsWith("runner/"));
  const noVitest = contentProblems(path, canaryText(path).replace('import { it } from "vitest";\n', ""));
  assert.ok(noVitest.includes(`${path}: setup probe must statically import vitest`), noVitest.join("\n"));
});

test("a canary must import the canonical helper", () => {
  const path = CANARIES.find(candidate => candidate.startsWith("runner/"));
  const noHelper = contentProblems(path, canaryText(path).replace(/import \{ assertIsolationActive \} from [^;]+;\n/, ""));
  assert.ok(noHelper.includes(`${path}: setup probe must import ${CANARY_HELPER}`), noHelper.join("\n"));
});

test("Vitest imports outside a declared package are named errors", () => {
  const path = "extras/consumer.ts";
  const problems = contentProblems(path, importLine(path) + 'import { it } from "vitest";\n');
  assert.ok(problems.includes(`${path}: imports vitest outside a declared package`), problems.join("\n"));
});

test("a Vite config with a test section is treated as Vitest wiring", () => {
  const problems = problemsAfter(root => write(root, "extra/vite.config.ts", "export default { test: {} };\n"));
  assert.ok(problems.includes("extra: vitest package outside the declared inventory"), problems.join("\n"));
});

test("a Vite config without a test section is not treated as Vitest wiring", () => {
  assert.deepEqual(problemsAfter(root => write(root, "extra/vite.config.ts", "export default {};\n")), []);
});

test("a Vitest config filename is owned without a test property", () => {
  const problems = problemsAfter(root => write(root, "extra/vitest.config.ts", "export default {};\n"));
  assert.ok(problems.includes("extra: vitest package outside the declared inventory"), problems.join("\n"));
});

test("a node:test import is not treated as a Vitest package import", () => {
  const path = "scripts/test/independent.test.mjs";
  const source = importLine(path) + 'import { test } from "node:test";\ntest("fixture", () => {});\n';
  assert.deepEqual(contentProblems(path, source), []);
});

test("the shared guard implementation cannot import node:test", () => {
  const root = fixtureRepository();
  try {
    const source = readFileSync(join(root, MODULE), "utf8") + '\nimport { test } from "node:test";\n';
    write(root, MODULE, source);
    assert.ok(checkTestIsolation(root, { observe: () => [] }).problems.includes(`${MODULE}: node:test importer is not a canonical entry`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a declared node helper cannot import node:test", () => {
  const path = "scripts/test/mock-github-api.mjs";
  const problems = problemsAfter(root => write(root, path, 'import { test } from "node:test";\n'));
  assert.ok(problems.includes(`${path}: node:test importer is not a canonical entry`));
});

test("a node:test fixture cannot import node:test", () => {
  const path = "scripts/test/fixtures/helper.mjs";
  const problems = problemsAfter(root => write(root, path, 'import { test } from "node:test";\n'));
  assert.ok(problems.includes(`${path}: node:test importer is not a canonical entry`));
});

test("the CommonJS guard facade is exempt from first-import enforcement", () => {
  const root = fixtureRepository();
  const entries = ["scripts/test/a.test.mjs", "server/deploy/test/b.test.mjs"];
  try {
    for (const path of entries) rmSync(join(root, path));
    write(root, "scripts/test/fixtures/test-isolation.cjs", 'import { test } from "node:test";\n');
    const { problems } = checkTestIsolation(root, { observe: () => [] });
    assert.ok(problems.includes("node --test trees have no entries"), problems.join("\n"));
    assert.equal(problems.some(problem => problem.startsWith("scripts/test/fixtures/test-isolation.cjs: first import is not")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing shared guard is reported", () => {
  const problems = problemsAfter(root => rmSync(join(root, MODULE)));
  assert.ok(problems.includes(`${MODULE}: missing`), problems.join("\n"));
});

test("package script text does not infer Vitest ownership", () => {
  const root = fixtureRepository();
  try {
    write(root, "extra/package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    assert.deepEqual(checkTestIsolation(root, { observe: () => [] }).problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a non-Vitest config file with test syntax is not treated as Vitest wiring", () => {
  const root = fixtureRepository();
  try {
    write(root, "extra/custom.config.ts", "export default { test: true };\n");
    assert.deepEqual(checkTestIsolation(root, { observe: () => [] }).problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Vitest helper type-only and default imports violate the named API contract", () => {
  const path = "wrapper/codex/test/fixtures/notice_tap.ts";
  const typeOnly = contentProblems(path, 'import type { vi } from "vitest";\nexport {};\n');
  assert.ok(typeOnly.includes(`${path}: Vitest helper may import only named vi/expect bindings`), typeOnly.join("\n"));
  const defaultImport = contentProblems(path, 'import Vitest from "vitest";\nexport {};\n');
  assert.ok(defaultImport.includes(`${path}: Vitest helper may import only named vi/expect bindings`), defaultImport.join("\n"));
});

test("a Vitest helper combined default import is rejected", () => {
  const path = "wrapper/codex/test/fixtures/notice_tap.ts";
  const problems = contentProblems(path, 'import Vitest, { vi } from "vitest";\nexport {};\n');
  assert.ok(problems.includes(`${path}: Vitest helper may import only named vi/expect bindings`), problems.join("\n"));
});

test("Vitest helpers may import supported APIs with or without aliases", () => {
  const path = "wrapper/codex/test/fixtures/notice_tap.ts";
  for (const source of [
    'import { vi, expect } from "vitest";\nexport {};\n',
    'import { vi as mock, expect as check } from "vitest";\nexport {};\n',
  ]) assert.deepEqual(contentProblems(path, source), []);
});

test("a Vitest helper namespace import violates the named API contract", () => {
  const path = "wrapper/codex/test/fixtures/notice_tap.ts";
  const problems = contentProblems(path, 'import * as vitest from "vitest";\nexport {};\n');
  assert.ok(problems.includes(`${path}: Vitest helper may import only named vi/expect bindings`), problems.join("\n"));
});

test("a Vitest helper side-effect import violates the named API contract", () => {
  const path = "wrapper/codex/test/fixtures/notice_tap.ts";
  const problems = contentProblems(path, 'import "vitest";\nexport {};\n');
  assert.ok(problems.includes(`${path}: Vitest helper may import only named vi/expect bindings`), problems.join("\n"));
});

test("a Vitest helper rejects named APIs outside vi and expect", () => {
  const path = "wrapper/codex/test/fixtures/notice_tap.ts";
  const problems = contentProblems(path, 'import { it } from "vitest";\nexport {};\n');
  assert.ok(problems.includes(`${path}: Vitest helper imports unsupported API it`), problems.join("\n"));
});

test("a declared Vitest helper without a static Vitest import is a stale exception", () => {
  const path = "wrapper/codex/test/fixtures/notice_tap.ts";
  const problems = contentProblems(path, "export {};\n");
  assert.ok(problems.includes(`${path}: stale Vitest helper exception; no static vitest import remains`), problems.join("\n"));
});

test("parse failures in scanned sources are named errors", () => {
  const path = "runner/test/parse-error.ts";
  const problems = contentProblems(path, 'import { it } from "vitest";\nconst value = ;\n');
  assert.ok(problems.some(problem => problem.startsWith(`${path}:2: TypeScript could not parse the source:`)), problems.join("\n"));
});

for (const [name, [mutate, expected]] of Object.entries(mutations)) {
  test("the checker is red when " + name, () => {
    const problems = problemsAfter(mutate);
    assert.ok(problems.some(problem => expected.test(problem)), problems.join("\n") || "no problems reported");
  });
}

for (const tracked of [false, true]) {
  test("content selection catches multiline Vitest in an oddly named " + (tracked ? "tracked" : "untracked") + " file", () => {
    const problems = contentProblems("runner/test/not-a-test.ts", 'import {\n  it as run\n} from "vitest";\n', tracked);
    assert.ok(problems.some(problem => /runner\/test\/not-a-test\.ts: first import is not/.test(problem)), problems.join("\n"));
  });
}

test("a test-module import after an expression statement is still checked", () => {
  const path = "runner/test/statement-before-import.ts";
  const problems = contentProblems(path, '"use strict";\nimport { it } from "vitest";\n');
  assert.ok(problems.includes(`${path}: first import is not ${MODULE}`), problems.join("\n"));
});

test("content selection catches a side-effect import and ignores comments and strings", () => {
  const problems = contentProblems("runner/test/side-effect.ts", 'import "vitest";\n');
  assert.ok(problems.some(problem => /side-effect\.ts: first import is not/.test(problem)), problems.join("\n"));
  const escaped = contentProblems("runner/test/escaped-import.ts", 'import { it } from "vite\\u0073t";\n');
  assert.ok(escaped.some(problem => /escaped-import\.ts: first import is not/.test(problem)), escaped.join("\n"));
  assert.deepEqual(contentProblems("runner/test/text-only.ts",
    '// import { it } from "vitest";\nconst note = "import \\"node:test\\"";\n'), []);
});

test("a type-only test API import is selected", () => {
  const importer = contentProblems("runner/test/type-only-api.ts", 'import type { MockInstance } from "vitest";\n');
  assert.ok(importer.some(problem => /type-only-api\.ts: first import is not/.test(problem)), importer.join("\n"));
});

test("a type-only guard import is rejected", () => {
  const path = "runner/test/type-only-guard.ts";
  const specifier = posix.relative(posix.dirname(path), MODULE);
  const guard = contentProblems(path, 'import type * as isolation from "' + specifier + '";\nimport { it } from "vitest";\n');
  assert.ok(guard.includes(`${path}: first import is type-only; ${MODULE} must load at runtime`), guard.join("\n"));
});

test("a comment or string containing a test-module name does not select its file", () => {
  assert.deepEqual(contentProblems("runner/test/text-only.ts",
    '// import { it } from "vitest";\nconst note = "require(\'node:test\')";\n'), []);
});

for (const module of ["vitest"]) {
  test("a static " + module + " import is accepted after the guard", () => {
    const path = "wrapper/core/test/ordinary-import.ts";
    assert.deepEqual(contentProblems(path, importLine(path) + 'import { it } from "' + module + '";\n'), []);
  });
}

const unsupportedAcquisitions = {
  "re-export": module => 'export { test } from "' + module + '";',
  "CommonJS require": module => 'const testApi = require("' + module + '");',
  "dynamic import": module => 'const testApi = await import("' + module + '");',
  "TypeScript import-equals": module => 'import testApi = require("' + module + '");',
};
for (const [form, source] of Object.entries(unsupportedAcquisitions)) {
  for (const module of ["vitest", "node:test"]) {
    test("unsupported " + form + " of " + module + " is detected independently of first-import enforcement", () => {
      const path = "wrapper/core/test/unsupported-acquisition.ts";
      const problems = contentProblems(path, importLine(path) + source(module) + "\n");
      assert.ok(problems.some(problem => problem.includes(path + ": unsupported test-module acquisition")), problems.join("\n"));
      assert.ok(problems.some(problem => problem.includes(module)), problems.join("\n"));
    });
  }
}

test("template-literal module names in require and dynamic import are unsupported acquisitions", () => {
  const path = "wrapper/core/test/template-acquisition.ts";
  const source = importLine(path) + 'const required = require(`vitest`);\nconst loaded = await import(`node:test`);\n';
  const problems = contentProblems(path, source);
  assert.ok(problems.includes(`${path}: unsupported test-module acquisition (require("vitest")); use a static import`), problems.join("\n"));
  assert.ok(problems.includes(`${path}: unsupported test-module acquisition (dynamic import("node:test")); use a static import`), problems.join("\n"));
});

test("calls without a module argument do not break content selection", () => {
  assert.deepEqual(contentProblems("runner/test/empty-acquisition.ts", "require();\nvoid import();\n"), []);
});

test("nonliteral and non-require module expressions are not acquisitions", () => {
  const source = 'const vitest = "vitest";\n' +
    'const required = require(vitest);\n' +
    'const stringCalled = "require"("vitest");\n' +
    'const api = load("vitest");\n';
  assert.deepEqual(contentProblems("runner/test/custom-acquisition.ts", source), []);
});

test("non-test module acquisitions do not select a source file", () => {
  const path = "runner/test/non-test-acquisition.ts";
  const source = 'const required = require("node:path");\n' +
    'const loaded = await import("node:fs");\n' +
    'import pathApi = require("node:util");\n';
  assert.deepEqual(contentProblems(path, source), []);
});

test("unusual caller strings no longer affect the checker", () => {
  const root = fixtureRepository();
  try {
    write(root, "runner/package.json", JSON.stringify({ scripts: {
      test: 'pnpm -C runner "test:fast" --config alternate.config.ts',
      fast: 'pnpm -C runner exec vi""test run --config alternate.config.ts',
    } }));
    write(root, ".github/workflows/extra.yml", "jobs:\n  x:\n    steps:\n      - run: pnpm -C wrapper/core run /test/ --config alternate.config.ts\n");
    assert.deepEqual(checkTestIsolation(root, { observe: () => [] }).problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing default setup is not a new static config error", () => {
  const root = fixtureRepository();
  try {
    rmSync(join(root, "runner/vitest.config.ts"));
    assert.deepEqual(checkTestIsolation(root, { observe: () => [] }).problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every declared package is observed and its problems are reported", () => {
  const root = fixtureRepository();
  try {
    const observed = [];
    const { problems } = checkTestIsolation(root, { observe: (_, pkg) => { observed.push(pkg); return [`${pkg}: observed`]; } });
    assert.deepEqual(observed, VITEST_PACKAGES);
    assert.deepEqual(problems, VITEST_PACKAGES.map(pkg => `${pkg}: observed`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard test files use the extensionless local setup as their first import", () => {
  const root = fixtureRepository();
  const path = "dashboard/test/extensionless-setup.test.ts";
  try {
    write(root, path, 'import "./isolation.setup";\nimport { it } from "vitest";\nit("x", () => {});\n');
    assert.deepEqual(checkTestIsolation(root, { observe: () => [] }).problems, []);
    write(root, path, 'import "./isolation.setup.ts";\nimport { it } from "vitest";\nit("x", () => {});\n');
    assert.ok(checkTestIsolation(root, { observe: () => [] }).problems.includes(
      `${path}: first import is not dashboard/test/isolation.setup`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// observeVitest against a real Vitest (wrapper/core's, linked into a small
// package), so its verdicts come from Vitest's own config resolution.
const REAL_VITEST_MODULES = fileURLToPath(new URL("../../wrapper/core/node_modules", import.meta.url));
const CANARY_TEXT = 'import { it } from "vitest";\nimport { assertIsolationActive } from "../../../scripts/test/fixtures/test-isolation-canary.mjs";\n' +
  'await assertIsolationActive();\nit("canary", async () => { await assertIsolationActive(); });\n';
const SETUP = `setupFiles: ["${posix.relative("wrapper/core", MODULE)}"]`;

function observed(config, extra = {}, { canaryOnly = false } = {}) {
  assert.ok(existsSync(REAL_VITEST_MODULES), "install dependencies: wrapper/core/node_modules is needed to observe Vitest");
  const root = fixtureRepository();
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro577-observe-"));
  try {
    symlinkSync(REAL_VITEST_MODULES, join(root, "wrapper/core/node_modules"));
    write(root, "wrapper/core/vitest.config.ts", config);
    write(root, "wrapper/core/test/test-isolation.canary.test.ts", CANARY_TEXT);
    if (!canaryOnly) write(root, "wrapper/core/test/other.test.ts", 'import { it } from "vitest";\nit("other", () => {});\n');
    for (const [path, text] of Object.entries(extra)) write(root, path, text);
    return observeVitest(root, "wrapper/core", scratch);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("a real Vitest package that loads the guard is observed without problems", () => {
  assert.deepEqual(observed(`export default { test: { include: ["test/**/*.test.ts"], ${SETUP} } };\n`), []);
});

test("a real Vitest package whose config lacks the setup fails the listing", () => {
  const problems = observed('export default { test: { include: ["test/**/*.test.ts"] } };\n');
  assert.match(problems.join("\n"), /wrapper\/core: vitest list exited 1[\s\S]*test isolation is not loaded/);
});

test("a guard-free canary alone fails module-scope collection without setup", () => {
  const problems = observed('export default { test: { include: ["test/test-isolation.canary.test.ts"] } };\n', {}, { canaryOnly: true });
  assert.match(problems.join("\n"), /wrapper\/core: vitest list exited 1[\s\S]*test isolation is not loaded/);
});

test("removing the canary module-scope assertion makes the no-setup listing miss the failure", () => {
  const canary = CANARY_TEXT.replace("await assertIsolationActive();\n", "");
  const problems = observed('export default { test: { include: ["test/test-isolation.canary.test.ts"] } };\n', {
    "wrapper/core/test/test-isolation.canary.test.ts": canary,
  }, { canaryOnly: true });
  assert.deepEqual(problems, []);
});

test("a real Vitest package whose config does not select the canary is reported", () => {
  const problems = observed(`export default { test: { include: ["test/other.test.ts"], ${SETUP} } };\n`);
  assert.deepEqual(problems, ["wrapper/core: vitest does not select test/test-isolation.canary.test.ts"]);
});

test("a real Vitest package with more than one project is reported", () => {
  const project = (name, include) => `{ test: { name: "${name}", include: ["${include}"], ${SETUP} } }`;
  const problems = observed(`export default { test: { ${SETUP} } };\n`, {
    "wrapper/core/vitest.workspace.ts": `export default [${project("one", "test/other.test.ts")}, ${project("two", "test/test-isolation.canary.test.ts")}];\n`,
  });
  assert.deepEqual(problems, ["wrapper/core: vitest selects 2 projects; exactly one is required"]);
});

test("a package without Vitest installed cannot be observed and is reported", () => {
  const root = fixtureRepository();
  try {
    assert.deepEqual(observeVitest(root, "runner", root), ["runner: cannot observe the suite: vitest is not installed (install dependencies first)"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a successful Vitest listing that is not JSON is reported", () => {
  const root = fixtureRepository();
  const vitest = "runner/node_modules/.bin/vitest";
  try {
    write(root, vitest, "#!/usr/bin/env node\nconsole.log('not-json');\n");
    chmodSync(join(root, vitest), 0o755);
    const problems = observeVitest(root, "runner", root);
    assert.ok(problems.some(problem => problem.startsWith("runner: vitest list exited 0")), problems.join("\n"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed Vitest listing is reported even when it prints JSON", () => {
  const root = fixtureRepository();
  const vitest = "runner/node_modules/.bin/vitest";
  try {
    write(root, vitest, "#!/usr/bin/env node\nconsole.log('[]');\nprocess.exit(1);\n");
    chmodSync(join(root, vitest), 0o755);
    const problems = observeVitest(root, "runner", root);
    assert.ok(problems.some(problem => problem.startsWith("runner: vitest list exited 1")), problems.join("\n"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dashboard observation requires both guard-free canaries", () => {
  const root = fixtureRepository();
  const scratch = mkdtempSync(join(tmpdir(), "kaoiro716-dashboard-observe-"));
  const vitest = join(root, "dashboard/node_modules/.bin/vitest");
  const main = "dashboard/test/test-isolation.canary.test.ts";
  const jsdom = "dashboard/test/test-isolation.jsdom.canary.test.ts";
  const setListing = files => {
    const rows = files.map(file => ({ projectName: "dashboard", file: join(root, file) }));
    writeFileSync(vitest, "#!/usr/bin/env node\nconsole.log(" + JSON.stringify(JSON.stringify(rows)) + ");\n", { mode: 0o755 });
    chmodSync(vitest, 0o755);
  };
  try {
    mkdirSync(dirname(vitest), { recursive: true });
    setListing([main, jsdom]);
    assert.deepEqual(observeVitest(root, "dashboard", scratch), []);
    setListing([main]);
    assert.deepEqual(observeVitest(root, "dashboard", scratch),
      ["dashboard: vitest does not select test/test-isolation.jsdom.canary.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

for (const canary of CANARIES) {
  test("default Vitest observation reports an unselected canary: " + canary, () => {
    const root = fixtureRepository();
    const scratch = mkdtempSync(join(tmpdir(), "kaoiro716-canary-selection-"));
    const pkg = VITEST_PACKAGES.find(candidate => canary.startsWith(`${candidate}/`));
    assert.ok(pkg, `canary has no declared package: ${canary}`);
    const vitest = join(root, pkg, "node_modules", ".bin", "vitest");
    try {
      const rows = CANARIES.filter(path => path.startsWith(`${pkg}/`) && path !== canary)
        .map(file => ({ projectName: pkg, file: join(root, file) }));
      if (rows.length === 0) rows.push({ projectName: pkg, file: join(root, pkg, "test/other.test.ts") });
      mkdirSync(dirname(vitest), { recursive: true });
      writeFileSync(vitest, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(rows))});\n`, { mode: 0o755 });
      chmodSync(vitest, 0o755);
      assert.deepEqual(observeVitest(root, pkg, scratch),
        [`${pkg}: vitest does not select ${canary.slice(pkg.length + 1)}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test("the canary helper rejects a missing marker before command or network calls", () => {
  const helper = pathToFileURL(fileURLToPath(new URL("./fixtures/test-isolation-canary.mjs", import.meta.url))).href;
  const child = [
    'import childProcess from "node:child_process";',
    'import net from "node:net";',
    'import { syncBuiltinESMExports } from "node:module";',
    'delete globalThis[Symbol.for("kaoiro.test.isolation")];',
    'for (const key of ["KAOIRO_TEST_ISOLATION_CHILD", "KAOIRO_TEST_ISOLATION_ROOTS", "KAOIRO_TEST_ISOLATION_PERMIT", "KAOIRO_TEST_ISOLATION_FOREIGN", "KAOIRO_TEST_ISOLATION_INERT"]) delete process.env[key];',
    'process.env.NODE_OPTIONS = "";',
    'let spawnCalls = 0, connectCalls = 0;',
    'childProcess.execFileSync = () => { spawnCalls += 1; throw new Error("fake command called"); };',
    'net.connect = () => { connectCalls += 1; throw new Error("fake connection called"); };',
    'syncBuiltinESMExports();',
    'const { assertIsolationActive } = await import(' + JSON.stringify(helper) + ');',
    'let message;',
    'try { await assertIsolationActive(); } catch (error) { message = error.message; }',
    'console.log(JSON.stringify({ marker: Boolean(globalThis[Symbol.for("kaoiro.test.isolation")]), message, spawnCalls, connectCalls }));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    marker: false,
    message: "test isolation is not loaded in this process",
    spawnCalls: 0,
    connectCalls: 0,
  });
});

// The real repository is observed once, by the CLI step of the CI job
// (docs/contributing/test-isolation.md). What follows keeps that step
// connected to the job and keeps the CLI's own failure path honest.
const REPOSITORY = REAL_REPOSITORY;
const REAL_WORKFLOW = readFileSync(join(REPOSITORY, ".github/workflows/ci.yml"), "utf8");
const CLI_STEP = "      - run: node scripts/test-isolation/check.mjs\n";

test("the real workflow runs the checker and its tests in the test-isolation job", () => {
  assert.deepEqual(ciWiringProblems(REAL_WORKFLOW), []);
});

const wiringMutations = {
  "the checker step is removed": [text => text.replace(CLI_STEP, ""), /missing the step `- run: node scripts\/test-isolation\/check\.mjs`/],
  "the checker step runs another file": [text => text.replace(CLI_STEP, CLI_STEP.replace("check.mjs", "other.mjs")), /missing the step `- run: node scripts\/test-isolation\/check\.mjs`/],
  "the checker step cannot fail": [text => text.replace(CLI_STEP, CLI_STEP.replace("\n", " || true\n")), /missing the step `- run: node scripts\/test-isolation\/check\.mjs`/],
  "the checker step is continue-on-error": [text => text.replace(CLI_STEP, `${CLI_STEP}        continue-on-error: true\n`), /`continue-on-error: true` can skip a step/],
  "the checker step has a false condition": [text => text.replace(CLI_STEP, `${CLI_STEP.replace("      - run:", "      - if: false\n        run:")}`), /`- if: false` can skip a step/],
  "the checker step moves to another job": [
    text => text.replace(CLI_STEP, "").replace("  server:\n    runs-on: ubuntu-latest\n    steps:\n", `  server:\n    runs-on: ubuntu-latest\n    steps:\n${CLI_STEP}`),
    /missing the step `- run: node scripts\/test-isolation\/check\.mjs`/],
  "the runner step is removed": [text => text.replace("      - run: node scripts/test-isolation/run-node-tests.mjs\n", ""), /missing the step `- run: node scripts\/test-isolation\/run-node-tests\.mjs`/],
  "the job declares needs": [text => text.replace("  test-isolation:\n", "  test-isolation:\n    needs: runner\n"), /`needs: runner` can skip a step/],
  "the job is duplicated": [text => text.replace("  test-isolation:\n", "  test-isolation:\n  test-isolation:\n"), /duplicate job test-isolation/],
  "the job is renamed": [text => text.replace("  test-isolation:\n", "  test-isolation-renamed:\n"), /job test-isolation not found/],
};

for (const [name, [mutate, expected]] of Object.entries(wiringMutations)) {
  test(`the workflow check is red when ${name}`, () => {
    const mutated = mutate(REAL_WORKFLOW);
    assert.notEqual(mutated, REAL_WORKFLOW, "the mutation did not change the workflow");
    const problems = ciWiringProblems(mutated);
    assert.ok(problems.some(problem => expected.test(problem)), problems.join("\n") || "no problems reported");
  });
}

const JOB = (...steps) => `jobs:\n  test-isolation:\n    runs-on: ubuntu-latest\n    steps:\n${steps.map(step => `      ${step}\n`).join("")}`;
const CLI_JOB_STEP = "- run: node scripts/test-isolation/check.mjs";
const RUNNER_JOB_STEP = "- run: node scripts/test-isolation/run-node-tests.mjs";

// Required entries must remain selected even without an explicit workflow file list.
function connectedRepository() {
  const root = fixtureRepository();
  for (const path of ["scripts/test/test-isolation.test.mjs", "scripts/test/check-test-isolation.test.mjs",
    "scripts/test/child-process-environment.test.mjs", "scripts/test/codex-backend-compatibility.test.mjs"]) write(root, path, entry(path));
  write(root, ".github/workflows/ci.yml", JOB(CLI_JOB_STEP, RUNNER_JOB_STEP));
  return root;
}

test("checkRepository reports a connected repository without problems", () => {
  const root = connectedRepository();
  try {
    assert.deepEqual(checkRepository(root, { observe: () => [] }).problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const path of ["scripts/test/test-isolation.test.mjs", "scripts/test/check-test-isolation.test.mjs",
  "scripts/test/child-process-environment.test.mjs", "scripts/test/codex-backend-compatibility.test.mjs"]) {
  test(`the checker rejects a missing required Node entry: ${path}`, () => {
    const root = connectedRepository();
    try {
      rmSync(join(root, path));
      const diagnosis = `${path}: missing required Node test entry`;
      assert.ok(checkRepository(root, { observe: () => [] }).problems.includes(diagnosis));
      assert.deepEqual(checkTestIsolation(root, { observe: () => [] }).problems, []);
      const result = cli(root);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.split("\n").includes(diagnosis), result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("checkRepository adds the workflow problems to the checker's own, and only there", () => {
  const root = connectedRepository();
  try {
    write(root, ".github/workflows/ci.yml", JOB(CLI_JOB_STEP));
    const { problems } = checkRepository(root, { observe: () => [] });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /missing the step `- run: node scripts\/test-isolation\/run-node-tests.mjs`/);
    assert.deepEqual(checkTestIsolation(root, { observe: () => [] }).problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The CLI as the workflow starts it: a relative path from the repository root.
// A fixture has no installed Vitest, so these runs always report it; each case
// asserts its own diagnosis, the exit status and the summary line.
function cli(root) {
  const result = spawnSync(process.execPath, ["scripts/test-isolation/check.mjs", root], { cwd: REPOSITORY, encoding: "utf8" });
  return { status: result.status, summary: JSON.parse(result.stdout.trim().split("\n").at(-1)), stderr: result.stderr };
}

const cliMutations = {
  "an entry loses the guard": [root => write(root, "scripts/test/a.test.mjs", 'import { test } from "node:test";\ntest("x", () => {});\n'),
    "scripts/test/a.test.mjs: first import is not scripts/test/fixtures/test-isolation.mjs"],
  "an oddly named Vitest source loses the guard": [root => write(root, "wrapper/core/test/not-a-test.ts",
    'import { it } from "vitest";\n'),
    "wrapper/core/test/not-a-test.ts: first import is not scripts/test/fixtures/test-isolation.mjs"],
  "a package loses its canary": [root => rmSync(join(root, "wrapper/core/test/test-isolation.canary.test.ts")),
    "wrapper/core: missing test/test-isolation.canary.test.ts"],
  "a test file sits outside every declared tree": [root => write(root, "server/deploy/new.test.mjs", entry("server/deploy/new.test.mjs")),
    "server/deploy/new.test.mjs: test file outside every declared tree"],
  "the workflow has no test-isolation job": [root => write(root, ".github/workflows/ci.yml", "jobs:\n  other:\n    steps:\n      - run: node --test scripts/test/a.test.mjs\n"),
    ".github/workflows/ci.yml: job test-isolation not found"],
  "the job does not run the checker tests": [root => write(root, ".github/workflows/ci.yml", JOB(CLI_JOB_STEP)),
    `.github/workflows/ci.yml job test-isolation: missing the step \`${RUNNER_JOB_STEP}\``],
};

for (const [name, [mutate, diagnosis]] of Object.entries(cliMutations)) {
  test(`the checker command exits 1 and says why when ${name}`, () => {
    const root = connectedRepository();
    try {
      mutate(root);
      const result = cli(root);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.summary.problems > 0, JSON.stringify(result.summary));
      assert.ok(result.stderr.split("\n").includes(diagnosis), result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a node:test importer in fixtures is rejected", () => {
  const path = "scripts/test/fixtures/hidden.mjs";
  const problems = problemsAfter(root => write(root, path, 'import { test } from "node:test";\ntest("hidden", () => {});\n'));
  assert.ok(problems.includes(`${path}: node:test importer is not a canonical entry`), problems.join("\n"));
});
