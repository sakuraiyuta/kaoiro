import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const SOURCE_ROOTS = [
  { name: "core", source: "wrapper/core/src", tsconfig: "wrapper/core/tsconfig.json" },
  { name: "agent-common", source: "wrapper/agent-common/src", tsconfig: "wrapper/agent-common/tsconfig.json" },
  { name: "codex", source: "wrapper/codex/src", tsconfig: "wrapper/codex/tsconfig.json" },
  { name: "claude-code", source: "wrapper/claude-code/src", tsconfig: "wrapper/claude-code/tsconfig.json" },
  { name: "antigravity", source: "wrapper/antigravity/src", tsconfig: "wrapper/antigravity/tsconfig.json" },
] as const;
const SINK_FILE = "wrapper/core/src/redact.ts";
const SINK_EXPORT = "writeRedactedStderr";
const ALLOWED_PROCESS_MEMBERS = new Set([
  "argv",
  "cwd",
  "env",
  "execPath",
  "exit",
  "exitCode",
  "getuid",
  "kill",
  "on",
  "pid",
  "stdin",
  "stdout",
]);
const FORBIDDEN_GLOBALS = new Set([
  "globalThis",
  "global",
  "self",
  "window",
  "Reflect",
  "eval",
  "Function",
]);
const FORBIDDEN_MODULES = new Set([
  "process",
  "node:process",
  "console",
  "node:console",
]);
const SUSPICIOUS_MEMBER_NAMES = new Set(["stderr", "write", "_write", "end"]);

interface Violation {
  file: string;
  message: string;
}

interface ScanResult {
  approvedSinkHits: number;
  diagnostics: readonly ts.Diagnostic[];
  filesVisited: ReadonlyMap<string, number>;
  violations: readonly Violation[];
}

function under(path: string, parent: string): boolean {
  const value = relative(parent, path);
  return value !== "" && !value.startsWith(`..${sep}`) && value !== "..";
}

function projectConfig(configPath: string): ts.ParsedCommandLine {
  const absolute = resolve(REPOSITORY_ROOT, configPath);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(absolute),
    undefined,
    absolute,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  }
  return parsed;
}

function sourceFiles(program: ts.Program, sourceRoot: string): ts.SourceFile[] {
  const absoluteRoot = resolve(REPOSITORY_ROOT, sourceRoot);
  return program.getSourceFiles().filter((source) =>
    source.fileName.endsWith(".ts") && under(source.fileName, absoluteRoot),
  );
}

function typeIsUnresolved(type: ts.Type): boolean {
  return (type.flags & (
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Never |
    ts.TypeFlags.TypeParameter |
    ts.TypeFlags.Conditional |
    ts.TypeFlags.IndexedAccess |
    ts.TypeFlags.Substitution
  )) !== 0;
}

function declarationIsNodeProcess(declaration: ts.Declaration): boolean {
  return declaration.getSourceFile().fileName.includes(`${sep}@types${sep}node${sep}`);
}

function canonicalProcessType(checker: ts.TypeChecker, source: ts.SourceFile): ts.Type {
  const symbol = checker.getSymbolsInScope(source, ts.SymbolFlags.Value).find((candidate) =>
    candidate.getName() === "process" && candidate.declarations?.some(declarationIsNodeProcess),
  );
  if (symbol === undefined) throw new Error("could not resolve NodeJS.Process");
  return checker.getTypeOfSymbolAtLocation(symbol, source);
}

function sameSymbol(a: ts.Symbol | undefined, b: ts.Symbol | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const aDeclarations = a.declarations ?? [];
  const bDeclarations = b.declarations ?? [];
  return aDeclarations.some((declaration) => bDeclarations.some((other) =>
    declaration.getSourceFile() === other.getSourceFile() && declaration.pos === other.pos,
  ));
}

function approvedSink(node: ts.Node, source: ts.SourceFile): boolean {
  if (relative(REPOSITORY_ROOT, source.fileName) !== SINK_FILE) return false;
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (!ts.isFunctionDeclaration(current)) continue;
    return current.parent === source &&
      current.name?.text === SINK_EXPORT &&
      current.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  }
  return false;
}

function isAllowedProcessReference(node: ts.Expression, source: ts.SourceFile): boolean {
  if (!ts.isIdentifier(node) || node.text !== "process") return false;
  const parent = node.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) return false;
  return ALLOWED_PROCESS_MEMBERS.has(parent.name.text) ||
    (parent.name.text === "stderr" && approvedSink(parent, source));
}

