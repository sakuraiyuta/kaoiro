import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TEST_MODULES = new Set(["vitest", "node:test"]);
export const HELPERS = [
  "wrapper/codex/test/app_server_approval_harness.ts",
  "wrapper/codex/test/fixtures/cli_app_server.ts",
  "wrapper/codex/test/fixtures/notice_tap.ts",
];
export const PACKAGES = [
  "runner",
  "wrapper/core",
  "wrapper/agent-common",
  "wrapper/claude-code",
  "wrapper/codex",
  "wrapper/antigravity",
  "wrapper/grok",
  "wrapper/muse",
  "dashboard",
];
export const CANARIES = [
  ...PACKAGES.map(pkg => `${pkg}/test/test-isolation.canary.test.ts`),
  "dashboard/test/test-isolation.jsdom.canary.test.ts",
];

const SOURCE = /\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx)$/;
const DECLARATION = /\.d\.[cm]?ts$/;

function trackedSources(root) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return [...new Set(result.stdout.split("\0").filter(Boolean))]
    .filter(path => !/(?:^|\/)node_modules\//.test(path) && SOURCE.test(path) && !DECLARATION.test(path) &&
      existsSync(join(root, path)))
    .sort();
}

function stringModule(node, ts) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function inspectFile(path, text, ts) {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    /\.(?:jsx|tsx)$/.test(path) ? ts.ScriptKind.TSX : undefined);
  const imports = [];
  const unsupported = [];
  const moduleOf = node => stringModule(node, ts);

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const module = moduleOf(node.moduleSpecifier);
      if (TEST_MODULES.has(module)) imports.push(module);
    } else if (ts.isExportDeclaration(node)) {
      const module = moduleOf(node.moduleSpecifier);
      if (TEST_MODULES.has(module)) unsupported.push(`re-export from ${module}`);
    } else if (ts.isCallExpression(node)) {
      const module = moduleOf(node.arguments[0]);
      if (module && TEST_MODULES.has(module) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        unsupported.push(`require(${JSON.stringify(module)})`);
      } else if (module && TEST_MODULES.has(module) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        unsupported.push(`dynamic import(${JSON.stringify(module)})`);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const module = moduleOf(node.moduleReference.expression);
      if (TEST_MODULES.has(module)) unsupported.push(`import = require(${JSON.stringify(module)})`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const parseProblems = sourceFile.parseDiagnostics.map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    const location = diagnostic.start === undefined ? "" : `:${sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
    return `${path}${location}: TypeScript could not parse the source: ${message}`;
  });
  return { path, text, sourceFile, imports, unsupported, parseProblems };
}

export function analyzeSources(root, ts, paths = trackedSources(root)) {
  const rows = paths.filter(path => SOURCE.test(path) && !DECLARATION.test(path) &&
    !/(?:^|\/)node_modules\//.test(path) && existsSync(join(root, path)))
    .map(path => inspectFile(path, readFileSync(join(root, path), "utf8"), ts));
  return {
    rows,
    problems: rows.flatMap(row => [
      ...row.parseProblems,
      ...row.unsupported.map(form => `${row.path}: unsupported test-module acquisition (${form}); use a static import`),
    ]),
  };
}

export function selectedSources(root, ts) {
  return analyzeSources(root, ts).rows.filter(row => row.imports.length > 0);
}
