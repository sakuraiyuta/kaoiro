import { dirname, relative, resolve, sep } from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const REQUIRED_PACKAGE_NAMES = [
  "core",
  "agent-common",
  "codex",
  "claude-code",
  "antigravity",
] as const;
const SOURCE_ROOTS = [
  { name: "core", source: "wrapper/core/src", tsconfig: "wrapper/core/tsconfig.json" },
  { name: "agent-common", source: "wrapper/agent-common/src", tsconfig: "wrapper/agent-common/tsconfig.json" },
  { name: "codex", source: "wrapper/codex/src", tsconfig: "wrapper/codex/tsconfig.json" },
  { name: "claude-code", source: "wrapper/claude-code/src", tsconfig: "wrapper/claude-code/tsconfig.json" },
  { name: "antigravity", source: "wrapper/antigravity/src", tsconfig: "wrapper/antigravity/tsconfig.json" },
] as const;
const SINK_FILE = "wrapper/core/src/redact.ts";
const SINK_EXPORT = "writeRedactedStderr";
const APPROVED_NODE_BUILTIN_MODULES = new Set([
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:os",
  "node:path",
  "node:perf_hooks",
  "node:url",
  "node:util",
]);
const NODE_BUILTIN_MODULES = new Set(
  builtinModules.flatMap((specifier) =>
    specifier.startsWith("node:") ? [specifier, specifier.slice(5)] : [specifier, `node:${specifier}`],
  ),
);
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
const DANGEROUS_UNRESOLVED_MEMBER_NAMES = new Set(["stderr", "write", "_write", "end"]);

interface Violation {
  file: string;
  message: string;
}

interface ScanResult {
  approvedSinkHits: number;
  diagnostics: readonly ts.Diagnostic[];
  filesVisited: ReadonlyMap<string, number>;
  unresolvedMemberAccesses: number;
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
  if ((type.flags & (
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Never
  )) !== 0) return true;
  return type.isUnionOrIntersection() && type.types.some(typeIsUnresolved);
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

function resolvedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

function symbolHasNodeDeclaration(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  names: ReadonlySet<string>,
): boolean {
  const resolved = resolvedSymbol(checker, symbol);
  return resolved !== undefined && names.has(resolved.getName()) &&
    (resolved.declarations?.some(declarationIsNodeProcess) ?? false);
}

function typeIsNodeRequire(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some((part) => typeIsNodeRequire(checker, part));
  const symbol = type.getSymbol();
  if (symbolHasNodeDeclaration(checker, symbol, new Set(["NodeRequire", "Require"]))) return true;
  return type.getCallSignatures().some((signature) => {
    const declaration = signature.getDeclaration();
    return declaration !== undefined && declaration.getSourceFile().fileName.includes(`${sep}@types${sep}node${sep}`) &&
      declaration.getText().includes("NodeRequire");
  });
}

function typeIsFunctionCapability(type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some(typeIsFunctionCapability);
  const name = type.getSymbol()?.getName();
  return name === "Function" || name === "FunctionConstructor";
}

function isClassThis(node: ts.Expression): boolean {
  if (node.kind !== ts.SyntaxKind.ThisKeyword) return true;
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return true;
    if (ts.isFunctionLike(current) &&
      !ts.isArrowFunction(current) &&
      !ts.isMethodDeclaration(current) &&
      !ts.isConstructorDeclaration(current) &&
      !ts.isGetAccessorDeclaration(current) &&
      !ts.isSetAccessorDeclaration(current)) return false;
  }
  return false;
}

