import "../../../scripts/test/fixtures/test-isolation.mjs";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// src/acp/ speaks ACP only. Engine details reach it as injected parameters
// (AcpExtension, the session/new _meta value), never as names in its source.
interface Rule {
  name: string;
  pattern: RegExp;
  // Prose may use an ordinary word; rules that set this are matched against
  // the source with comments removed. Every other rule also reads comments.
  codeOnly?: boolean;
}
const RULES: readonly Rule[] = [
  { name: "_x.ai namespace", pattern: /_x\.ai/ },
  { name: "GROK_ prefix", pattern: /GROK_/ },
  { name: "grok", pattern: /grok/i },
  { name: "promptId", pattern: /promptId/ },
  { name: "requestId", pattern: /requestId/ },
  { name: "prompt_id", pattern: /prompt_id/ },
  { name: "request_id", pattern: /request_id/ },
  { name: "cancellationCategory", pattern: /cancellationCategory/ },
  { name: "vendor_kind", pattern: /vendor_kind/ },
  { name: "hook_event", pattern: /hook_event/ },
  { name: "rules", pattern: /\brules\b/, codeOnly: true },
];
const IMPORT_RULE = "import outside acp/";

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | undefined;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
      i += 1;
    } else if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

// Module specifiers of imports, re-exports, `import x = require()`, dynamic
// `import()`, `require()` and import types. A specifier that is not a string
// literal is `undefined`: where it points cannot be shown, so it counts as
// leaving acp/.
function moduleSpecifiers(source: string): (string | undefined)[] {
  const file = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: (string | undefined)[] = [];
  const literal = (node: ts.Node | undefined) =>
    node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      found.push(literal(node.moduleSpecifier));
    } else if (ts.isExternalModuleReference(node)) {
      found.push(literal(node.expression));
    } else if (ts.isImportTypeNode(node)) {
      found.push(
        ts.isLiteralTypeNode(node.argument)
          ? literal(node.argument.literal)
          : undefined,
      );
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      found.push(literal(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// `dir` is the importing file's directory relative to acp/ ("." at its top).
function leavesAcp(specifier: string | undefined, dir: string): boolean {
  if (specifier === undefined) return true;
  if (specifier.startsWith("/") || specifier.startsWith("file:")) return true;
  if (!/^\.\.?(\/|$)/.test(specifier)) return false;
  const resolved = posix.join(dir, specifier);
  return resolved === ".." || resolved.startsWith("../");
}

export function scanSource(source: string, dir = "."): string[] {
  const code = stripComments(source);
  const names = RULES.filter((rule) =>
    rule.pattern.test(rule.codeOnly ? code : source),
  ).map((rule) => rule.name);
  if (moduleSpecifiers(source).some((s) => leavesAcp(s, dir))) {
    names.push(IMPORT_RULE);
  }
  return names;
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

export function scanTree(root: string): { file: string; rules: string[] }[] {
  return listFiles(root)
    .map((path) => ({
      file: relative(root, path),
      rules: scanSource(
        readFileSync(path, "utf8"),
        dirname(relative(root, path)).split(sep).join("/"),
      ),
    }))
    .filter((entry) => entry.rules.length > 0);
}

const acpDir = fileURLToPath(new URL("../src/acp/", import.meta.url));

describe("src/acp/ is engine-neutral", () => {
  it("scans the real tree and finds no engine-specific name", () => {
    const files = listFiles(acpDir).map((path) => relative(acpDir, path));
    // Guard against a vacuous pass: the scan must see the known modules.
    expect(files).toEqual(
      expect.arrayContaining(["connection.ts", "session.ts"]),
    );
    expect(scanTree(acpDir)).toEqual([]);
    const host = readFileSync(join(acpDir, "../toolhost.ts"), "utf8");
    expect(scanSource(host)).toEqual([]);
  });
});

describe("the detector itself", () => {
  const leaks: [string, string][] = [
    ["_x.ai namespace", 'const m = "_x.ai/session_notification";'],
    ["GROK_ prefix", "const k = process.env.GROK_HOME;"],
    ["grok", "// talks to Grok Build"],
    ["promptId", "const id = meta.promptId;"],
    ["requestId", "const id = meta.requestId;"],
    ["prompt_id", "const id = update.prompt_id;"],
    ["request_id", "const id = { request_id: 1 };"],
    ["cancellationCategory", "meta.cancellationCategory === 'x'"],
    ["vendor_kind", "type T = { vendor_kind?: string };"],
    ["hook_event", "const e = note.hook_event;"],
    ["rules", "_meta: { rules }"],
    ["rules", "const r = { rules: persona };"],
    ["rules", "const r = meta.rules;"],
    ["rules", 'const r = meta["rules"];'],
    [IMPORT_RULE, 'import { x } from "../grok/wire.js";'],
    [IMPORT_RULE, 'const m = await import("../grok/wire.js");'],
    [IMPORT_RULE, 'const m = require("../grok/wire.js");'],
  ];
  it.each(leaks)("flags %s", (rule, source) => {
    expect(scanSource(source)).toContain(rule);
  });

  it("reads comments for every rule except the word and import syntax", () => {
    for (const [rule, source] of leaks) {
      if (rule === "rules" || rule === IMPORT_RULE) continue;
      expect(scanSource(`// ${source}`)).toContain(rule);
      expect(scanSource(`/* ${source} */`)).toContain(rule);
    }
  });

  it("lets prose use the word rules in a comment", () => {
    expect(
      scanSource("// the persona rules are injected\nconst a = 1;"),
    ).toEqual([]);
    expect(
      scanSource("/* the rules,\n more rules */\nconst a = 1;"),
    ).toEqual([]);
  });

  it("still sees rules in code after a comment or a URL string", () => {
    expect(scanSource("const a = 1; // note\nconst rules = 2;")).toContain(
      "rules",
    );
    expect(scanSource('const u = "https://x"; const rules = 2;')).toContain(
      "rules",
    );
    expect(scanSource("/* c */ const rules = 2;")).toContain("rules");
  });

  // [what the specifier is, the importing file's directory in acp/, source]
  const outside: [string, string, string][] = [
    ["a plain parent import", ".", 'import { x } from "../host.js";'],
    ["a side-effect import", ".", 'import "../host.js";'],
    ["a path that normalizes out", ".", 'import { x } from "./../host.js";'],
    [
      "a path that normalizes out through a subdirectory",
      ".",
      'import { x } from "./a/../../host.js";',
    ],
    ["two parents from a subdirectory", "deep", 'import "../../host.js";'],
    [
      "the parent of acp/ named like an acp/ module",
      "deep",
      'import { x } from "../../connection.js";',
    ],
    ["the parent directory itself", ".", 'import x from "..";'],
    ["a type-only import", ".", 'import type { X } from "../host.js";'],
    ["a re-export list", ".", 'export { x } from "../host.js";'],
    ["a star re-export", ".", 'export * from "../host.js";'],
    ["a namespace re-export", ".", 'export * as host from "../host.js";'],
    ["an import-equals require", ".", 'import host = require("../host.js");'],
    ["a dynamic import", ".", 'const m = await import("../host.js");'],
    [
      "a dynamic import in a template",
      ".",
      "const m = await import(`../host.js`);",
    ],
    ["a require call", ".", 'const m = require("../host.js");'],
    ["an import type", ".", 'type T = import("../host.js").X;'],
    [
      "an outside import after an inside one",
      ".",
      'import { a } from "./connection.js";\nimport "../host.js";',
    ],
    ["a computed dynamic import", ".", "const m = await import(name);"],
    [
      "a dynamic import with a template substitution",
      ".",
      "const m = await import(`../${name}.js`);",
    ],
    ["a computed require", ".", "const m = require(name);"],
    ["an absolute path", ".", 'import { x } from "/srv/host.js";'],
    ["a file URL", ".", 'import { x } from "file:///srv/host.js";'],
  ];
  const inside: [string, string, string][] = [
    ["a sibling", ".", 'import { x } from "./connection.js";'],
    ["a child directory", ".", 'import { x } from "./deep/internal.js";'],
    [
      "a parent that is still acp/",
      "deep",
      'import { x } from "../connection.js";',
    ],
    [
      "a side-effect import that stays in acp/",
      "deep",
      'import "../connection.js";',
    ],
    ["acp/ itself from a subdirectory", "deep", 'import x from "..";'],
    ["the current directory", ".", 'import x from ".";'],
    ["a sibling in a subdirectory", "deep", 'import { x } from "./other.js";'],
    [
      "a path that leaves a subdirectory and returns",
      "deep",
      'import { x } from "../deep/other.js";',
    ],
    ["a path that normalizes inside", ".", 'import { x } from "./a/../b.js";'],
    [
      "a dynamic import that stays in acp/",
      "deep",
      'const m = await import("../connection.js");',
    ],
    [
      "a template dynamic import that stays in acp/",
      "deep",
      "const m = await import(`../connection.js`);",
    ],
    [
      "a re-export that stays in acp/",
      "deep",
      'export * from "../connection.js";',
    ],
    [
      "a package",
      ".",
      'import * as acp from "@agentclientprotocol/sdk";',
    ],
    ["a node builtin", ".", 'import { PassThrough } from "node:stream";'],
    ["an export without a source", ".", "const a = 1;\nexport { a };"],
    ["import syntax in a comment", ".", '// import { x } from "../host.js";'],
    [
      "import syntax in a string",
      ".",
      "const s = \"import x from '../host.js'\";",
    ],
  ];
  it.each(outside)("sees %s leave acp/", (_label, dir, source) => {
    expect(scanSource(source, dir)).toEqual([IMPORT_RULE]);
  });
  it.each(inside)("sees %s stay in acp/", (_label, dir, source) => {
    expect(scanSource(source, dir)).toEqual([]);
  });

  it("passes ACP-only code", () => {
    expect(
      scanSource(
        [
          'import * as acp from "@agentclientprotocol/sdk";',
          'import { safeName } from "./connection.js";',
          "// Extension methods start with an underscore.",
          'const method = "session/update";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("walks subdirectories and reports the file", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-boundary-"));
    try {
      mkdirSync(join(root, "deep", "er"), { recursive: true });
      writeFileSync(join(root, "ok.ts"), "export const a = 1;\n");
      expect(scanTree(root)).toEqual([]);
      writeFileSync(
        join(root, "deep", "er", "leak.ts"),
        'export const m = "_x.ai/y";\n',
      );
      expect(scanTree(root)).toEqual([
        { file: join("deep", "er", "leak.ts"), rules: ["_x.ai namespace"] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves each import from its own file's directory", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-boundary-"));
    try {
      mkdirSync(join(root, "deep", "er"), { recursive: true });
      writeFileSync(join(root, "connection.ts"), "export const a = 1;\n");
      writeFileSync(
        join(root, "deep", "internal.ts"),
        'import { a } from "../connection.js";\n',
      );
      writeFileSync(
        join(root, "deep", "er", "internal.ts"),
        'import "../../connection.js";\n',
      );
      expect(scanTree(root)).toEqual([]);
      // The same text leaves acp/ from one level up.
      writeFileSync(
        join(root, "side-effect.ts"),
        'import "../connection.js";\n',
      );
      writeFileSync(
        join(root, "deep", "er", "leak.ts"),
        'import "../../../host.js";\n',
      );
      expect(scanTree(root)).toEqual([
        { file: join("deep", "er", "leak.ts"), rules: [IMPORT_RULE] },
        { file: "side-effect.ts", rules: [IMPORT_RULE] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
