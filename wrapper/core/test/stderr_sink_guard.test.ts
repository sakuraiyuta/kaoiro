import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const SOURCE_ROOTS = [
  "wrapper/core/src",
  "wrapper/agent-common/src",
  "wrapper/codex/src",
  "wrapper/claude-code/src",
  "wrapper/antigravity/src",
] as const;
const SINK_FILE = "wrapper/core/src/redact.ts";
const SINK_EXPORT = "writeRedactedStderr";

interface Violation {
  file: string;
  message: string;
}

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return entry.isFile() && child.endsWith(".ts") ? [child] : [];
  });
}

function isNamed(node: ts.Node | undefined, name: string): boolean {
  return node !== undefined && ts.isIdentifier(node) && node.text === name;
}

function isNodeProcessModule(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) && (node.text === "process" || node.text === "node:process");
}

function isProcessValue(node: ts.Expression, aliases: ReadonlySet<string>): boolean {
  return (
    (ts.isIdentifier(node) && aliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) && isNamed(node.expression, "globalThis") && node.name.text === "process") ||
    (ts.isElementAccessExpression(node) && isNamed(node.expression, "globalThis") && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "process")
  );
}

function processAliases(source: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Set(["process"]);
  let changed = true;
  while (changed) {
    changed = false;
    const add = (name: string): void => {
      if (aliases.has(name)) return;
      aliases.add(name);
      changed = true;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && isNodeProcessModule(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause?.name !== undefined) add(clause.name.text);
        if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
          add(clause.namedBindings.name.text);
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isProcessValue(node.initializer, aliases)
      ) {
        add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return aliases;
}

function isApprovedSink(node: ts.Node, source: ts.SourceFile): boolean {
  if (relative(REPOSITORY_ROOT, source.fileName) !== SINK_FILE) return false;
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) &&
      current.name?.text === SINK_EXPORT &&
      current.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      return true;
    }
  }
  return false;
}

function scanSource(source: ts.SourceFile): Violation[] {
  const aliases = processAliases(source);
  const violations: Violation[] = [];
  const add = (node: ts.Node, message: string): void => {
    if (isApprovedSink(node, source)) return;
    violations.push({
      file: relative(REPOSITORY_ROOT, source.fileName),
      message,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "console") {
      add(node, "console is not an approved diagnostic sink");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      isProcessValue(node.expression, aliases) &&
      node.name.text === "stderr"
    ) {
      add(node, "process.stderr is not an approved diagnostic sink");
    }
    if (
      ts.isElementAccessExpression(node) &&
      isProcessValue(node.expression, aliases) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "stderr"
    ) {
      add(node, "process[\"stderr\"] is not an approved diagnostic sink");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      isNamed(node.expression, "globalThis") &&
      node.name.text === "console"
    ) {
      add(node, "globalThis.console is not an approved diagnostic sink");
    }
    if (
      ts.isElementAccessExpression(node) &&
      isNamed(node.expression, "globalThis") &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "console"
    ) {
      add(node, "globalThis[\"console\"] is not an approved diagnostic sink");
    }
    if (ts.isImportDeclaration(node) && isNodeProcessModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "stderr") {
            add(element, "stderr import is not an approved diagnostic sink");
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isProcessValue(node.initializer, aliases)
    ) {
      for (const element of node.name.elements) {
        if ((element.propertyName?.getText(source) ?? element.name.getText(source)) === "stderr") {
          add(element, "stderr destructuring is not an approved diagnostic sink");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function scanText(text: string): Violation[] {
  return scanSource(ts.createSourceFile(
    resolve(REPOSITORY_ROOT, "wrapper/antigravity/src/guard-probe.ts"),
    text,
    ts.ScriptTarget.Latest,
    true,
  ));
}

function allViolations(): Violation[] {
  return SOURCE_ROOTS.flatMap((root) =>
    sourceFiles(resolve(REPOSITORY_ROOT, root)).flatMap((path) =>
      scanSource(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)),
    ),
  );
}

describe("wrapper stderr sink guard", () => {
  it("permits only the named common sink in production source", () => {
    expect(allViolations()).toEqual([]);
  });

  it.each([
    ["direct write", 'process.stderr.write("api_key=abcdef123456");'],
    ["console error", 'console.error("api_key=abcdef123456");'],
    ["console warn", 'console.warn("api_key=abcdef123456");'],
    ["stderr end", 'process.stderr.end("api_key=abcdef123456");'],
    ["stderr alias", 'const w = process.stderr; w.write("api_key=abcdef123456");'],
    ["process import", 'import { stderr } from "node:process"; stderr.write("api_key=abcdef123456");'],
    ["bracket write", 'process.stderr["write"]("api_key=abcdef123456");'],
    ["URL on the same line", 'const url = "https://example.invalid"; process.stderr.write("api_key=abcdef123456");'],
    ["stderr destructuring", 'const { stderr } = process; stderr.write("api_key=abcdef123456");'],
    ["process alias", 'const p = process; p.stderr.write("api_key=abcdef123456");'],
  ])("rejects a %s diagnostic bypass", (_label, source) => {
    expect(scanText(source)).not.toEqual([]);
  });

  it("accepts prose and strings that only mention a forbidden sink", () => {
    expect(scanText('// process.stderr.write("api_key=abcdef123456")\nconst text = "console.warn(\\\"example\\\")";')).toEqual([]);
  });

  it("accepts the shared helper call without a false positive", () => {
    expect(scanText('writeRedactedStderr("api_key=abcdef123456");')).toEqual([]);
  });
});
