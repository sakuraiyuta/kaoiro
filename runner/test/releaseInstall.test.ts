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
import {
  existsSync,
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
      expect(result.stderr).toContain("unusable release id");
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
