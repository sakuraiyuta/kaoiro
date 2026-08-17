// runner/deploy/kaoiro-runner-switch.sh (issue #229): moving `current`
// between installed releases, and back again.
//
// The acceptance criterion these serve is "if the switch fails, the previous
// release can be restarted". That splits into two properties, both pinned
// below: a failed switch must leave `current` exactly where it was, and a
// completed switch must leave the release it replaced reachable as
// `previous`.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revisionOf, runScript, writeReleaseTree } from "./releaseFixture.js";

const switchScript = fileURLToPath(
  new URL("../deploy/kaoiro-runner-switch.sh", import.meta.url),
);

describe("kaoiro-runner-switch.sh (issue #229)", () => {
  let root: string;
  const A = revisionOf("release-a");
  const B = revisionOf("release-b");

  const seed = (revision: string, omit?: string[]): void => {
    writeReleaseTree(
      join(root, "releases", revision),
      revision,
      omit === undefined ? {} : { omit },
    );
  };

  const run = (...args: string[]) =>
    runScript(switchScript, [...args, "--install-dir", root]);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kaoiro-release-switch-"));
    mkdirSync(join(root, "releases"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("current を切り替え、旧 release を previous に残す", () => {
    seed(A);
    seed(B);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const result = run(B);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(B);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(readlinkSync(join(root, "previous"))).toBe(`releases/${A}`);
  });

  it("回帰: current/deploy 越しに起動しても verifier が働く", () => {
    // A manual switch or rollback is run from the path the host advertises,
    // <install-root>/current/deploy/ — and reaching verify-release.mjs
    // through that symlink used to skip it altogether: node resolves an ESM
    // module's own URL through realpath while leaving process.argv[1] as
    // typed, so the verifier's entry-point guard was false, main() never ran,
    // and it exited 0 having printed nothing. The identity read back from
    // that stdout was the empty string, so this script then refused a release
    // that was in perfect shape — "carries identity " (measured against a
    // real tarball install, 2026-08-16). Every other case here invokes the
    // script by its physical path, where the guard happens to hold.
    seed(A);
    seed(B);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const result = runScript(
      join(root, "current", "deploy", "kaoiro-runner-switch.sh"),
      [B, "--install-dir", root],
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(B);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });

  it("回帰: 切替が旧 release の中に一時 symlink を残さない", () => {
    // `mv <tmplink> current` FOLLOWS `current` when it points at a directory
    // and moves the new link INSIDE the old release — measured on GNU
    // coreutils 9.4, where `current` silently kept pointing at the old
    // release and a stray link appeared under it. rename(2) is what avoids
    // this; this test is the regression pin for anyone tempted to simplify
    // kaoiro_symlink_swap back to `mv`.
    seed(A);
    seed(B);
    symlinkSync(`releases/${A}`, join(root, "current"));

    expect(run(B).status).toBe(0);

    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(
      readdirSync(join(root, "releases", A)).filter((e) => e.includes(".tmp.")),
    ).toEqual([]);
    expect(readdirSync(root).filter((e) => e.includes(".tmp."))).toEqual([]);
  });

  it("存在しない release への切替は current を変えない", () => {
    seed(A);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const result = run(revisionOf("never-installed"));

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("no such release");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(root, "previous"))).toBe(false);
  });

  it("不完全な release への切替は拒否し、current を変えない", () => {
    seed(A);
    seed(B, ["node_modules/@kaoiro/claude-code/dist/cli.js"]);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const result = run(B);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("failed verification");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });

  it("値域外の release id は path として使われる前に弾かれる", () => {
    seed(A);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const result = run("../../etc");

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("unusable release id");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });

  it("--rollback で previous へ戻り、current と previous が入れ替わる", () => {
    seed(A);
    seed(B);
    symlinkSync(`releases/${A}`, join(root, "current"));
    expect(run(B).status).toBe(0);

    const result = run("--rollback");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(A);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    // Swapped rather than dropped, so an accidental rollback is itself
    // reversible.
    expect(readlinkSync(join(root, "previous"))).toBe(`releases/${B}`);
  });

  it("previous が無ければ rollback は失敗し、current を変えない", () => {
    seed(A);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const result = run("--rollback");

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("no previous release");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });

  it("previous の指す release が消えていれば rollback は失敗する", () => {
    seed(A);
    seed(B);
    symlinkSync(`releases/${A}`, join(root, "current"));
    expect(run(B).status).toBe(0);
    rmSync(join(root, "releases", A), { recursive: true, force: true });

    const result = run("--rollback");

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("previous release is gone");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
  });

  describe("activation は clean な 40-hex id に限る", () => {
    // `current` is the name that decides what the host runs, so it has to
    // resolve to a commit. `-dirty` says the SHA does not describe the tree
    // (ADR-0053) and `unknown` names no commit at all — activating either
    // reintroduces, one level up, the very "what is actually running?"
    // question this layout exists to answer.
    const DIRTY = `${revisionOf("dirty-release")}-dirty`;

    it("dirty な id の activation は既定で拒否する", () => {
      seed(A);
      writeReleaseTree(join(root, "releases", DIRTY), revisionOf("dirty-release"), {
        dirty: true,
      });
      symlinkSync(`releases/${A}`, join(root, "current"));

      const result = run(DIRTY);

      expect(result.status).toBe(78);
      expect(result.stderr).toContain("only a clean 40-hex revision");
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    });

    it("--allow-dirty を明示すれば dev ホストでは通る", () => {
      seed(A);
      writeReleaseTree(join(root, "releases", DIRTY), revisionOf("dirty-release"), {
        dirty: true,
      });
      symlinkSync(`releases/${A}`, join(root, "current"));

      const result = run(DIRTY, "--allow-dirty");

      expect(result.status).toBe(0);
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${DIRTY}`);
    });

    it("unknown の activation も既定で拒否する", () => {
      seed(A);
      writeReleaseTree(join(root, "releases", "unknown"), revisionOf("u"), {
        version: "unknown",
      });
      symlinkSync(`releases/${A}`, join(root, "current"));

      const result = run("unknown");

      expect(result.status).toBe(78);
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    });

    it("rollback には gate をかけない (previous は一度 activate 済み)", () => {
      // Refusing to restore a release that was already live would strand a
      // host on a broken one for a reason that has stopped applying.
      writeReleaseTree(join(root, "releases", DIRTY), revisionOf("dirty-release"), {
        dirty: true,
      });
      seed(B);
      symlinkSync(`releases/${DIRTY}`, join(root, "current"));
      expect(run(B).status).toBe(0);

      const result = run("--rollback");

      expect(result.status).toBe(0);
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${DIRTY}`);
    });
  });

  it("同じ release への切替は no-op で previous を作らない", () => {
    seed(A);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const result = run(A);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(A);
    expect(existsSync(join(root, "previous"))).toBe(false);
  });

  it(".lock.links (issue #253) が他所で保持されていれば switch は current を変えない", () => {
    // The SAME lock kaoiro-runner-install.sh takes around its own
    // current/previous check-then-delete, and kaoiro-runner-update.sh
    // around its own prune loop. Pre-holding it here stands in for either
    // one being mid-flight; a switch landing on top of it is exactly the
    // race issue #253 closes.
    seed(A);
    seed(B);
    symlinkSync(`releases/${A}`, join(root, "current"));
    mkdirSync(join(root, ".lock.links"));

    const result = run(B);

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("another run holds");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    expect(existsSync(join(root, "previous"))).toBe(false);
  });

  it(".lock.links が他所で保持されていれば --rollback も current/previous を変えない", () => {
    seed(A);
    seed(B);
    symlinkSync(`releases/${A}`, join(root, "current"));
    expect(run(B).status).toBe(0);

    mkdirSync(join(root, ".lock.links"));
    const result = run("--rollback");

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("another run holds");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(readlinkSync(join(root, "previous"))).toBe(`releases/${A}`);
  });

  it("verify と .lock.links の間で target が消えても current は dangling にならない (issue #253 round2、もも review must-fix)", () => {
    // もも round1 review: switch_to() は当初、target の verify を
    // .lock.links 取得より前に行っていた。verify は release の中身だけを
    // 読む read-only 操作なので lock は要らない、という判断だったが、
    // kaoiro-runner-install.sh の --allow-dirty 置き換え経路は SAME
    // target を .lock.links の下で check-then-delete する。verify が
    // lock の外にある限り、その verify が成功した直後・.lock.links を
    // 取る前の一瞬に install の delete が割り込めば、switch は既に
    // 削除された target をそのまま current へ書き込んでしまう —
    // ももが実 concurrency で再現し、exit 0 かつ current が dangling
    // symlink になることを確認した。
    //
    // ここでは real concurrency ではなく、mkdir を PATH 上でシムして
    // 決定論的に再現する: kaoiro_lock_acquire が呼ぶ `mkdir .lock.links`
    // そのものを捕まえ、実際の mkdir を実行する直前に target を
    // rm -rf する — install の delete が「switch が .lock.links を
    // 取ろうとした、まさにその瞬間」に割り込んだ場合を模している。
    // 修正後は lock 取得が verify より前に来るため、この rm -rf は
    // switch 自身の (今度は lock 保護下の) 存在チェック/verify を
    // 直撃し、current は書き換わらずに済むはずである。
    seed(A);
    const X = revisionOf("switch-toctou-target");
    seed(X);
    symlinkSync(`releases/${A}`, join(root, "current"));

    const targetPath = join(root, "releases", X);
    const linksLock = join(root, ".lock.links");
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeMkdir = join(fakeBin, "mkdir");
    // Resolved from the REAL PATH, before fake-bin is prepended below --
    // a hardcoded /usr/bin/mkdir works on this Linux box and on ubuntu-latest
    // CI (whose /bin is a symlink into /usr/bin), but the project targets
    // macOS too (kaoiro-runner-common.sh branches on `uname -s = Darwin`),
    // where core utilities live only under /bin. The shim falls through to
    // the real mkdir for every OTHER call, so a wrong path here breaks this
    // test everywhere, not just for the one call it means to intercept.
    const realMkdir = execFileSync("/bin/sh", ["-c", "command -v mkdir"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      fakeMkdir,
      [
        "#!/bin/sh",
        `if [ "$#" -eq 1 ] && [ "$1" = ${JSON.stringify(linksLock)} ]; then`,
        `  rm -rf ${JSON.stringify(targetPath)}`,
        "fi",
        `exec ${JSON.stringify(realMkdir)} "$@"`,
      ].join("\n"),
    );
    chmodSync(fakeMkdir, 0o755);

    const result = runScript(switchScript, [X, "--install-dir", root], {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    // The target is genuinely gone by the time switch's own (now
    // lock-protected) checks run, so this must fail cleanly -- not
    // silently activate a name that resolves to nothing.
    expect(result.status).not.toBe(0);
    expect(existsSync(targetPath)).toBe(false);
    expect(lstatSync(join(root, "current")).isSymbolicLink()).toBe(true);
    // The load-bearing assertion: current must still RESOLVE (not be a
    // dangling symlink at the deleted target). existsSync follows
    // symlinks, so this fails exactly the way the pre-fix code did if the
    // regression comes back.
    expect(existsSync(join(root, "current"))).toBe(true);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });
});
