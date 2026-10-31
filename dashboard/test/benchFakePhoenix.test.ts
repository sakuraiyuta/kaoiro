import "./isolation.setup";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// bench/fakePhoenix.ts stands in for the `phoenix` package in the App-level
// bench, but bench/ is outside tsconfig, so nothing type-checks it. This
// test walks src/lib/protocol.ts with the TypeScript checker, collects every
// member read from the real Phoenix Channel, Socket and Push types, and
// requires the fake to implement each one.
//
// A Phoenix type mixed with another type, or with a second Phoenix type, is
// reported instead of being treated as a member requirement. Object patterns
// and assignment object literals are judged by the type of the value being
// destructured, at any nesting depth. An assertion from a Phoenix type to a
// different type is counted, and is not a member requirement.
//
// Not covered: a Phoenix value read outside protocol.ts, and erasure that is
// not an assertion (a structural variable or parameter). Member presence
// only, not signatures or runtime meaning.

const dashboard = fileURLToPath(new URL("..", import.meta.url));
const PROTOCOL = path.join(dashboard, "src/lib/protocol.ts");
const FAKE = path.join(dashboard, "bench/fakePhoenix.ts");
const PHOENIX_TYPES = ["Channel", "Socket", "Push"] as const;
type PhoenixType = (typeof PHOENIX_TYPES)[number];
const FAKE_CLASS: Record<PhoenixType, string> = {
  Channel: "FakeChannel",
  Socket: "Socket",
  Push: "FakePush",
};

interface Surface {
  used: Record<PhoenixType, Set<string>>;
  implemented: Record<PhoenixType, Set<string>>;
  unsupported: string[];
  assertions: string[];
  phoenixTypesFile: string | undefined;
}

type PhoenixClass =
  | { kind: "none" }
  | { kind: "one"; name: PhoenixType }
  | { kind: "mixed"; names: PhoenixType[] };

