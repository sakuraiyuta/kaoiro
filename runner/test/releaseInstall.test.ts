// runner/deploy/kaoiro-runner-install.sh (issue #229): a release is
// installed as an immutable tree under releases/<id>, and installing one
// while the runner is up must not disturb what the running process resolves
// from disk.
//
// The premise these tests rest on was measured separately, not assumed: a
// runner started through `current` has its module paths realpath-resolved at
// startup, so a lazy `require.resolve` performed AFTER a `current` swap
// still lands inside the release it was started from (2026-08-16). That is
// what makes "prepare while running" safe, and also why replacing the files
// under a live release is refused below.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeReleaseTarball,
  revisionOf,
  runScript,
  treeDigest,
  writeReleaseTree,
} from "./releaseFixture.js";

const installScript = fileURLToPath(
  new URL("../deploy/kaoiro-runner-install.sh", import.meta.url),
);

describe("kaoiro-runner-install.sh (issue #229)", () => {
  let dir: string;
  let root: string;
  let work: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaoiro-release-install-"));
    root = join(dir, "install-root");
    work = join(dir, "work");
    mkdirSync(root, { recursive: true });
    mkdirSync(work, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const install = (archive: string, ...args: string[]) =>
    runScript(installScript, [archive, "--install-dir", root, ...args]);

  it("tarball を releases/<id> へ展開し、id を stdout に返す", () => {
    const revision = revisionOf("first");
    const archive = makeReleaseTarball(work, revision);

    const result = install(archive);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(revision);
    expect(existsSync(join(root, "releases", revision, "dist", "cli.js"))).toBe(
      true,
    );
    // The id comes from VERSION, and the archive's own name is not consulted.
    expect(readdirSync(join(root, "releases"))).toEqual([revision]);
  });

  it("受入条件: 稼働中 release の中身も current も一切変化しない", () => {
    const live = revisionOf("live");
    const liveTree = join(root, "releases", live);
    writeReleaseTree(liveTree, live);
    symlinkSync(`releases/${live}`, join(root, "current"));
    const before = treeDigest(liveTree);

    const next = revisionOf("next");
    expect(install(makeReleaseTarball(work, next)).status).toBe(0);

    expect(treeDigest(liveTree)).toBe(before);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${live}`);
  });

  it("受入条件: 不完全な tarball では release が一切作られない", () => {
    const revision = revisionOf("broken");
    const archive = makeReleaseTarball(work, revision, {
      omit: ["node_modules/@kaoiro/codex/dist/cli.js"],
    });

    const result = install(archive);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("node_modules/@kaoiro/codex/dist/cli.js");
    expect(existsSync(join(root, "releases", revision))).toBe(false);
    // Nothing half-extracted is left behind either: the staging dir and the
    // lock dir both go through the EXIT trap.
    expect(
      readdirSync(root).filter((e) => e.startsWith(".staging.")),
    ).toEqual([]);
  });

  it("clean な id の再インストールは冪等で、既存の中身を保つ", () => {
    const revision = revisionOf("idempotent");
    const archive = makeReleaseTarball(work, revision);
    expect(install(archive).status).toBe(0);

    // A marker that only survives if the second install leaves the tree
    // alone. Comparing digests would not distinguish "kept" from "replaced
    // with identical bytes"; this does.
    const marker = join(root, "releases", revision, "marker");
    writeFileSync(marker, "kept");

    const second = install(archive);

    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(revision);
    expect(existsSync(marker)).toBe(true);
  });

  it("自己整合な過小 manifest を、package graph の再導出で拒否する", () => {
    // もも review must-fix 2: removing a module AND its own manifest entry
    // leaves a manifest that describes the tree perfectly — hash and all —
    // while describing less than the release needs. A manifest cannot be its
    // own witness, so the strict path derives the closure a second time by
    // following the imports written inside each module. dist/cli.js still
    // says `import dep from "./stub_dep.js"` after stub_dep.js is gone, and
    // that dangling reference is what makes the removal detectable.
    const revision = revisionOf("undersized-manifest");
    const archive = makeReleaseTarball(work, revision, {
      omit: ["dist/stub_dep.js"],
      dropManifestEntries: ["dist/stub_dep.js"],
    });

    const result = install(archive);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("stub_dep.js");
    expect(existsSync(join(root, "releases", revision))).toBe(false);
  });

  it("回帰: コメント内の specifier を依存と誤認して健全な release を拒否しない", () => {
    // The closure walk follows the specifiers written inside each module, and
    // tsc preserves comments into dist/. A doc comment naming a since-renamed
    // sibling would otherwise become a mandatory module and reject a complete
    // tree at exit 70 — install AND switch both. Inventing a dependency is
    // strictly worse than missing one, so the parser must err the other way
    // (issue #229 レビューサイクル round 1).
    const revision = revisionOf("prose-specifier");
    const stage = join(work, "prose-stage");
    const name = `kaoiro-runner-${revision}-linux-x64`;
    const tree = join(stage, name);
    writeReleaseTree(tree, revision);
    const cli = join(tree, "dist", "cli.js");
    writeFileSync(
      cli,
      `// helper() used to be exported from "./legacy-helper.js" before #229.\n/* and a block comment mentioning require("./gone.js") too */\n${readFileSync(cli, "utf8")}`,
    );
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../../scripts/build-release-manifest.mjs", import.meta.url)),
      tree,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const archive = join(work, `${name}.tar.gz`);
    execFileSync("tar", ["czf", archive, "-C", stage, name]);

    const result = install(archive);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(revision);
  });

  it.each([
    ["コメント", '// used to come from "./gone-a.js"'],
    ["文字列リテラル", `const probe = 'import "./gone-b.js"';`],
    ["template literal", "const probe2 = `import \"./gone-c.js\"`;"],
  ])("回帰: %s 内の specifier で健全 release を拒否しない", (_label, line) => {
    // Three negative controls, one mechanism. Blanking comments alone left
    // the string and template forms rejecting a complete tree at exit 70 —
    // the same false positive one context over (もも review, issue #229).
    const revision = revisionOf(`non-code-${_label}`);
    const stage = join(work, `nc-${_label}`);
    const name = `kaoiro-runner-${revision}-linux-x64`;
    const tree = join(stage, name);
    writeReleaseTree(tree, revision);
    const cli = join(tree, "dist", "cli.js");
    writeFileSync(cli, `${line}\n${readFileSync(cli, "utf8")}`);
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../../scripts/build-release-manifest.mjs", import.meta.url)),
      tree,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const archive = join(work, `${name}.tar.gz`);
    execFileSync("tar", ["czf", archive, "-C", stage, name]);

    expect(install(archive).status).toBe(0);
  });

  it("回帰: 引用符を含む正規表現リテラルが後続の走査を壊さない", () => {
    // Without a regex branch the quote inside `/"/` opens a phantom string
    // and inverts code/literal parity for the REST of the file: real
    // specifiers vanish and literal text reaches the scan, which invented
    // `.concat(` and rejected a complete release. runner/dist/transport.js
    // already ships such a regex (レビューサイクル round 2).
    const revision = revisionOf("regex-literal");
    const stage = join(work, "re-stage");
    const name = `kaoiro-runner-${revision}-linux-x64`;
    const tree = join(stage, name);
    writeReleaseTree(tree, revision);
    const cli = join(tree, "dist", "cli.js");
    writeFileSync(
      cli,
      `const redact = (s) => s.replace(/(token=)[^&\\s"]+/gi, "$1<R>");\nconst tail = "prefix from ".concat("x");\n${readFileSync(cli, "utf8")}`,
    );
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../../scripts/build-release-manifest.mjs", import.meta.url)),
      tree,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const archive = join(work, `${name}.tar.gz`);
    execFileSync("tar", ["czf", archive, "-C", stage, name]);

    // Accepted (no invented specifier) AND stub_dep.js is still seen: the
    // require below the regex must not have been swallowed.
    expect(install(archive).status).toBe(0);
    const broken = makeReleaseTarball(work, revisionOf("regex-literal-neg"), {
      omit: ["dist/stub_dep.js"],
      dropManifestEntries: ["dist/stub_dep.js"],
    });
    expect(install(broken).status).toBe(70);
  });

  it("回帰: 除算と同じ行に置かれた specifier を見落とさない", () => {
    // The FOURTH instance of one defect, and the one that ended the approach
    // (もも division probe, issue #229). The hand-written lexer this scanner
    // replaced treated every `/` that was not `//` or `/*` as the start of a
    // regex literal and blanked to end of line, so a real specifier sharing
    // its line with a division simply vanished. That is a FALSE NEGATIVE —
    // the direction that lets an undersized manifest through — and it is why
    // the positive case alone proves nothing here: a release whose closure
    // came out too small installs at exit 0 looking perfectly healthy. The
    // negative control runs on the SAME staged shape, so it fails only if the
    // specifier below the division was actually seen.
    const cliPrelude =
      'const ratio = process.argv.length / 2;' +
      ' import extra from "./stub_extra.js";\n' +
      '// and a comment after a division: 1 / 2, from "./gone-div.js"\n';
    const extraFiles = {
      "dist/stub_extra.js": `export default { ratio: 1 };\n`,
    };

    const complete = makeReleaseTarball(work, revisionOf("division"), {
      cliPrelude,
      extraFiles,
    });
    // Accepted: the comment on the second line must NOT have become a
    // dependency, or a complete release is rejected at exit 70.
    expect(install(complete).status).toBe(0);

    const undersized = makeReleaseTarball(work, revisionOf("division-neg"), {
      cliPrelude,
      extraFiles,
      omit: ["dist/stub_extra.js"],
      dropManifestEntries: ["dist/stub_extra.js"],
    });

    const result = install(undersized);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("stub_extra.js");
  });

  it("回帰: sloppy mode でしか通らない CommonJS を壊れた JS と混同しない", () => {
    // vm.SourceTextModule always parses as an ES module, which is implicitly
    // strict, so ordinary CommonJS — an octal literal here — is a SyntaxError
    // there while being perfectly loadable JS. Treating that as "the file will
    // not parse" would reject a release that is entirely healthy, which is the
    // direction this verifier must never fail in (review round 1).
    const archive = makeReleaseTarball(work, revisionOf("sloppy-cjs"), {
      cliPrelude: 'import sloppy from "./stub_sloppy.js";\n',
      extraFiles: { "dist/stub_sloppy.js": "var mode = 0755;\nmodule.exports = { mode };\n" },
    });

    const result = install(archive);

    expect(result.status).toBe(0);
  });

  it("回帰: call の文字列形から module edge を推測しない", () => {
    // THREE HEALTHY RELEASES, ONE CLASS. A pattern match cannot resolve a
    // BINDING, so it read a method named `require` on an unrelated object, and
    // a module that defines its OWN `class URL` calling it with
    // `import.meta.url`, as real module edges — and rejected complete releases
    // at exit 70 (もも, issue #229; the URL case passes `node --check` and a
    // real `--version` run). The inference is gone: runtime edges are declared
    // now, so every line below is inert to the verifier.
    const archive = makeReleaseTarball(work, revisionOf("no-text-inference"), {
      cliPrelude:
        'const shim = { require: (p) => p, import: (p) => p };\n' +
        'shim.require("./gone-member.js");\n' +
        'shim.import("./gone-member-2.js");\n' +
        'class URL { constructor(p, b) { this.p = p; this.b = b; } }\n' +
        'const u = new URL("./not-a-module.js", import.meta.url);\n',
    });

    const result = install(archive);

    expect(result.status).toBe(0);
  });

  it("JS でない依存は素通しし、壊れた .js は拒否する", () => {
    // The closure walk now parses every file it reaches, which puts two
    // opposite mistakes one line apart. A resolved dependency that is not
    // JavaScript has no module edges of its own — a JSON import is
    // the case that occurs — so rejecting it would block a deploy over a file
    // that is exactly what it should be. A `.js` that will not parse is the
    // other way round: its edges cannot be derived, and passing over it
    // quietly is the fail-open this verifier exists to remove.
    const json = makeReleaseTarball(work, revisionOf("json-dep"), {
      cliPrelude: 'import conf from "./stub_conf.json" with { type: "json" };\n',
      extraFiles: { "dist/stub_conf.json": '{ "enabled": true }\n' },
    });
    expect(install(json).status).toBe(0);

    const broken = makeReleaseTarball(work, revisionOf("unparseable-dep"), {
      cliPrelude: 'import bad from "./stub_broken.js";\n',
      extraFiles: { "dist/stub_broken.js": "function ( {\n" },
    });

    const result = install(broken);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("stub_broken.js");
  });

  it.each([
    ["codex", "node_modules/@kaoiro/codex/dist/bridge.js"],
    ["claude-code", "node_modules/@kaoiro/claude-code/dist/probe.js"],
  ])("%s の宣言された runtime asset の欠落を拒否する", (_pkg, asset) => {
    // These files are reachable only at runtime, through a path the wrapper
    // composes itself. Removing one together with its manifest entry left a
    // self-consistent, undersized manifest that strict verify accepted at exit
    // 0 (もも review). The package DECLARES it in kaoiro.runtimeAssets and the
    // verifier enforces that declaration — no longer read out of call text.
    // BOTH packages are covered because a version of this suite that covered
    // only codex passed while claude-code's real probe.js sat undeclared.
    const revision = revisionOf(`runtime-asset-${_pkg}`);
    const archive = makeReleaseTarball(work, revision, {
      omit: [asset],
      dropManifestEntries: [asset],
    });

    const result = install(archive);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain(asset.split("/").pop() as string);
  });

  it("package.json を落として宣言ごと消す経路を拒否する", () => {
    // The builder's manifest covers dist/ only, so a package.json is NOT a
    // manifest entry — deleting one changes nothing the hash pass can see. If
    // a missing package.json meant "not a package", that one unhashed file
    // would silently disable every declaration it carried (review round 2).
    const revision = revisionOf("package-json-gone");
    const archive = makeReleaseTarball(work, revision, {
      omit: ["node_modules/@kaoiro/codex/package.json"],
    });

    const result = install(archive);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("package.json");
  });

  it.each([
    // Enough `..` to reach the filesystem root from anywhere the staging dir
    // sits, so the target really EXISTS and the containment check is what
    // rejects it — not a plain ENOENT one level short.
    ["release 外へ脱出する宣言", "../".repeat(24) + "etc/hostname", "outside the release"],
    ["絶対パスの宣言", "/etc/hostname", "absolute path"],
    ["通常ファイルでない宣言", "dist", "not a regular file"],
  ])("%s を拒否する", (_label, declared, expected) => {
    // A declaration travels inside the tree under inspection, so it is an
    // INPUT. Left unchecked it pulls an out-of-tree file into the closure —
    // where the walk reads it and a parse error puts part of its content on
    // stderr — or names a FIFO whose first read never returns while install
    // holds the lock (review round 2).
    const revision = revisionOf(`bad-declaration-${_label}`);
    const archive = makeReleaseTarball(work, revision, {
      extraFiles: {
        "node_modules/@kaoiro/codex/package.json": JSON.stringify({
          name: "@kaoiro/codex",
          version: "0.0.0",
          type: "module",
          dependencies: { "@kaoiro/wrapper-core": "workspace:*" },
          kaoiro: { runtimeAssets: [declared] },
        }),
      },
    });

    const result = install(archive);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain(expected);
  });

  it("回帰: main がディレクトリの package を index.js へ解決する", () => {
    // realpathSync succeeds on a DIRECTORY, so without an isFile() test the
    // bare candidate wins and a directory lands in the reachable set — where
    // the next readFileSync throws EISDIR and rejects a complete tree. The
    // index.js spelling would also be unreachable (issue #229 レビュー
    // サイクル round 1). A package whose `main` names a directory is the shape
    // that still reaches that code once specifiers come from the ES import
    // graph, which has no directory resolution of its own.
    const revision = revisionOf("directory-main");
    const archive = makeReleaseTarball(work, revision, {
      // The shared package a wrapper already imports, with its `main` pointed
      // at the DIRECTORY instead of the file inside it.
      extraFiles: {
        "node_modules/@kaoiro/wrapper-core/package.json": JSON.stringify({
          name: "@kaoiro/wrapper-core",
          version: "0.0.0",
          type: "module",
          main: "dist",
        }),
      },
    });

    const result = install(archive);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(revision);
  });

  it("release 内の artifact が tree 外への symlink なら拒否する", () => {
    // もも review must-fix 3: `-f` and realpath-less checks cannot tell a
    // file IN the release from a link pointing at an identical file
    // somewhere else, so the containment check has to be measured with a
    // link whose bytes match — otherwise a digest comparison alone would
    // explain the rejection.
    const revision = revisionOf("outside-symlink");
    const stage = join(work, "sym-stage");
    const name = `kaoiro-runner-${revision}-linux-x64`;
    const tree = join(stage, name);
    writeReleaseTree(tree, revision);
    const outside = join(dir, "outside-stub_dep.js");
    copyFileSync(join(tree, "dist", "stub_dep.js"), outside);
    rmSync(join(tree, "dist", "stub_dep.js"));
    symlinkSync(outside, join(tree, "dist", "stub_dep.js"));
    const archive = join(work, `${name}.tar.gz`);
    execFileSync("tar", ["czf", archive, "-C", stage, name]);

    const result = install(archive);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("outside the release");
    expect(existsSync(join(root, "releases", revision))).toBe(false);
  });

  it("既存 clean target が壊れていれば、no-op で済ませず拒否する", () => {
    // もも review must-fix 3: the one path that touches an ALREADY INSTALLED
    // release used to skip straight to exit 0. A release whose module had
    // been deleted was reported as "already installed" and left broken, and
    // the update that followed activated it.
    const revision = revisionOf("broken-existing");
    const archive = makeReleaseTarball(work, revision);
    expect(install(archive).status).toBe(0);
    rmSync(join(root, "releases", revision, "dist", "stub_dep.js"));

    const result = install(archive);

    expect(result.status).toBe(70);
    expect(result.stdout).not.toContain(revision);
    expect(result.stderr).not.toContain("already installed and verified");
  });

  it("clean な release は --allow-dirty を付けても置き換えられない", () => {
    // A clean id is content-addressed, so "replace it" has no meaning that
    // is not either a no-op or a lie. There is no flag for it at all, and
    // --allow-dirty must not become one by accident.
    const revision = revisionOf("immutable");
    const archive = makeReleaseTarball(work, revision);
    expect(install(archive).status).toBe(0);
    const marker = join(root, "releases", revision, "marker");
    writeFileSync(marker, "kept");

    const forced = install(archive, "--allow-dirty");

    expect(forced.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("dirty な id の再インストールは --allow-dirty を要求する", () => {
    const revision = revisionOf("dirty");
    const archive = makeReleaseTarball(work, revision, { dirty: true });
    expect(install(archive).status).toBe(0);

    const second = install(archive);

    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("--allow-dirty");
    expect(second.stderr).toContain("does not identify its content");

    // With the flag it goes through, because the operator has said out loud
    // that the id does not identify the content.
    expect(install(archive, "--allow-dirty").status).toBe(0);
  });

  it("--allow-dirty でも current / previous が指す release は置き換えない", () => {
    const revision = revisionOf("live-force");
    const archive = makeReleaseTarball(work, revision, { dirty: true });
    expect(install(archive).status).toBe(0);
    const id = `${revision}-dirty`;
    symlinkSync(`releases/${id}`, join(root, "current"));

    const forced = install(archive, "--allow-dirty");

    expect(forced.status).not.toBe(0);
    expect(forced.stderr).toContain("current points at it");
    expect(existsSync(join(root, "releases", id, "dist", "cli.js"))).toBe(true);
  });

  // The id becomes a path component, so its value domain is a security
  // boundary, not a formatting nicety. Each shape below is a DIFFERENT way
  // to reach it — a single well-formed case proves nothing about the others,
  // and the multi-line one is a defect that shipped past exactly that
  // mistake (a first version of this test covered only `../../pwned`).
  const REJECTED_VERSIONS: Array<[string, string]> = [
    ["単一行の traversal", "../../pwned"],
    // grep's ^/$ anchor per LINE and -q succeeds on ANY line, so a payload
    // line plus one well-formed line validated. `$(cat VERSION)` strips only
    // TRAILING newlines, so the embedded one survives into the id, and a
    // newline is not a path separator. Measured 2026-08-16: this wrote the
    // release tree two directories above the install root, exit 0.
    ["traversal 行 + 正当な hex 行", `../../pwned\n${"a".repeat(40)}`],
    ["正当な hex 行 + traversal 行", `${"a".repeat(40)}\n../../pwned`],
    ["先頭が改行", `\n${"a".repeat(40)}`],
    ["絶対パス", "/etc/kaoiro-pwned"],
    ["hex が 41 桁", "a".repeat(41)],
    ["大文字 hex", "A".repeat(40)],
  ];

  it.each(REJECTED_VERSIONS)(
    "VERSION が id の値域を外れていれば install しない: %s",
    (_label, version) => {
      const archive = makeReleaseTarball(work, revisionOf("traversal"), {
        version,
      });

      const result = install(archive);

      expect(result.status).not.toBe(0);
      // The rejection now comes from the identity check, which fires BEFORE
      // the id ever reaches the filesystem: a VERSION outside the domain can
      // never equal the tree's own build-info identity. The id value-domain
      // guard itself is consequently unreachable through install — a
      // strengthening, not a gap — and is exercised directly through
      // kaoiro-runner-switch.sh's argument instead (releaseSwitch.test.ts).
      expect(result.stderr).toContain("disagrees with dist/build-info.json");
      // Nothing anywhere under the fixture root, not merely nothing under
      // releases/ — the whole point of a traversal is that it lands
      // elsewhere.
      expect(readdirSync(dir).sort()).toEqual(["install-root", "work"]);
      expect(readdirSync(join(root, "releases"))).toEqual([]);
    },
  );

  it("release ディレクトリに install 時刻を刻む (build 時刻のままにしない)", () => {
    // tar restores the mtime the BUILD host recorded, and rename(2) does not
    // update a directory's own mtime, so without an explicit stamp a release
    // installed today can look older than one installed last week. Retention
    // in kaoiro-runner-update.sh orders by exactly this.
    const revision = revisionOf("mtime");
    const built = Math.floor(Date.now() / 1000) - 86_400 * 30;
    const archive = makeReleaseTarball(work, revision, { treeMtime: built });
    const before = Date.now();

    expect(install(archive).status).toBe(0);

    const stamped = statSync(join(root, "releases", revision)).mtimeMs;
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
  });

  it("同時実行は lock で直列化され、二本目は EX_TEMPFAIL で止まる", () => {
    mkdirSync(join(root, ".lock.install"));
    const archive = makeReleaseTarball(work, revisionOf("locked"));

    const result = install(archive);

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("another run holds");
  });

  it("SIGKILL で取り残された自分の staging だけを、lock 下で GC する", () => {
    // A run killed before its EXIT trap leaves ~1.2 GB behind under a name
    // carrying a dead pid, and nothing ever revisits it. Holding the lock is
    // what makes "still here" mean "abandoned" — but ONLY for this script's
    // own dirs, since the lock excludes other installs and nothing else.
    const mine = join(root, ".staging.install.99999");
    mkdirSync(join(mine, "half-extracted"), { recursive: true });
    // An update's build dir under the same root. update.sh holds a
    // DIFFERENT lock and invokes this script, so this may well be LIVE:
    // deleting it took the tarball being installed with it and broke every
    // --from-repo update (exit 2, `tar: Cannot open`). An earlier version of
    // this test asserted the deletion, encoding the defect instead of
    // catching it.
    const notMine = join(root, ".staging.build.99998");
    mkdirSync(notMine, { recursive: true });

    const result = install(makeReleaseTarball(work, revisionOf("gc")));

    expect(result.status).toBe(0);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(notMine)).toBe(true);
    expect(result.stderr).toContain("abandoned staging dir");
  });

  it("GC は lock ディレクトリを巻き添えにしない", () => {
    // `.lock.` and `.staging.` are disjoint prefixes on purpose: an earlier
    // draft used `.install.lock` and `.install.<pid>`, where a glob wide
    // enough to catch the leftovers also caught the live lock.
    mkdirSync(join(root, ".staging.install.99999"), { recursive: true });
    const archive = makeReleaseTarball(work, revisionOf("gc-lock"));

    expect(install(archive).status).toBe(0);

    // A second run still finds a free lock, which it would not if the first
    // run had deleted its own lock mid-flight and left it dangling.
    mkdirSync(join(root, ".lock.install"));
    expect(install(archive).status).toBe(75);
  });

  // NOT pinned here, and deliberately so: that the hand-authored fixture
  // matches the layout scripts/build-runner-tarball.sh really produces. A
  // test built from the same fixture cannot establish that — it would
  // measure the fixture. It was measured directly instead, by extracting a
  // real linux-x64 archive on 2026-08-16: VERSION held the bare 40-hex SHA,
  // dist/cli.js and dist/build-info.json were present,
  // node_modules/@kaoiro/{claude-code,codex} were SYMLINKS into
  // node_modules/.pnpm/ whose dist/cli.js resolved through `-f`, and the
  // real shim answered `--version` from the extracted tree. Re-measure that
  // when the builder's layout changes; nothing here will catch it.
});
