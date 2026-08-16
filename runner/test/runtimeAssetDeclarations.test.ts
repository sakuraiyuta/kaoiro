// Keeps `kaoiro.runtimeAssets` honest (issue #229, director 裁定 2026-08-16).
//
// verify-release.mjs no longer reads runtime module edges out of the text of a
// call. It cannot: a pattern match resolves no BINDING, so `foo.require(...)`
// and a module-local `class URL {}` both read as real edges and rejected three
// healthy releases. Runtime edges are DECLARED by the package instead — which
// moves the failure mode from "wrongly rejects a release" to "silently forgets
// a declaration".
//
// THIS TEST IS THAT FORGETTING'S ALARM, AND IT IS DELIBERATELY THE SAME
// TEXTUAL HEURISTIC THE VERIFIER GAVE UP. The difference is where it runs: a
// false positive here costs one red test and a human's judgement, while the
// same false positive inside the verifier blocks every deploy of an entirely
// healthy release. Guessing is fine when a person reads the guess.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Every first-party package. A new one belongs here the day it is created —
 *  that is cheaper than the alternative, which is finding out from a release. */
const PACKAGES = [
  "runner",
  "protocol",
  "wrapper/agent-common",
  "wrapper/claude-code",
  "wrapper/codex",
  "wrapper/core",
];

/** Ways a module reaches a file that no static `import` names, so the closure
 *  walk cannot see it. Group 2 is the specifier.
 *
 *  `<binding>.resolve(...)` IS ON THIS LIST BECAUSE LEAVING IT OFF HID A REAL
 *  ONE. `wrapper/claude-code/src/probe-client.ts` reaches dist/probe.js
 *  through `createRequire(import.meta.url).resolve("./probe.js")`, whose call
 *  text contains no `require(` at all — so a scan for the three obvious
 *  shapes reported "exactly one runtime reference in the whole codebase" and
 *  was believed. Deleting probe.js with its manifest entry then passed strict
 *  verification at exit 0 on the real release (measured 2026-08-16). The
 *  binding names come from the file's own `createRequire` calls rather than a
 *  guessed identifier, so `path.resolve("./x")` — which is not a module
 *  reference — stays out. */