function surface(overrides: Record<string, string> = {}): Surface {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(dashboard, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (!config) throw new Error("tsconfig.json did not parse");
  const host = ts.createCompilerHost(config.options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => overrides[file] ?? read(file);
  host.fileExists = (file) => file in overrides || exists(file);
  host.getSourceFile = (file, languageVersion, ...rest) =>
    file in overrides
      ? ts.createSourceFile(file, overrides[file]!, languageVersion, true)
      : getSourceFile(file, languageVersion, ...rest);
  const program = ts.createProgram([PROTOCOL, FAKE], config.options, host);
  const checker = program.getTypeChecker();

  const used = {
    Channel: new Set<string>(),
    Socket: new Set<string>(),
    Push: new Set<string>(),
  };
  const unsupported: string[] = [];
  const assertions: string[] = [];
  let phoenixTypesFile: string | undefined;

  const nullish = (type: ts.Type): boolean =>
    (type.flags & (
      ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void
    )) !== 0;

  const phoenixName = (type: ts.Type): PhoenixType | undefined => {
    const symbol = type.getSymbol();
    const file = symbol?.declarations?.[0]?.getSourceFile().fileName ?? "";
    return symbol &&
      file.includes("@types/phoenix") &&
      (PHOENIX_TYPES as readonly string[]).includes(symbol.name)
      ? (symbol.name as PhoenixType)
      : undefined;
  };

  const classify = (type: ts.Type): PhoenixClass => {
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const apparent = checker.getApparentType(type);
      if (
        apparent !== type &&
        (apparent.flags & ts.TypeFlags.TypeParameter) === 0
      ) {
        return classify(apparent);
      }
      return { kind: "mixed", names: [] };
    }
    const names = new Set<PhoenixType>();
    let other = false;
    const visitType = (current: ts.Type): void => {
      if (current.isUnion()) {
        for (const part of current.types) {
          if (!nullish(part)) visitType(part);
        }
        return;
      }
      if (current.isIntersection()) {
        for (const part of current.types) visitType(part);
        return;
      }
      const name = phoenixName(current);
      if (name) names.add(name);
      else other = true;
    };
    visitType(type);
    if (names.size === 1 && !other) {
      return { kind: "one", name: [...names][0]! };
    }
    if (names.size === 0) return { kind: "none" };
    return { kind: "mixed", names: [...names].sort() };
  };

  const at = (node: ts.Node): string => {
    let cur: ts.Node | undefined = node;
    while (cur) {
      if (
        (ts.isFunctionDeclaration(cur) ||
          ts.isFunctionExpression(cur) ||
          ts.isMethodDeclaration(cur)) &&
        cur.name &&
        ts.isIdentifier(cur.name)
      ) {
        return cur.name.text;
      }
      cur = cur.parent;
    }
    return "protocol.ts";
  };

  const compound = (cls: PhoenixClass, node: ts.Node): string => {
    const names = cls.kind === "mixed" ? cls.names : [];
    const listed = names.length > 0
      ? names.join("|")
      : "unresolved type parameter";
    return `unsupported Phoenix access on ${listed} at ${at(node)}`;
  };

  const noteRead = (
    cls: PhoenixClass,
    node: ts.Node,
    member: string | undefined,
  ): void => {
    if (cls.kind === "one" && member !== undefined) {
      used[cls.name].add(member);
    } else if (cls.kind === "mixed") {
      unsupported.push(compound(cls, node));
    }
  };

  const noteDestructure = (type: ts.Type, node: ts.Node): void => {
    const cls = classify(type);
    if (cls.kind === "one" || cls.kind === "mixed") {
      unsupported.push(`destructuring of a Phoenix value at ${at(node)}`);
    }
  };

  const visitAssignment = (
    literal: ts.ObjectLiteralExpression,
    source: ts.Type,
  ): void => {
    const cls = classify(source);
    if (cls.kind === "one" || cls.kind === "mixed") {
      unsupported.push(`destructuring of a Phoenix value at ${at(literal)}`);
      return;
    }
    for (const prop of literal.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      if (!ts.isIdentifier(prop.name)) continue;
      if (!ts.isObjectLiteralExpression(prop.initializer)) continue;
      const inner = checker.getTypeOfPropertyOfType(source, prop.name.text);
      if (inner) visitAssignment(prop.initializer, inner);
    }
  };

  const assertionPlace = (node: ts.Node): string => {
    let binding = "";
    const fn = at(node);
    let cur: ts.Node | undefined = node;
    while (cur.parent) {
      const parent = cur.parent;
      if (
        !binding &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name) &&
        parent.initializer !== undefined &&
        node.pos >= parent.initializer.pos &&
        node.end <= parent.initializer.end
      ) {
        binding = parent.name.text;
      }
      cur = parent;
    }
    return binding ? `${fn}:${binding}` : fn;
  };

  const sameSingle = (op: PhoenixClass, target: ts.Type): boolean => {
    const tg = classify(target);
    return op.kind === "one" && tg.kind === "one" && op.name === tg.name;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      noteRead(
        classify(checker.getTypeAtLocation(node.expression)),
        node,
        node.name.text,
      );
    } else if (ts.isElementAccessExpression(node)) {
      const cls = classify(checker.getTypeAtLocation(node.expression));
      const arg = node.argumentExpression;
      if (cls.kind === "one" && arg && ts.isStringLiteralLike(arg)) {
        used[cls.name].add(arg.text);
      } else if (cls.kind === "one") {
        unsupported.push(`dynamic member access on ${cls.name} at ${at(node)}`);
      } else if (cls.kind === "mixed") {
        unsupported.push(compound(cls, node));
      }
    } else if (ts.isObjectBindingPattern(node)) {
      noteDestructure(checker.getTypeAtLocation(node), node);
    } else if (
      ts.isObjectLiteralExpression(node) &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.parent.left === node
    ) {
      visitAssignment(node, checker.getTypeAtLocation(node.parent.right));
    } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const op = classify(checker.getTypeAtLocation(node.expression));
      const target = checker.getTypeFromTypeNode(node.type);
      if (op.kind === "one" && !sameSingle(op, target)) {
        assertions.push(
          `type assertion erases ${op.name} at ${assertionPlace(node)}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(program.getSourceFile(PROTOCOL)!);

  const resolvedSymbol = (symbol: ts.Symbol): ts.Symbol =>
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;

  const imports = program.getSourceFile(PROTOCOL)!.statements.filter((node) =>
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    node.moduleSpecifier.text === "phoenix"
  );
  if (imports.length > 0) {
    let resolved = true;
    for (const node of imports) {
      if (!ts.isImportDeclaration(node)) continue;
      const spec = node.moduleSpecifier;
      const symbol = ts.isStringLiteral(spec)
        ? checker.getSymbolAtLocation(spec)
        : undefined;
      const moduleSymbol = symbol ? resolvedSymbol(symbol) : undefined;
      const exports = moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol)
        : [];
      for (const name of PHOENIX_TYPES) {
        const found = exports.find((item) => item.name === name);
        const target = found ? resolvedSymbol(found) : undefined;
        const file = target?.declarations?.[0]?.getSourceFile().fileName ?? "";
        if (!file.includes("@types/phoenix")) resolved = false;
        else phoenixTypesFile ??= file;
      }
    }
    if (!resolved) unsupported.push("phoenix types did not resolve");
  }

  const implemented = {
    Channel: new Set<string>(),
    Socket: new Set<string>(),
    Push: new Set<string>(),
  };
  program.getSourceFile(FAKE)!.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    for (const kind of PHOENIX_TYPES) {
      if (node.name.text !== FAKE_CLASS[kind]) continue;
      for (const member of node.members) {
        if (member.name && !ts.isPrivateIdentifier(member.name)) {
          implemented[kind].add(member.name.getText());
        }
      }
    }
  });
  return { used, implemented, unsupported, assertions, phoenixTypesFile };
}

function problems(s: Surface): string[] {
  const out = [...s.unsupported];
  for (const kind of PHOENIX_TYPES) {
    if (s.used[kind].size === 0) {
      out.push(`no ${kind} member access found in protocol.ts`);
    }
    if (s.implemented[kind].size === 0) {
      out.push(`fake class ${FAKE_CLASS[kind]} not found`);
    }
    for (const member of s.used[kind]) {
      if (!s.implemented[kind].has(member)) {
        out.push(`${kind}.${member} missing from the fake`);
      }
    }
  }
  return out;
}

const literalArg = /^["'`]([^"'`]*)["'`]$/;

function importsPhoenix(text: string): boolean {
  if (/\bfrom\s+["']phoenix["']/.test(text)) return true;
  if (/(?:^|[^\w.$])import\s+["']phoenix["']/.test(text)) return true;
  const calls = /\b(?:import|require)\s*\(\s*([\s\S]*?)\s*\)/g;
  for (const match of text.matchAll(calls)) {
    const arg = match[1].trim();
    const literal = literalArg.exec(arg);
    if (literal) {
      if (literal[1] === "phoenix") return true;
      continue;
    }
    // The argument is not a literal module name, so fail closed.
    return true;
  }
  return false;
}

function phoenixImporters(srcDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        /\.(ts|svelte)$/.test(entry.name) &&
        importsPhoenix(fs.readFileSync(file, "utf8"))
      ) {
        found.push(path.relative(srcDir, file).split(path.sep).join("/"));
      }
    }
  };
  walk(srcDir);
  return found.sort();
}

const realAssertions = [
  "type assertion erases Socket at connectKaoiro:socketWithConnect",
  "type assertion erases Socket at connectKaoiro:socketWithTeardown",
  "type assertion erases Socket at connectKaoiro:timerInternals",
  "type assertion erases Socket at drainPhoenixTimers:s",
];

function probed(source: string, extra: string): Surface {
  return surface({ [PROTOCOL]: `${source}\n${extra}\n` });
}

describe("bench fake phoenix transport", () => {
  const protocolSource = fs.readFileSync(PROTOCOL, "utf8");
  const fakeSource = fs.readFileSync(FAKE, "utf8");

  it("implements every Phoenix member protocol.ts uses", () => {
    const real = surface();
    expect(problems(real)).toEqual([]);
    expect(real.assertions).toEqual(realAssertions);
    expect([...real.used.Channel]).toEqual(
      expect.arrayContaining(["join", "onError", "onClose", "state"]),
    );
    expect([...real.used.Socket]).toEqual(
      expect.arrayContaining(["connect", "isConnected", "channel"]),
    );
    expect([...real.used.Push]).toContain("receive");
    expect(real.phoenixTypesFile).toBeTruthy();
  }, 120_000);

  it("fails when the fake lacks a member protocol.ts uses", () => {
    const stripped = fakeSource.replace(
      "  join(): FakePush {",
      "  joinRenamed(): FakePush {",
    );
    expect(stripped).not.toBe(fakeSource);
    expect(problems(surface({ [FAKE]: stripped }))).toContain(
      "Channel.join missing from the fake",
    );
  }, 120_000);

  it("fails when protocol.ts reads a member the fake lacks", () => {
    const extra =
      "export function benchProbe(c: Channel): string { return c.topic; }\n";
    expect(problems(probed(protocolSource, extra))).toContain(
      "Channel.topic missing from the fake",
    );
  }, 120_000);

  it("keeps correct Phoenix code green", () => {
    const extra = [
      "export function benchIdentForOf(channels: Channel[]) {",
      "  for (const c of channels) return c.join();",
      "}",
      "export function benchIdentArray(channels: Channel[]) {",
      "  const [first] = channels;",
      "  return first.join();",
      "}",
      "export function benchNullUnion(c: Channel | null) {",
      "  return c?.join();",
      "}",
      "export function benchSameCast(socket: Socket) {",
      "  return socket as Socket;",
      "}",
      "export function benchGeneric<T extends Channel>(value: T) {",
      "  return value.join();",
      "}",
      "export function benchForIn(c: Channel) {",
      "  let key = \"\";",
      "  for (const k in c) key = k;",
      "  return key;",
      "}",
    ].join("\n");
    const out = probed(protocolSource, extra);
    expect(problems(out)).toEqual([]);
    expect(out.assertions).toEqual(realAssertions);
  }, 120_000);

  it("fails closed on destructuring of a Phoenix value", () => {
    const extra = [
      "export function benchPlain(c: Channel): string {",
      "  const { topic } = c;",
      "  return topic;",
      "}",
      "export function benchNestedArray(channels: Channel[]): string {",
      "  const [{ topic }] = channels;",
      "  return topic;",
      "}",
      "export function benchNestedObject(",
      "  holder: { inner: Channel },",
      "): string {",
      "  const { inner: { topic } } = holder;",
      "  return topic;",
      "}",
      "export function benchForOfPattern(channels: Channel[]): string {",
      "  for (const { topic } of channels) return topic;",
      "  return \"\";",
      "}",
      "export function benchParam({ topic }: Channel): string {",
      "  return topic;",
      "}",
      "export function benchAssign(c: Channel): string {",
      "  let topic = \"\";",
      "  ({ topic } = c);",
      "  return topic;",
      "}",
      "export function benchAssignNested(",
      "  holder: { inner: Channel },",
      "): string {",
      "  let topic = \"\";",
      "  ({ inner: { topic } } = holder);",
      "  return topic;",
      "}",
      "export function benchDynamic(c: Channel, name: \"topic\"): string {",
      "  return c[name];",
      "}",
    ].join("\n");
    const out = problems(probed(protocolSource, extra));
    for (const name of [
      "benchPlain",
      "benchNestedArray",
      "benchNestedObject",
      "benchForOfPattern",
      "benchParam",
      "benchAssign",
      "benchAssignNested",
    ]) {
      expect(out).toContain(`destructuring of a Phoenix value at ${name}`);
    }
    expect(out).toContain("dynamic member access on Channel at benchDynamic");
  }, 120_000);

  it("fails closed on mixed Phoenix unions and intersections", () => {
    const extra = [
      "type BenchAlias = Channel | { topic: string };",
      "export function benchUnion(c: Channel | { topic: string }): string {",
      "  return c.topic;",
      "}",
      "export function benchAlias(c: BenchAlias): string {",
      "  return c.topic;",
      "}",
      "export function benchIntersection(",
      "  c: Channel & { extra: number },",
      "): number {",
      "  return c.topic.length + c.extra;",
      "}",
      "export function benchTwo(c: Channel | Socket): unknown {",
      "  return c.topic;",
      "}",
    ].join("\n");
    const out = problems(probed(protocolSource, extra));
    expect(out).toContain(
      "unsupported Phoenix access on Channel at benchUnion",
    );
    expect(out).toContain(
      "unsupported Phoenix access on Channel at benchAlias",
    );
    expect(out).toContain(
      "unsupported Phoenix access on Channel at benchIntersection",
    );
    expect(out).toContain(
      "unsupported Phoenix access on Channel|Socket at benchTwo",
    );
  }, 120_000);

  it("fails when the scan finds nothing to check", () => {
    expect(problems(surface({ [PROTOCOL]: "export const x = 1;\n" }))).toEqual([
      "no Channel member access found in protocol.ts",
      "no Socket member access found in protocol.ts",
      "no Push member access found in protocol.ts",
    ]);
  }, 120_000);

  it("fails when phoenix types do not resolve", () => {
    const real = surface();
    const file = real.phoenixTypesFile;
    expect(file).toBeTruthy();
    const out = problems(surface({ [file!]: "export {};\n" }));
    expect(out).toContain("phoenix types did not resolve");
  }, 120_000);

  it("counts assertions that erase a Phoenix type", () => {
    const extra = [
      "export function benchErase(socket: Socket): unknown {",
      "  return socket as { connect(): void };",
      "}",
      "export function benchAny(socket: Socket): unknown {",
      "  return <any>socket;",
      "}",
      "export function benchNever(socket: Socket): unknown {",
      "  return socket as never;",
      "}",
    ].join("\n");
    const out = probed(protocolSource, extra);
    expect(out.assertions).toEqual([
      ...realAssertions,
      "type assertion erases Socket at benchErase",
      "type assertion erases Socket at benchAny",
      "type assertion erases Socket at benchNever",
    ]);
    expect(problems(out)).toEqual([]);
  }, 120_000);

  it("allows only protocol.ts to import phoenix", () => {
    expect(phoenixImporters(path.join(dashboard, "src"))).toEqual([
      "lib/protocol.ts",
    ]);
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "bench-phoenix-importers-"),
    );
    try {
      const files: Record<string, string> = {
        "other.ts": "import { Socket } from \"phoenix\";\n",
        "lazy.svelte": "<script>const p = import(\"phoenix\");</script>\n",
        "plain.ts": "export const a = 1;\n",
        "side.ts": "import \"phoenix\";\n",
        "spaced.ts": "const p = import ( \"phoenix\" );\n",
        "template.ts": "const p = import(`phoenix`);\n",
        "variable.ts": "const name = \"phoenix\";\nconst p = import(name);\n",
        "substituted.ts": "const p = import(`ph${\"oenix\"}`);\n",
        "othermod.ts": "const p = import(\"other\");\n",
        "mermaid.ts": "const p = import(\"mermaid\");\n",
      };
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body);
      }
      expect(phoenixImporters(dir)).toEqual([
        "lazy.svelte",
        "other.ts",
        "side.ts",
        "spaced.ts",
        "substituted.ts",
        "template.ts",
        "variable.ts",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
