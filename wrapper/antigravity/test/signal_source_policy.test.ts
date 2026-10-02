import { readdirSync, readFileSync } from "node:fs";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

interface KillReference {
  file: string;
  kind: "property" | "element" | "destructuring" | "assignment-destructuring";
  expression: string;
  call: string | null;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function literalPropertyName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return literalPropertyName(node.expression);
  return undefined;
}

function isDestructuringAssignment(object: ts.ObjectLiteralExpression): boolean {
  let current: ts.Node = object;
  while (true) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent)
      && parent.left === current
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
    if (ts.isPropertyAssignment(parent)
      && parent.initializer === current
      && ts.isObjectLiteralExpression(parent.parent)) {
      current = parent.parent;
      continue;
    }
    return false;
  }
}

function sourceKillReferences(): KillReference[] {
  const references: KillReference[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const relativeFile = relative(sourceRoot, file).replaceAll("\\", "/");
    function addReference(node: ts.Node, kind: KillReference["kind"]): void {
      const parent = node.parent;
      const call = ts.isCallExpression(parent) && parent.expression === node ? parent.getText(source) : null;
      references.push({
        file: relativeFile,
        kind,
        expression: node.getText(source),
        call,
      });
    }
    function visit(node: ts.Node): void {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "kill") {
        addReference(node, "property");
      } else if (ts.isElementAccessExpression(node) && literalPropertyName(node.argumentExpression) === "kill") {
        addReference(node, "element");
      } else if (ts.isBindingElement(node)
        && node.dotDotDotToken === undefined
        && literalPropertyName(node.propertyName ?? node.name) === "kill") {
        addReference(node, "destructuring");
      } else if (ts.isShorthandPropertyAssignment(node)
        && node.name.text === "kill"
        && ts.isObjectLiteralExpression(node.parent)
        && isDestructuringAssignment(node.parent)) {
        addReference(node, "assignment-destructuring");
      } else if (ts.isPropertyAssignment(node)
        && literalPropertyName(node.name) === "kill"
        && ts.isObjectLiteralExpression(node.parent)
        && isDestructuringAssignment(node.parent)) {
        addReference(node, "assignment-destructuring");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return references;
}

describe("Antigravity signal source policy", () => {
  it("counts every kill property reference and destructuring, allowing only the checked senders", () => {
    const references = sourceKillReferences().sort((left, right) =>
      `${left.file}:${left.kind}:${left.expression}:${left.call}`.localeCompare(
        `${right.file}:${right.kind}:${right.expression}:${right.call}`,
      ));

    expect(references).toEqual([
      { file: "customization.ts", kind: "property", expression: "process.kill", call: "process.kill(pid, 0)" },
      { file: "subtree_termination.ts", kind: "property", expression: "process.kill", call: "process.kill(pid, signal)" },
    ]);
  });
});
