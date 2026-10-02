import { readdirSync, readFileSync } from "node:fs";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

interface KillCall {
  file: string;
  receiver: string;
  access: "element" | "property";
  call: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function sourceKillCalls(): KillCall[] {
  const calls: KillCall[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isPropertyAccessExpression(expression) && expression.name.text === "kill") {
          calls.push({
            file: relative(sourceRoot, file).replaceAll("\\", "/"),
            receiver: expression.expression.getText(source),
            access: "property",
            call: node.getText(source),
          });
        } else if (ts.isElementAccessExpression(expression)
          && expression.argumentExpression !== undefined
          && ts.isStringLiteralLike(expression.argumentExpression)
          && expression.argumentExpression.text === "kill") {
          calls.push({
            file: relative(sourceRoot, file).replaceAll("\\", "/"),
            receiver: expression.expression.getText(source),
            access: "element",
            call: node.getText(source),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return calls;
}

describe("Antigravity signal source policy", () => {
  it("allows only the checked sender and the customization liveness probe", () => {
    const calls = sourceKillCalls();
    const approved = calls.filter((call) => call.receiver === "process" && call.access === "property");
    const unapproved = calls.filter((call) => !approved.includes(call));

    expect(unapproved).toEqual([]);
    expect(approved.map(({ file, call }) => ({ file, call })).sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "customization.ts", call: "process.kill(pid, 0)" },
      { file: "subtree_termination.ts", call: "process.kill(pid, signal)" },
    ]);
  });
});
