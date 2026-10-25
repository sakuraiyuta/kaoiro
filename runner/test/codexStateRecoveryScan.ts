import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

// Fail-closed scan of the helper's static import closure: every throw is a
// literal or template message, a declared thrower call, or a marked rethrow.
export const THROWERS: Record<string, number> = { must: 1, fail: 0, failMissingArtifact: 0, failMissingWorkspaceLink: 0 };
export type Scan = { files: string[]; keys: Map<string, Set<string>>; rethrows: Map<string, string>; problems: string[] };

const marker = (text: string, line: number, kind: string) => {
  const lines = text.split("\n");
  for (const candidate of [lines[line], lines[line - 1]]) {
    const match = candidate?.match(new RegExp(`codex-recovery-${kind}: ([A-Za-z0-9 .-]+)`));
    if (match) return match[1]!.trim().split(/\s+/);
  }
  return [];
};

export function closure(entry: string, read = (path: string) => readFileSync(path, "utf8")) {
  const seen: string[] = [], queue = [resolve(entry)];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.includes(path)) continue;
    seen.push(path);
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) queue.push(join(dirname(path), specifier.text));
    }
  }
  return seen;
}

export function scan(entry: string, read = (path: string) => readFileSync(path, "utf8")): Scan {
  const result: Scan = { files: closure(entry, read), keys: new Map(), rethrows: new Map(), problems: [] };
  for (const path of result.files) {
    const text0 = read(path), text = text0, name = path.slice(dirname(path).length + 1);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const where = (node: ts.Node) => `${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line;
    // A template is keyed with each substitution written as ${}.
    const key = (node: ts.Node | undefined, at: ts.Node) => {
      let text: string | undefined;
      if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) text = node.text;
      else if (node && ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map(span => "${}" + span.literal.text).join("");
      else if (node && ts.isIdentifier(node) && marker(text0, line(at), "rethrow").length) { marked(at, "forwarded message"); return; }
      if (!text) { result.problems.push(`${where(at)}: message is not a literal or template`); return; }
      result.keys.set(text, (result.keys.get(text) ?? new Set<string>()).add(name));
    };
    const marked = (node: ts.Node, what: string) => {
      const ids = marker(text, line(node), "rethrow");
      if (!ids.length) result.problems.push(`${where(node)}: unmarked ${what}`);
      for (const id of ids) result.rethrows.set(id, where(node));
    };
    const visit = (node: ts.Node, inThrower: boolean) => {
      if (ts.isFunctionDeclaration(node) && node.name && Object.hasOwn(THROWERS, node.name.text)) inThrower = true;
      if (ts.isThrowStatement(node) && !inThrower) {
        const value = node.expression;
        if (!(ts.isNewExpression(value) && ts.isIdentifier(value.expression) && /Error$/.test(value.expression.text))) marked(node, "throw");
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text) && !inThrower) key(node.arguments?.[0], node);
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && Object.hasOwn(THROWERS, callee.text)) key(node.arguments[THROWERS[callee.text]!], node);
        if (callee.kind === ts.SyntaxKind.ImportKeyword) marked(node, "dynamic import");
        if (ts.isIdentifier(callee) && callee.text === "createRequire") marked(node, "createRequire");
      }
      ts.forEachChild(node, child => visit(child, inThrower));
    };
    visit(source, false);
  }
  return result;
}

// Shell refusal lines: every kaoiro_die message and every printf to stderr,
// keyed by the literal as written.
export function shellLines(text: string) {
  const found: { key: string; exit: number | undefined; line: number }[] = [];
  text.split("\n").forEach((raw, index) => {
    if (/^\s*#/.test(raw)) return;
    for (const match of raw.matchAll(/kaoiro_die "((?:[^"\\]|\\.)*)"(?: (\d+))?/g)) {
      if (raw.trimStart().startsWith("kaoiro_die()")) continue;
      found.push({ key: match[1]!, exit: match[2] === undefined ? undefined : Number(match[2]), line: index + 1 });
    }
    const printf = raw.match(/printf '([^']*)'.*>&2/);
    if (printf) found.push({ key: printf[1]!, exit: undefined, line: index + 1 });
  });
  return found;
}
