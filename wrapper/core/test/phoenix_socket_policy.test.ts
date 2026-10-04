import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// Every Phoenix socket of the runner and the wrappers must come from
// createPhoenixSocket, which fixes the transport. A value import of phoenix's
// `Socket` anywhere else could hand Phoenix the bare platform WebSocket again.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const ALLOWED = "wrapper/core/src/phoenix_socket.ts";

/** The `packages` list of pnpm-workspace.yaml: only the block under the
 *  top-level `packages:` key, skipping comments and blank lines. An entry it
 *  cannot read as a plain path (a glob, a flow list) fails rather than being
 *  skipped. */
function workspacePackages(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*(#.*)?$/.test(line));
  if (start === -1) throw new Error("no block-style top-level `packages:` key");
  const packages: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const content = line.trim();
    if (content === "" || content.startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^-\s+(["']?)([^"'\s#]+)\1\s*(#.*)?$/.exec(content);
    const path = entry?.[2];
    if (path === undefined || /[*?!{}[\]]/.test(path)) {
      throw new Error(`cannot read workspace entry: ${line}`);
    }
    packages.push(path);
  }
  if (packages.length === 0) throw new Error("the packages block lists nothing");
  return packages;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Statements that give a module phoenix's `Socket` as a value, by line. */
function phoenixSocketValueImports(fileName: string, text: string): number[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const add = (node: ts.Node) =>
    lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
  const isPhoenix = (node: ts.Node | undefined) =>
    node !== undefined && ts.isStringLiteralLike(node) && node.text === "phoenix";
  const namesSocket = (element: ts.ImportSpecifier | ts.ExportSpecifier) =>
    !element.isTypeOnly && (element.propertyName ?? element.name).text === "Socket";

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isPhoenix(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (
        clause !== undefined &&
        !clause.isTypeOnly &&
        (clause.name !== undefined ||
          (bindings !== undefined && ts.isNamespaceImport(bindings)) ||
          (bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some(namesSocket)))
      ) {
        add(node);
      }
    } else if (ts.isExportDeclaration(node) && isPhoenix(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (
        !node.isTypeOnly &&
        (clause === undefined || ts.isNamespaceExport(clause) || clause.elements.some(namesSocket))
      ) {
        add(node);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isPhoenix(node.moduleReference.expression)
    ) {
      if (!node.isTypeOnly) add(node);
    } else if (ts.isCallExpression(node) && isPhoenix(node.arguments[0])) {
      add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe("workspacePackages", () => {
  it("reads only the packages block, across comments, up to the next key", () => {
    const text = [
      "packages:",
      "  - alpha",
      "  # a trailing comment",
      "  # another one",
      "  - 'beta/gamma' # quoted, with a comment",
      "",
      "# a top-level comment",
      "onlyBuiltDependencies:",
      "  - esbuild",
    ].join("\n");
    expect(workspacePackages(text)).toEqual(["alpha", "beta/gamma"]);
  });

  it.each([
    ["a glob entry", "packages:\n  - packages/*\n"],
    ["a flow list", "packages: [alpha]\n"],
    ["an empty block", "packages:\n# nothing\nother:\n  - x\n"],
  ])("fails on %s instead of skipping it", (_label, text) => {
    expect(() => workspacePackages(text)).toThrow();
  });
});

describe("phoenixSocketValueImports", () => {
  it.each([
    ['import { Socket } from "phoenix";', 1],
    ['import { Socket as S } from "phoenix";', 1],
    ['import { Channel, Socket } from "phoenix";', 1],
    ['import * as phoenix from "phoenix";', 1],
    ['import phoenix from "phoenix";', 1],
    ['export { Socket } from "phoenix";', 1],
    ['export * from "phoenix";', 1],
    ['export * as phoenix from "phoenix";', 1],
    ['const phoenix = await import("phoenix");', 1],
    ['const phoenix = require("phoenix");', 1],
    ['const phoenix = createRequire(import.meta.url)("phoenix");', 1],
    ['import phoenix = require("phoenix");', 1],
    ['import type { Socket } from "phoenix";', 0],
    ['import { type Socket, type Channel } from "phoenix";', 0],
    ['import { Channel } from "phoenix";', 0],
    ['export type { Socket } from "phoenix";', 0],
    ['import type phoenix = require("phoenix");', 0],
    ['import { Socket } from "node:net";', 0],
  ])("%s -> %i", (statement, count) => {
    expect(phoenixSocketValueImports("probe.ts", statement)).toHaveLength(count);
  });
});

describe("Phoenix socket construction", () => {
  const packages = workspacePackages(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));

  it("scans every workspace package's src, and each holds TypeScript", () => {
    expect(packages).toEqual(expect.arrayContaining(["runner", "wrapper/core"]));
    for (const pkg of packages) {
      expect(sourceFiles(join(repoRoot, pkg, "src")).length, pkg).toBeGreaterThan(0);
    }
  });

  it(`happens only in ${ALLOWED}`, () => {
    const violations: string[] = [];
    let allowedImports = 0;
    for (const pkg of packages) {
      for (const file of sourceFiles(join(repoRoot, pkg, "src"))) {
        const relativePath = file.slice(repoRoot.length).replaceAll("\\", "/");
        const found = phoenixSocketValueImports(file, readFileSync(file, "utf8"));
        if (relativePath === ALLOWED) allowedImports = found.length;
        else violations.push(...found.map((line) => `${relativePath}:${line}`));
      }
    }
    expect(violations).toEqual([]);
    expect(allowedImports).toBeGreaterThan(0);
  });
});