const RUNTIME_REFERENCE_RES = [
  /new\s+URL\(\s*(['"`])((?:(?!\$\{)[^'"`\n])+)\1\s*,\s*import\.meta\.url\s*\)/g,
  /(?<![.\w])import\(\s*(['"`])(\.(?:(?!\$\{)[^'"`\n])*)\1\s*\)/g,
  /(?<![.\w])require\(\s*(['"`])(\.(?:(?!\$\{)[^'"`\n])*)\1\s*\)/g,
];

/** The same call shapes with a SUBSTITUTED template literal as the argument.
 *  Their target cannot be computed from the text at all, so they are reported
 *  as needing a hand-written declaration rather than skipped — skipping is the
 *  omission this file exists to catch. */
const UNRESOLVABLE_RES = [
  /new\s+URL\(\s*`[^`\n]*\$\{/g,
  /(?<![.\w])(?:import|require)\(\s*`[^`\n]*\$\{/g,
  /(?<![.\w])[A-Za-z_$][\w$]*\s*\.\s*resolve\(\s*`[^`\n]*\$\{/g,
];

/** `createRequire(...)` bindings declared in `source`, plus the CommonJS
 *  `require` that needs no declaration. */
function requireBindings(source: string): string[] {
  const names = ["require"];
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g;
  for (const match of source.matchAll(re)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** `<binding>.resolve("<relative>")` for each binding, as a specifier regex. */
function resolveRes(source: string): RegExp[] {
  return requireBindings(source).map(
    (name) =>
      new RegExp(
        `(?<![.\\w])${name}\\s*\\.\\s*resolve\\(\\s*(['"\`])(\\.(?:(?!\\$\\{)[^'"\`\\n])*)\\1\\s*\\)`,
        "g",
      ),
  );
}

/** Where a source-tree path ends up once built. The declarations name the
 *  SHIPPED file, and a reference such as `"./probe.js"` written in `src/`
 *  resolves to `src/probe.js` — the same file one build later. */
function asShipped(target: string): string {
  return target.startsWith(`src${sep}`)
    ? `dist/${target.slice(4).replace(/\.ts$/, ".js")}`
    : target.split(sep).join("/");
}

interface Reference {
  file: string;
  specifier: string;
  /** Package-relative path of the file being referenced. */
  target: string;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.[cm]?[tj]s$/.test(entry.name)) out.push(path);
  }
  return out;
}

function referencesIn(pkgDir: string): Reference[] {
  const found: Reference[] = [];
  for (const file of sourceFiles(join(pkgDir, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const re of [...RUNTIME_REFERENCE_RES, ...resolveRes(source)]) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        const specifier = match[2];
        if (specifier === undefined) continue;
        found.push({
          file: relative(repoRoot, file),
          specifier,
          target: asShipped(relative(pkgDir, resolve(dirname(file), specifier))),
        });
      }
    }
  }
  return found;
}

/** Call sites whose target cannot be computed from the text, together with
 *  why each is covered anyway. THE COUNT IS PART OF THE CLAIM: a new
 *  unresolvable call in an exempted file breaks this test instead of
 *  inheriting the exemption. An entry here is an assertion a reader can
 *  check, not a mute button. */
const UNRESOLVABLE_EXCEPTIONS: Record<string, { count: number; why: string }> = {
  "runner/src/spawn.ts": {
    count: 2,
    why:
      "resolveWrapperLaunch resolves `${pkg}/dist/cli.js`, and on the " +
      "KAOIRO_WRAPPER_DEV path `${pkg}/package.json`. Both are already " +
      "enforced without a declaration: ENTRY_PACKAGES in verify-release.mjs " +
      "seeds each wrapper's dist/cli.js as a closure ENTRY POINT, and a " +
      "package.json that cannot be read fails the release outright.",
  },
};

/** RAW detector output: call sites whose argument is a substituted template
 *  literal, per file, with no exemption applied.
 *
 *  SEPARATE FROM THE FILTER ON PURPOSE. Applying exemptions inside the scan
 *  made the detector unobservable: emptying UNRESOLVABLE_RES produced zero
 *  hits, every exemption was then vacuously satisfied, and the whole suite
 *  stayed green (もも, final review). A detector that stops working has to be
 *  visible to a test on its own output. */
function unresolvableByFile(pkgDir: string): Map<string, string[]> {
  const perFile = new Map<string, string[]>();
  for (const file of sourceFiles(join(pkgDir, "src"))) {
    const source = readFileSync(file, "utf8");
    const rel = relative(repoRoot, file).split(sep).join("/");
    for (const re of UNRESOLVABLE_RES) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        const hits = perFile.get(rel) ?? [];
        hits.push(`${rel}: ${match[0].trim()}`);
        perFile.set(rel, hits);
      }
    }
  }
  return perFile;
}

/** The detector's output minus the exempted files, whose counts still match. */
function unresolvableIn(pkgDir: string): string[] {
  const found: string[] = [];
  for (const [rel, hits] of unresolvableByFile(pkgDir)) {
    const exception = UNRESOLVABLE_EXCEPTIONS[rel];
    if (exception !== undefined && exception.count === hits.length) continue;
    found.push(...hits);
  }
  return found;
}

function declarationsOf(pkgDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    kaoiro?: { runtimeAssets?: string[] };
  };
  return pkg.kaoiro?.runtimeAssets ?? [];
}

describe("kaoiro.runtimeAssets (issue #229)", () => {
  it.each(PACKAGES)("%s: 実行時参照がすべて宣言されている", (pkg) => {
    const pkgDir = join(repoRoot, pkg);
    const declared = declarationsOf(pkgDir);

    const undeclared = referencesIn(pkgDir).filter(
      (ref) => !declared.includes(ref.target),
    );

    // The message carries the fix, because the person reading it is the one
    // who just added the reference.
    expect(
      undeclared.map((r) => `${r.file}: ${r.specifier} -> ${r.target}`),
    ).toEqual([]);
  });

  it.each(PACKAGES)("%s: 自動判定できない実行時参照が無い", (pkg) => {
    // A `${...}` template argument has no target this scan can compute. Such a
    // reference is not automatically wrong — it just cannot be checked here,
    // so it must be resolved by hand: give the call a plain literal, or add
    // the declaration and add the call site to an explicit exception.
    expect(unresolvableIn(join(repoRoot, pkg))).toEqual([]);
  });

  it.each(PACKAGES)("%s: 例外の件数が実測と一致する (回帰)", (pkg) => {
    // A COUNT IS ONLY A CLAIM IF SOMETHING CHECKS IT. The filter above DROPS
    // the hits an exemption matches, so with the detector emptied every
    // exemption became vacuously true and the suite stayed green — the same
    // shape as the scanner assertions above, one layer over (もも, final
    // review). This reads the RAW detector output, so an exemption that
    // claims two call sites fails unless two are actually seen.
    const observed = unresolvableByFile(join(repoRoot, pkg));
    const wrong: string[] = [];
    for (const [rel, exception] of Object.entries(UNRESOLVABLE_EXCEPTIONS)) {
      if (!rel.startsWith(`${pkg}/`)) continue;
      const hits = observed.get(rel)?.length ?? 0;
      if (hits !== exception.count) {
        wrong.push(`${rel}: 例外は ${exception.count} 件、走査は ${hits} 件`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it.each(PACKAGES)("%s: 宣言された資産に対応する source がある", (pkg) => {
    const pkgDir = join(repoRoot, pkg);

    // A declaration naming nothing is worse than none: the verifier would
    // reject every release for a file no build ever produces. dist/<x>.js is
    // built from src/<x>.ts, so the source is what exists before a build.
    const orphans = declarationsOf(pkgDir).filter(
      (rel) =>
        !existsSync(join(pkgDir, rel)) &&
        !existsSync(join(pkgDir, rel.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"))),
    );

    expect(orphans).toEqual([]);
  });

  it.each([
    ["wrapper/codex", "../dist/bridge.js", "dist/bridge.js"],
    ["wrapper/claude-code", "./probe.js", "dist/probe.js"],
  ])("%s: 走査が %s を実際に見つける (回帰)", (pkg, specifier, target) => {
    // PINS THE DETECTION PATH, NOT THE DECLARATION. Deleting a declaration
    // turns the tests around this one red, so it is easy to believe the alarm
    // is pinned — it is not. Blanking `requireBindings()` to `return []`,
    // which is EXACTLY the failure that let dist/probe.js sit undeclared,
    // left all 20 tests green (もも, final review). A scanner that quietly
    // stops seeing a shape has to fail here, on its own output.
    expect(referencesIn(join(repoRoot, pkg))).toContainEqual(
      expect.objectContaining({ specifier, target }),
    );
  });

  it.each([
    ["wrapper/codex", "dist/bridge.js"],
    ["wrapper/claude-code", "dist/probe.js"],
  ])("%s は %s を宣言している (回帰)", (pkg, asset) => {
    // The real instances, named explicitly so deleting a declaration fails
    // here and not only inside a release. codex reaches bridge.js through
    // `new URL("../dist/bridge.js", import.meta.url)`; claude-code reaches
    // probe.js through `createRequire(import.meta.url).resolve("./probe.js")`
    // — the second one was MISSED by the first version of this test, and the
    // release verifier accepted its deletion at exit 0 as a result.
    expect(declarationsOf(join(repoRoot, pkg))).toContain(asset);
  });
});