function isAllowedProcessCall(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node) || !ts.isExpressionStatement(node.parent)) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "process" &&
    ALLOWED_PROCESS_MEMBERS.has(callee.name.text);
}

function isLiteralModuleSpecifier(node: ts.Expression | undefined): node is ts.StringLiteral {
  return node !== undefined && ts.isStringLiteral(node);
}

function scanSources(
  program: ts.Program,
  sources: readonly ts.SourceFile[],
  visitedName: string,
): ScanResult {
  const filesVisited = new Map<string, number>([[visitedName, sources.length]]);
  if (sources.length === 0) {
    return {
      approvedSinkHits: 0,
      diagnostics: ts.getPreEmitDiagnostics(program),
      filesVisited,
      violations: [{ file: visitedName, message: "source root contains no TypeScript files" }],
    };
  }

  const checker = program.getTypeChecker();
  const processType = canonicalProcessType(checker, sources[0]!);
  const stderrSymbol = checker.getPropertyOfType(processType, "stderr");
  const stderrType = stderrSymbol === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(stderrSymbol, sources[0]!);
  const violations: Violation[] = [];
  let approvedSinkHits = 0;

  const add = (source: ts.SourceFile, node: ts.Node, message: string): void => {
    violations.push({
      file: relative(REPOSITORY_ROOT, source.fileName),
      message: `${message} at ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
    });
  };
  const typeIsProcess = (type: ts.Type): boolean =>
    !typeIsUnresolved(type) &&
    sameSymbol(type.getSymbol(), processType.getSymbol()) &&
    checker.isTypeAssignableTo(type, processType);
  const typeIsStderr = (type: ts.Type): boolean =>
    stderrType !== undefined && !typeIsUnresolved(type) && checker.isTypeAssignableTo(type, stderrType);
  const symbolIsConsole = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    return resolved?.declarations?.some((declaration) =>
      declaration.getSourceFile().fileName.includes(`${sep}@types${sep}node${sep}console.d.ts`),
    ) ?? false;
  };
  const symbolIsGlobalCapability = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
    if (resolved === undefined) return true;
    return resolved.declarations?.some((declaration) =>
      !SOURCE_ROOTS.some((root) => under(declaration.getSourceFile().fileName, resolve(REPOSITORY_ROOT, root.source))),
    ) ?? true;
  };
  const isStderrAccess = (node: ts.PropertyAccessExpression): boolean =>
    sameSymbol(checker.getSymbolAtLocation(node.name), stderrSymbol);

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (FORBIDDEN_GLOBALS.has(node.text) && symbolIsGlobalCapability(checker.getSymbolAtLocation(node))) {
          add(source, node, `${node.text} is not an approved diagnostic capability`);
        }
        if (node.text === "console" || symbolIsConsole(checker.getSymbolAtLocation(node))) {
          add(source, node, "console is not an approved diagnostic sink");
        }
      }

      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && FORBIDDEN_MODULES.has(node.moduleSpecifier.text)) {
        add(source, node.moduleSpecifier, `${node.moduleSpecifier.text} import is not approved`);
      }
      if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if (isDynamicImport || isRequire) {
          const specifier = node.arguments[0];
          if (!isLiteralModuleSpecifier(specifier)) {
            add(source, node, "non-literal dynamic module loading is not approved");
          } else if (FORBIDDEN_MODULES.has(specifier.text)) {
            add(source, specifier, `${specifier.text} module loading is not approved`);
          }
        }
      }

      if (ts.isExpression(node)) {
        const type = checker.getTypeAtLocation(node);
        if (typeIsProcess(type) && !isAllowedProcessReference(node, source) && !isAllowedProcessCall(node)) {
          add(source, node, "NodeJS.Process may only be used through an approved direct member access");
        }
        const stderrAccess = ts.isPropertyAccessExpression(node) && isStderrAccess(node);
        if (stderrAccess || typeIsStderr(type)) {
          if (approvedSink(node, source)) {
            if (stderrAccess) approvedSinkHits += 1;
          } else {
            add(source, node, "process.stderr is not an approved diagnostic sink");
          }
        }
      }

      if (ts.isPropertyAccessExpression(node)) {
        const receiverType = checker.getTypeAtLocation(node.expression);
        if (typeIsUnresolved(receiverType) && SUSPICIOUS_MEMBER_NAMES.has(node.name.text)) {
          add(source, node, `unresolved receiver.${node.name.text} is not approved`);
        }
      }
      if (ts.isElementAccessExpression(node)) {
        const receiverType = checker.getTypeAtLocation(node.expression);
        if (!isLiteralModuleSpecifier(node.argumentExpression) && typeIsUnresolved(receiverType)) {
          add(source, node, "unresolved receiver with a non-literal element access is not approved");
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return {
    approvedSinkHits,
    diagnostics: ts.getPreEmitDiagnostics(program),
    filesVisited,
    violations,
  };
}

function scanText(text: string): ScanResult {
  const config = projectConfig("wrapper/core/tsconfig.json");
  const file = resolve(REPOSITORY_ROOT, "wrapper/core/src/stderr-sink-guard-probe.ts");
  const host = ts.createCompilerHost(config.options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === file
      ? ts.createSourceFile(fileName, text, languageVersion, true)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (fileName) => fileName === file || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => fileName === file ? text : ts.sys.readFile(fileName);
  const program = ts.createProgram({ rootNames: [file], options: config.options, host });
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error("could not load virtual guard probe");
  return scanSources(program, [source], "inline");
}

function allSources(): ScanResult {
  const summaries = SOURCE_ROOTS.map((root) => {
    const config = projectConfig(root.tsconfig);
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
    return scanSources(program, sourceFiles(program, root.source), root.name);
  });
  const filesVisited = new Map<string, number>();
  for (const summary of summaries) {
    for (const [name, count] of summary.filesVisited) filesVisited.set(name, count);
  }
  return {
    approvedSinkHits: summaries.reduce((total, summary) => total + summary.approvedSinkHits, 0),
    diagnostics: summaries.flatMap((summary) => summary.diagnostics),
    filesVisited,
    violations: summaries.flatMap((summary) => summary.violations),
  };
}

describe("wrapper stderr sink guard", () => {
  it("scans every production source root with a diagnostic-free TypeScript program", () => {
    const result = allSources();

    expect(result.diagnostics).toEqual([]);
    expect(result.violations).toEqual([]);
    expect([...result.filesVisited.keys()]).toEqual(SOURCE_ROOTS.map((root) => root.name));
    expect([...result.filesVisited.values()].every((count) => count > 0)).toBe(true);
    expect(result.approvedSinkHits).toBe(1);
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
    ["parenthesized process", '(process).stderr.write("api_key=abcdef123456");'],
    ["quoted stderr destructuring", 'const { "stderr": w } = process; w.write("api_key=abcdef123456");'],
    ["console import alias", 'import { warn as w } from "node:console"; w("api_key=abcdef123456");'],
    ["default process import", 'import { default as p } from "node:process"; p.stderr.write("api_key=abcdef123456");'],
    ["process-returning chain", 'process.on("x", () => {}).stderr.write("api_key=abcdef123456");'],
    ["template expression", '`${process.stderr.write("api_key=abcdef123456")}`;'],
  ])("rejects a %s diagnostic bypass", (_label, source) => {
    expect(scanText(source).violations).not.toEqual([]);
  });

  it("rejects a non-top-level sink lookalike", () => {
    expect(scanText(
      'export namespace X { export function writeRedactedStderr(text: string) { process.stderr.write(text); } }',
    ).violations).not.toEqual([]);
  });

  it("rejects non-literal and forbidden module loading", () => {
    expect(scanText("require(name);").violations).not.toEqual([]);
    expect(scanText("import(name);").violations).not.toEqual([]);
    expect(scanText('require("node:process");').violations).not.toEqual([]);
    expect(scanText('import("node:console");').violations).not.toEqual([]);
  });

  it.each([
    ["globalThis", 'globalThis.process.stderr.write("api_key=abcdef123456");'],
    ["global", 'global.process.stderr.write("api_key=abcdef123456");'],
    ["self", 'self.process.stderr.write("api_key=abcdef123456");'],
    ["window", 'window.process.stderr.write("api_key=abcdef123456");'],
    ["Reflect", 'Reflect.get(process, "stderr").write("api_key=abcdef123456");'],
    ["eval", 'eval("process.stderr.write(\\\"api_key=abcdef123456\\\")");'],
    ["Function", 'new Function("return process.stderr")();'],
  ])("rejects the %s global capability", (_label, source) => {
    expect(scanText(source).violations).not.toEqual([]);
  });

  it("accepts prose and strings that only mention a forbidden sink", () => {
    expect(scanText('// process.stderr.write("api_key=abcdef123456")\nconst text = "console.warn(\\\"example\\\")";').violations).toEqual([]);
  });

  it("accepts the shared helper and approved process members", () => {
    expect(scanText(
      'writeRedactedStderr("api_key=abcdef123456"); process.env.KAOIRO_EXAMPLE; process.stdout.write("safe");',
    ).violations).toEqual([]);
  });
});