function elementName(node: ts.ElementAccessExpression): string | undefined {
  const argument = node.argumentExpression;
  return argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : elementName(node);
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  return NODE_BUILTIN_MODULES.has(specifier);
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
      unresolvedMemberAccesses: 0,
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
  let unresolvedMemberAccesses = 0;

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
    stderrType !== undefined &&
    !typeIsUnresolved(type) &&
    sameSymbol(type.getSymbol(), stderrType.getSymbol()) &&
    checker.isTypeAssignableTo(type, stderrType);
  const symbolIsConsole = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = resolvedSymbol(checker, symbol);
    return resolved?.getName() === "console" &&
      (resolved.declarations?.some((declaration) =>
        declaration.getSourceFile().fileName.includes("console.d.ts"),
      ) ?? false);
  };
  const symbolIsGlobalCapability = (symbol: ts.Symbol | undefined): boolean => {
    const resolved = resolvedSymbol(checker, symbol);
    if (resolved === undefined) return true;
    return resolved.declarations?.some((declaration) =>
      !SOURCE_ROOTS.some((root) => under(declaration.getSourceFile().fileName, resolve(REPOSITORY_ROOT, root.source))),
    ) ?? true;
  };
  const isStderrAccess = (node: ts.PropertyAccessExpression): boolean =>
    sameSymbol(checker.getSymbolAtLocation(node.name), stderrSymbol);
  const isForbiddenLoaderSymbol = (node: ts.Expression): boolean =>
    symbolHasNodeDeclaration(
      checker,
      checker.getSymbolAtLocation(node),
      new Set(["createRequire", "getBuiltinModule"]),
    );
  const checkModuleSpecifier = (source: ts.SourceFile, node: ts.Node, specifier: string): void => {
    if (isNodeBuiltinSpecifier(specifier) && !APPROVED_NODE_BUILTIN_MODULES.has(specifier)) {
      add(source, node, `${specifier} module loading is not approved`);
    }
  };

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (FORBIDDEN_GLOBALS.has(node.text) && symbolIsGlobalCapability(checker.getSymbolAtLocation(node))) {
          add(source, node, `${node.text} is not an approved diagnostic capability`);
        }
        if (node.text === "console" || symbolIsConsole(checker.getSymbolAtLocation(node))) {
          add(source, node, "console is not an approved diagnostic sink");
        }
        if (symbolHasNodeDeclaration(
          checker,
          checker.getSymbolAtLocation(node),
          new Set(["createRequire", "getBuiltinModule"]),
        )) {
          add(source, node, "Node module-loader capability is not approved");
        }
      }

      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        checkModuleSpecifier(source, node.moduleSpecifier, node.moduleSpecifier.text);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        if (expression === undefined || !ts.isStringLiteral(expression)) {
          add(source, node, "non-literal import assignment is not approved");
        } else {
          checkModuleSpecifier(source, expression, expression.text);
        }
      }
      if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const calleeType = checker.getTypeAtLocation(node.expression);
        const isRequire = typeIsNodeRequire(checker, calleeType);
        if (isDynamicImport || isRequire) {
          const specifier = node.arguments[0];
          if (!isLiteralModuleSpecifier(specifier)) {
            add(source, node, "non-literal dynamic module loading is not approved");
          } else {
            checkModuleSpecifier(source, specifier, specifier.text);
          }
        }
        if (isForbiddenLoaderSymbol(node.expression)) {
          add(source, node.expression, "Node module-loader capability is not approved");
        }
        if (typeIsFunctionCapability(calleeType)) {
          add(source, node.expression, "dynamic Function capability is not approved");
        }
      }
      if (ts.isNewExpression(node) && typeIsFunctionCapability(checker.getTypeAtLocation(node.expression))) {
        add(source, node.expression, "dynamic Function capability is not approved");
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

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const receiverType = checker.getTypeAtLocation(node.expression);
        const name = memberName(node);
        if (name === "constructor") {
          add(source, node, "dynamic Function constructor access is not approved");
        }
        if (typeIsUnresolved(receiverType) || (!isClassThis(node.expression) && node.expression.kind === ts.SyntaxKind.ThisKeyword)) {
          unresolvedMemberAccesses += 1;
          add(source, node, `unresolved receiver member access${name === undefined ? "" : `.${name}`} is not approved`);
        }
        if (name !== undefined && DANGEROUS_UNRESOLVED_MEMBER_NAMES.has(name) && typeIsUnresolved(receiverType)) {
          add(source, node, `unresolved receiver.${name} is not approved`);
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
    unresolvedMemberAccesses,
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

function requiredRootViolations(filesVisited: ReadonlyMap<string, number>): Violation[] {
  return REQUIRED_PACKAGE_NAMES
    .filter((name) => (filesVisited.get(name) ?? 0) === 0)
    .map((name) => ({
      file: name,
      message: "required production source root was not visited",
    }));
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
    unresolvedMemberAccesses: summaries.reduce((total, summary) => total + summary.unresolvedMemberAccesses, 0),
    violations: [...summaries.flatMap((summary) => summary.violations), ...requiredRootViolations(filesVisited)],
  };
}

describe("wrapper stderr sink guard", () => {
  it("scans every production source root with a diagnostic-free TypeScript program", () => {
    const result = allSources();

    expect(result.diagnostics).toEqual([]);
    expect(result.violations).toEqual([]);
    expect([...result.filesVisited.keys()]).toEqual(REQUIRED_PACKAGE_NAMES);
    for (const name of REQUIRED_PACKAGE_NAMES) {
      expect(result.filesVisited.get(name)).toBeGreaterThan(0);
    }
    expect(result.approvedSinkHits).toBe(1);
    expect(result.unresolvedMemberAccesses).toBe(0);
  });

  it("rejects a scan with a required source root omitted", () => {
    const result = requiredRootViolations(new Map([
      ["core", 1],
      ["agent-common", 1],
      ["codex", 1],
      ["claude-code", 1],
    ]));

    expect(result).toContainEqual({
      file: "antigravity",
      message: "required production source root was not visited",
    });
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
    ["any receiver with literal elements", 'process.on("exit", function(this: any) { this["stderr"]["write"]("api_key=abcdef123456"); });'],
    ["module loader console", 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const c = load("node:console"); c.error("api_key=abcdef123456");'],
    ["module loader process bracket", 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const p = load("node:process"); p["stderr"]["write"]("api_key=abcdef123456");'],
    ["dynamic Function constructor", 'const make = (() => {}).constructor; make("process.stderr.write(\\"api_key=abcdef123456\\")")();'],
  ])("rejects a %s diagnostic bypass", (_label, source) => {
    expect(scanText(source).violations).not.toEqual([]);
  });

  it("rejects a non-top-level sink lookalike", () => {
    expect(scanText(
      'export namespace X { export function writeRedactedStderr(text: string) { process.stderr.write(text); } }',
    ).violations).not.toEqual([]);
  });

  it("rejects unresolved literal element access", () => {
    const result = scanText(
      'process.on("exit", function(this: any) { this["stderr"]["write"]("api_key=abcdef123456"); });',
    );

    expect(result.violations.map((violation) => violation.message)).toContain(
      "unresolved receiver member access.stderr is not approved at 1",
    );
  });

  it("rejects non-literal and forbidden module loading", () => {
    expect(scanText("require(name);").violations).not.toEqual([]);
    expect(scanText("import(name);").violations).not.toEqual([]);
    expect(scanText('require("node:process");').violations).not.toEqual([]);
    expect(scanText('import("node:console");').violations).not.toEqual([]);
    expect(scanText('import { createRequire } from "node:module";').violations).not.toEqual([]);
    expect(scanText('declare const load: NodeRequire; load("node:console");').violations).not.toEqual([]);
    expect(scanText('declare const load: NodeRequire; load("node:process")["stderr"]["write"]("api_key=abcdef123456");').violations).not.toEqual([]);
  });

  it("rejects NodeRequire and Function values even when their identifiers are renamed", () => {
    const loader = scanText('declare const load: NodeRequire; load("node:console");');
    const dynamicFunction = scanText('declare const make: Function; make("return 1")();');

    expect(loader.violations.map((violation) => violation.message)).toContain(
      "node:console module loading is not approved at 1",
    );
    expect(dynamicFunction.violations.map((violation) => violation.message)).toContain(
      "dynamic Function capability is not approved at 1",
    );
  });

  it("rejects dynamic Function constructor access before it can be called", () => {
    const result = scanText('const make = (() => {}).constructor; make("return 1")();');

    expect(result.violations.map((violation) => violation.message)).toContain(
      "dynamic Function constructor access is not approved at 1",
    );
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

  it("accepts an ordinary function call without dynamic-code capability access", () => {
    expect(scanText('const make = () => "safe"; make();')).toMatchObject({ violations: [] });
  });
});
