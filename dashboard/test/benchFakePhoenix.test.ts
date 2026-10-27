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
// member read from the real Phoenix `Channel`, `Socket` and `Push` types, and
// requires the fake to implement each one.
//
// Not covered: accesses on values whose type was erased (`as unknown as`,
// `any`), dynamic member names, and the internal members protocol.ts guards
// with `typeof` (the fake leaves those absent on purpose). It checks member
// presence only, not signatures or runtime meaning, and it cannot see new
// same-origin endpoints the App starts to call.

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
}

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

  const used = { Channel: new Set<string>(), Socket: new Set<string>(), Push: new Set<string>() };
  const unsupported: string[] = [];
  const phoenixKind = (type: ts.Type): PhoenixType | undefined => {
    const symbol = checker.getNonNullableType(type).getSymbol();
    const file = symbol?.declarations?.[0]?.getSourceFile().fileName ?? "";
    return symbol && file.includes("@types/phoenix") &&
      (PHOENIX_TYPES as readonly string[]).includes(symbol.name)
      ? (symbol.name as PhoenixType)
      : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const kind = phoenixKind(checker.getTypeAtLocation(node.expression));
      if (kind) used[kind].add(node.name.text);
    } else if (ts.isElementAccessExpression(node)) {
      const kind = phoenixKind(checker.getTypeAtLocation(node.expression));
      if (kind) {
        const arg = node.argumentExpression;
        if (ts.isStringLiteralLike(arg)) used[kind].add(arg.text);
        else unsupported.push(`dynamic member access on ${kind}`);
      }
    } else if (ts.isObjectBindingPattern(node)) {
      const owner = node.parent;
      const type = ts.isVariableDeclaration(owner) && owner.initializer
        ? checker.getTypeAtLocation(owner.initializer)
        : ts.isParameter(owner) ? checker.getTypeAtLocation(owner) : undefined;
      if (type && phoenixKind(type)) unsupported.push("destructuring of a Phoenix value");
    }
    ts.forEachChild(node, visit);
  };
  visit(program.getSourceFile(PROTOCOL)!);

  const implemented = { Channel: new Set<string>(), Socket: new Set<string>(), Push: new Set<string>() };
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
  return { used, implemented, unsupported };
}

function problems(s: Surface): string[] {
  const out = [...s.unsupported];
  for (const kind of PHOENIX_TYPES) {
    if (s.used[kind].size === 0) out.push(`no ${kind} member access found in protocol.ts`);
    if (s.implemented[kind].size === 0) out.push(`fake class ${FAKE_CLASS[kind]} not found`);
    for (const member of s.used[kind]) {
      if (!s.implemented[kind].has(member)) out.push(`${kind}.${member} missing from the fake`);
    }
  }
  return out;
}

const phoenixImport = [
  /\bfrom\s+["']phoenix["']/,
  /\bimport\(\s*["']phoenix["']\s*\)/,
  /\brequire\(\s*["']phoenix["']\s*\)/,
];

function phoenixImporters(srcDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|svelte)$/.test(entry.name) &&
        phoenixImport.some((re) => re.test(fs.readFileSync(file, "utf8")))) {
        found.push(path.relative(srcDir, file).split(path.sep).join("/"));
      }
    }
  };
  walk(srcDir);
  return found.sort();
}

describe("bench fake phoenix transport", () => {
  const protocolSource = fs.readFileSync(PROTOCOL, "utf8");
  const fakeSource = fs.readFileSync(FAKE, "utf8");

  it("implements every Phoenix member protocol.ts uses", () => {
    const real = surface();
    expect(problems(real)).toEqual([]);
    // Anchors so a pass cannot come from an empty or shrunken scan.
    expect([...real.used.Channel]).toEqual(expect.arrayContaining(["join", "onError", "onClose", "state"]));
    expect([...real.used.Socket]).toEqual(expect.arrayContaining(["connect", "isConnected", "channel"]));
    expect([...real.used.Push]).toContain("receive");
  }, 120_000);

  it("fails when the fake lacks a member protocol.ts uses", () => {
    const stripped = fakeSource.replace("  join(): FakePush {", "  joinRenamed(): FakePush {");
    expect(stripped).not.toBe(fakeSource);
    expect(problems(surface({ [FAKE]: stripped }))).toContain("Channel.join missing from the fake");
  }, 120_000);

  it("fails when protocol.ts starts reading a Phoenix member the fake lacks", () => {
    // `topic` exists on the real Channel type but not on the fake, so this is
    // a fake mismatch rather than a type error.
    const probed = `${protocolSource}\nexport function benchProbe(c: Channel): string { return c.topic; }\n`;
    expect(problems(surface({ [PROTOCOL]: probed }))).toContain("Channel.topic missing from the fake");
  }, 120_000);

  it("fails closed on destructuring and dynamic member access", () => {
    const probed =
      `${protocolSource}\n` +
      `export function benchProbeA(c: Channel): string { const { topic } = c; return topic; }\n` +
      `export function benchProbeB(c: Channel, name: "topic"): string { return c[name]; }\n`;
    const out = problems(surface({ [PROTOCOL]: probed }));
    expect(out).toContain("destructuring of a Phoenix value");
    expect(out).toContain("dynamic member access on Channel");
  }, 120_000);

  it("fails when the scan finds nothing to check", () => {
    expect(problems(surface({ [PROTOCOL]: "export const x = 1;\n" }))).toContain(
      "no Channel member access found in protocol.ts",
    );
  }, 120_000);

  it("allows only protocol.ts to import phoenix", () => {
    expect(phoenixImporters(path.join(dashboard, "src"))).toEqual(["lib/protocol.ts"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-phoenix-importers-"));
    try {
      fs.writeFileSync(path.join(dir, "other.ts"), 'import { Socket } from "phoenix";\n');
      fs.writeFileSync(path.join(dir, "lazy.svelte"), '<script>const p = import("phoenix");</script>\n');
      fs.writeFileSync(path.join(dir, "plain.ts"), "export const a = 1;\n");
      expect(phoenixImporters(dir)).toEqual(["lazy.svelte", "other.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
