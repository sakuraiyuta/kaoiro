// runner/deploy/kaoiro-runner-switch.sh (issue #229): moving `current`
// between installed releases, and back again.
//
// The acceptance criterion these serve is "if the switch fails, the previous
// release can be restarted". That splits into two properties, both pinned
// below: a failed switch must leave `current` exactly where it was, and a
// completed switch must leave the release it replaced reachable as
// `previous`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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
});
