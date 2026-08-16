// runner/deploy/kaoiro-runner-update.sh (issue #229).
//
// WHAT IS AND IS NOT MEASURED HERE. The acceptance criterion is "stopping
// the caller's runner does not stop the update", and the mechanism that
// delivers it is CGROUP separation, not process-group separation.
// systemd.kill(5) defaults to KillMode=control-group — "all remaining
// processes in the control group of this unit will be killed on unit stop" —
// so a process that merely left the caller's process group while staying in
// the runner service's cgroup still dies with it. What escapes is being a
// transient SERVICE unit: systemd-run(1) says such a command "will run in a
// clean and detached execution environment, with the service manager as its
// parent process".
//
// So the evidence splits three ways:
//
//   1. PRIMARY, pinned here: the argv handed to systemd-run is the one that
//      produces such a unit — --user, --no-block, a fixed --unit, and
//      crucially NO --scope (a scope inherits the caller's execution
//      environment and runs synchronously), no PartOf, no --collect. If the
//      invocation is wrong, systemd's guarantee never applies in the first
//      place.
//   2. PRIMARY, pinned here: our worker's own ordering and failure
//      behaviour — nothing stops before the release is prepared, the switch
//      lands between stop and start, and a refusal that is decidable early
//      happens before the stop.
//   3. NOT pinned here: that systemd actually puts such a unit in its own
//      cgroup, independent of the caller. Measuring that needs the host's
//      real user systemd instance — which supervises the very runner an
//      agent running this suite lives under. It is an operator step with a
//      disposable caller unit, written up in docs/specs/deployment.md 4.6.4.
//
// The process-group survival test below is AUXILIARY. It shows the worker
// completes after its caller is killed, which is necessary but not
// sufficient: it says nothing about cgroups. It is kept because it would
// catch a worker that died of a broken pipe or an inherited signal
// disposition, not because it establishes self-stop safety.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
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
  writeReleaseTree,
} from "./releaseFixture.js";

const updateScript = fileURLToPath(
  new URL("../deploy/kaoiro-runner-update.sh", import.meta.url),
);

const SERVICE = "kaoiro-runner";
const UPDATE_UNIT = "kaoiro-runner-update";

interface SystemctlStubOptions {
  /** What `systemctl show -p ExecStart --value <service>` reports. */
  execStart: string;
  /** Shell fragment run when the stub is called with `stop`. */
  onStop?: string;
}

describe("kaoiro-runner-update.sh (issue #229)", () => {
  let dir: string;
  let root: string;
  let work: string;
  let bin: string;
  let calls: string;
  const A = revisionOf("update-a");
  const B = revisionOf("update-b");

  const readCalls = (): string[] =>
    existsSync(calls)
      ? readFileSync(calls, "utf8").split("\n").filter((l) => l !== "")
      : [];

  const writeStub = (name: string, body: string): string => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const systemctlStub = (options: SystemctlStubOptions): string =>
    writeStub(
      "systemctl-stub",
      [
        // Each call records what `current` pointed at WHEN it was made, so
        // the ordering of stop / switch / start is observable from one log
        // instead of inferred from the order two separate signals happened
        // to land in.
        `printf '%s :: %s\\n' "$*" "$(readlink ${JSON.stringify(join(root, "current"))} 2>/dev/null || echo none)" >> ${JSON.stringify(calls)}`,
        `case "$*" in`,
        `  *"show -p ExecStart"*)`,
        `    printf '{ path=%s ; argv[]=%s ; ignore_errors=no }\\n' ${JSON.stringify(options.execStart)} ${JSON.stringify(options.execStart)}`,
        `    ;;`,
        `  *" stop "*)`,
        `    ${options.onStop ?? ":"}`,
        `    ;;`,
        `esac`,
        `exit 0`,
      ].join("\n"),
    );

  /** Records systemd-run's argv, one element per line, and does not run
   *  anything. */
  const recordingSystemdRun = (log: string): string =>
    writeStub(
      "systemd-run-record",
      [
        `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(log)}; done`,
        `exit 0`,
      ].join("\n"),
    );

  const seedRelease = (revision: string): void => {
    writeReleaseTree(join(root, "releases", revision), revision);
  };

  const runUpdate = (
    args: string[],
    env: Record<string, string | undefined>,
  ) => runScript(updateScript, ["--install-dir", root, "--service", SERVICE, ...args], env);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaoiro-release-update-"));
    root = join(dir, "install-root");
    work = join(dir, "work");
    bin = join(dir, "bin");
    calls = join(dir, "systemctl-calls");
    mkdirSync(join(root, "releases"), { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(bin, { recursive: true });
    seedRelease(A);
    symlinkSync(`releases/${A}`, join(root, "current"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const goodExecStart = () => `${root}/current/deploy/kaoiro-runner-launch.sh`;

  describe("--detach の systemd-run 起動契約", () => {
    it("caller から独立させる引数で queue し、自分では作業しない", () => {
      const log = join(dir, "systemd-run-argv");
      const archive = makeReleaseTarball(work, B);

      const result = runUpdate(["--tarball", archive, "--detach"], {
        KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
        KAOIRO_SYSTEMD_RUN: recordingSystemdRun(log),
      });

      expect(result.status).toBe(0);
      const argv = readFileSync(log, "utf8").split("\n").filter((l) => l !== "");

      // Runs against the USER manager (the runner is a user unit, ADR-0023)
      // and returns as soon as the job is queued — the two properties the
      // caller's survival depends on.
      expect(argv).toContain("--user");
      expect(argv).toContain("--no-block");
      // A fixed unit name, so `systemctl --user status` has somewhere to
      // look: a detached run cannot report back, and the journal is the only
      // record of what happened.
      expect(argv).toContain(`--unit=${UPDATE_UNIT}`);

      // THE CGROUP IS WHAT MATTERS, NOT THE PROCESS GROUP. systemd.kill(5)
      // defaults to KillMode=control-group — "all remaining processes in the
      // control group of this unit will be killed on unit stop" — so leaving
      // the caller's process group buys nothing on its own. What buys
      // independence is being a transient SERVICE unit, which systemd-run(1)
      // says "will run in a clean and detached execution environment, with
      // the service manager as its parent process". Hence:
      //
      // --scope must be ABSENT. A transient scope is run by systemd-run
      // itself, "will thus inherit the execution environment of the caller",
      // and is synchronous — it would put the update straight back inside
      // the unit that is about to be stopped, and could not combine with
      // --no-block at all.
      expect(argv).not.toContain("--scope");
      // Nothing may tie the transient unit's lifetime to the runner service.
      // PartOf would propagate the runner's stop into the updater by a
      // different route.
      expect(argv.filter((a) => a.includes("PartOf"))).toEqual([]);
      expect(argv.filter((a) => a.includes("BindsTo"))).toEqual([]);
      // --collect would garbage-collect the finished unit and take the
      // result with it — and the journal of that unit is the ONLY place a
      // detached run's outcome appears.
      expect(argv).not.toContain("--collect");

      // The environment is forwarded explicitly (a transient unit inherits
      // the user manager's, not this shell's), and no secret rides along.
      expect(argv.some((a) => a.startsWith("--setenv=PATH="))).toBe(true);
      expect(argv.some((a) => a.includes("TOKEN"))).toBe(false);

      // `--` separates systemd-run's own options from the command, so a
      // path that begins with `-` cannot be read as an option.
      const separator = argv.indexOf("--");
      expect(separator).toBeGreaterThan(0);
      expect(argv[separator + 1]).toBe(updateScript);
      const worker = argv.slice(separator + 2);
      expect(worker).toContain("--tarball");
      expect(worker).toContain(archive);
      expect(worker).not.toContain("--detach");

      // Queuing is ALL it does: the service is still up and untouched.
      expect(readCalls().filter((c) => c.includes(" stop "))).toEqual([]);
      expect(readCalls().filter((c) => c.includes(" start "))).toEqual([]);
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);

      // And it does not claim to have done anything. --no-block means the
      // start request "is only verified and enqueued" (systemd-run(1)), so
      // this process returns before the update has STARTED — a "done" here
      // would be a claim the exit status cannot support.
      expect(result.stderr).toContain("ENQUEUED");
      expect(result.stderr).toContain(`${UPDATE_UNIT}.service`);
      expect(result.stderr).toContain("reports nothing about the outcome");
      expect(result.stderr).toContain("journalctl --user");
      expect(result.stderr).not.toMatch(/\b(done|success|succeeded|completed)\b/i);
    });

    it("--allow-dirty は worker 側へ転送される", () => {
      const log = join(dir, "systemd-run-argv");
      const archive = makeReleaseTarball(work, B);

      runUpdate(["--tarball", archive, "--allow-dirty", "--detach"], {
        KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
        KAOIRO_SYSTEMD_RUN: recordingSystemdRun(log),
      });

      const argv = readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
      expect(argv.slice(argv.indexOf("--") + 2)).toContain("--allow-dirty");
    });

    it("前回の失敗ユニットが残っていても queue できるよう reset-failed する", () => {
      const archive = makeReleaseTarball(work, B);

      runUpdate(["--tarball", archive, "--detach"], {
        KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
        KAOIRO_SYSTEMD_RUN: recordingSystemdRun(join(dir, "argv")),
      });

      expect(
        readCalls().some((c) =>
          c.includes(`reset-failed ${UPDATE_UNIT}.service`),
        ),
      ).toBe(true);
    });
  });

  it("補助: 呼び出し元のプロセスグループを SIGKILL しても worker が完走する", async () => {
    // AUXILIARY, not the self-stop evidence — see the file header. `setsid`
    // emulates process-group detachment only; a real runner stop kills by
    // CGROUP (KillMode=control-group), which no stub here reproduces. What
    // this does show is that the worker itself survives losing its caller:
    // it does not die of an inherited signal disposition or a broken pipe
    // to a parent that is gone.
    const archive = makeReleaseTarball(work, B);
    const started = join(dir, "stop-began");
    const proceed = join(dir, "proceed");

    const detachingSystemdRun = writeStub(
      "systemd-run-setsid",
      [
        `while [ "$1" != "--" ]; do shift; done`,
        `shift`,
        `setsid "$@" </dev/null >>${JSON.stringify(join(dir, "worker.log"))} 2>&1 &`,
        `exit 0`,
      ].join("\n"),
    );

    // A file handshake instead of a sleep: the worker blocks inside `stop`
    // until the test has actually killed the caller, so the test cannot pass
    // by winning a race.
    const systemctl = systemctlStub({
      execStart: goodExecStart(),
      onStop: [
        `: > ${JSON.stringify(started)}`,
        `while [ ! -e ${JSON.stringify(proceed)} ]; do sleep 0.05; done`,
      ].join("\n"),
    });

    const callerScript = [
      `${JSON.stringify(updateScript)} --install-dir ${JSON.stringify(root)}`,
      `--service ${SERVICE} --tarball ${JSON.stringify(archive)} --detach`,
      `&& sleep 60`,
    ].join(" ");

    // detached: true makes node call setsid(), so the child's pid IS its
    // process-group id and the kill below hits the caller and everything it
    // still holds.
    const caller = spawn("sh", ["-c", callerScript], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        KAOIRO_SYSTEMCTL: systemctl,
        KAOIRO_SYSTEMD_RUN: detachingSystemdRun,
      },
    });
    const pgid = caller.pid;
    expect(pgid).toBeDefined();

    const waitFor = async (
      path: string,
      label: string,
      settled: (path: string) => boolean = () => true,
    ): Promise<void> => {
      for (let i = 0; i < 400; i += 1) {
        if (existsSync(path) && settled(path)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${label} (${path})`);
    };

    try {
      await waitFor(started, "the worker to reach the service stop");

      // Kill the caller's ENTIRE process group, the way stopping the runner
      // service kills every process in its cgroup.
      process.kill(-(pgid as number), "SIGKILL");

      writeFileSync(proceed, "");

      // Wait for the worker's OWN completion line, not for an intermediate
      // artifact: `previous` is written before `current` inside the switch,
      // so waiting on it would let this assert mid-switch state.
      await waitFor(
        join(dir, "worker.log"),
        "the worker to produce output",
        (path) => readFileSync(path, "utf8").includes("is running release"),
      );
    } finally {
      try {
        process.kill(-(pgid as number), "SIGKILL");
      } catch {
        // already gone
      }
    }

    // The worker got all the way through: switched, and started the service
    // again — after its caller had been killed.
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(readlinkSync(join(root, "previous"))).toBe(`releases/${A}`);
    expect(readCalls().some((c) => c.includes(" start "))).toBe(true);
  }, 20_000);

  it("stop → switch → start の順序を守る", () => {
    // Each systemctl call logs what `current` pointed at at that moment, so
    // the switch's position between the two is read off one ordered log
    // rather than inferred. Exit 0 from three commands would say nothing
    // about which of them ran while `current` still held the old release.
    const archive = makeReleaseTarball(work, B);

    const result = runUpdate(["--tarball", archive], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(0);
    const seen = readCalls().filter((c) => !c.includes("show -p ExecStart"));
    const stop = seen.findIndex((c) => c.includes(" stop "));
    const start = seen.findIndex((c) => c.includes(" start "));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(stop);
    // Still the old release when the service went down...
    expect(seen[stop]).toContain(`:: releases/${A}`);
    // ...and already the new one when it came back up.
    expect(seen[start]).toContain(`:: releases/${B}`);
  });

  it("dirty な release の activation は、停止する前に拒否する", () => {
    // Reaching this refusal inside the switch would cost an outage that was
    // decidable beforehand: the switch runs after the stop. Building off a
    // dirty tree is the ordinary way to get here.
    const archive = makeReleaseTarball(work, B, { dirty: true });

    const result = runUpdate(["--tarball", archive], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("only a clean 40-hex revision");
    expect(readCalls().filter((c) => c.includes(" stop "))).toEqual([]);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    // It was still prepared — refusing to ACTIVATE is not refusing to build.
    expect(existsSync(join(root, "releases", `${B}-dirty`))).toBe(true);
  });

  it("--allow-dirty を渡せば dirty release でも切り替わる", () => {
    const archive = makeReleaseTarball(work, B, { dirty: true });

    const result = runUpdate(["--tarball", archive, "--allow-dirty"], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}-dirty`);
  });

  it("--from-repo の正常系が最後まで通る", () => {
    // The documented primary update path (deployment.md 4.6.2). Only its
    // FAILURE case was covered before, which is how a defect that broke
    // every successful --from-repo run got through: update.sh's build
    // staging dir lived under the install root, and the install it then
    // invokes GC'd it as "abandoned" — the two hold different locks, so
    // neither one's exclusivity says anything about the other's dirs.
    const archive = makeReleaseTarball(work, B);
    const repo = join(dir, "fake-repo");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    const builder = join(repo, "scripts", "build-runner-tarball.sh");
    // Mimics the real builder's contract: --out <dir>, one .tar.gz emitted
    // there. Building the real one would need a full pnpm deploy.
    writeFileSync(
      builder,
      [
        "#!/bin/sh",
        "set -eu",
        "out=",
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        '    --out) out=$2; shift 2 ;;',
        '    --target) shift 2 ;;',
        '    *) shift ;;',
        "  esac",
        "done",
        `cp ${JSON.stringify(archive)} "$out/"`,
      ].join("\n"),
    );
    chmodSync(builder, 0o755);

    const result = runUpdate(["--from-repo", repo], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(B);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${B}`);
    expect(readlinkSync(join(root, "previous"))).toBe(`releases/${A}`);
    // The build output is cleaned up, so the next run cannot pick a stale
    // archive out of it.
    expect(readdirSync(root).filter((e) => e.startsWith(".staging."))).toEqual(
      [],
    );
  });

  it("update は自分の staging だけを GC する", () => {
    // The end-of-run "no .staging.* left" assertions above are satisfied by
    // the EXIT trap alone, so they do not measure the GC at all: with
    // update.sh's prefix argument corrupted, every one of them still passes.
    // Seeding a stale dir BEFORE the run is what makes the prefix
    // observable — the deletion direction from update's own side, which is
    // the half that the install-side test cannot reach.
    const staleBuild = join(root, ".staging.build.99999");
    mkdirSync(staleBuild, { recursive: true });
    // Owned by neither script. Over-widening either glob shows up here.
    const foreign = join(root, ".staging.other.99997");
    mkdirSync(foreign, { recursive: true });

    const result = runUpdate(["--tarball", makeReleaseTarball(work, B)], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(0);
    expect(existsSync(staleBuild)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(result.stderr).toContain("abandoned staging dir");
  });

  it("受入条件: build に失敗しても service は止めない", () => {
    const repo = join(dir, "fake-repo");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    const builder = join(repo, "scripts", "build-runner-tarball.sh");
    writeFileSync(builder, "#!/bin/sh\necho 'build blew up' >&2\nexit 1\n");
    chmodSync(builder, 0o755);

    const result = runUpdate(["--from-repo", repo], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).not.toBe(0);
    expect(readCalls().filter((c) => c.includes(" stop "))).toEqual([]);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    // The staging output is cleaned up rather than left to confuse the next
    // run into picking a stale archive.
    // `.staging.`, not `.build`: update.sh names its build dir
    // `.staging.build.$$`. The earlier literal matched nothing at all, so
    // this assertion passed whether or not the ~1.2 GB dir survived.
    expect(readdirSync(root).filter((e) => e.startsWith(".staging."))).toEqual(
      [],
    );
  });

  it("受入条件: 壊れた tarball でも service は止めない", () => {
    const archive = makeReleaseTarball(work, B, {
      omit: ["node_modules/@kaoiro/claude-code/dist/cli.js"],
    });

    const result = runUpdate(["--tarball", archive], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).not.toBe(0);
    expect(readCalls().filter((c) => c.includes(" stop "))).toEqual([]);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });

  it("unit が current 経由で起動していなければ、停止する前に拒否する", () => {
    const archive = makeReleaseTarball(work, B);

    const result = runUpdate(["--tarball", archive], {
      KAOIRO_SYSTEMCTL: systemctlStub({
        execStart: "/home/agent/repos/kaoiro/runner/deploy/kaoiro-runner-launch.sh",
      }),
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("does not launch through");
    expect(readCalls().filter((c) => c.includes(" stop "))).toEqual([]);
  });

  it("受入条件: 切替に失敗したら旧 release で service を起動し直す", () => {
    // A directory where `previous` belongs makes the symlink swap's
    // rename(2) fail, which is the reachable shape of "the switch did not
    // land".
    mkdirSync(join(root, "previous"));
    const archive = makeReleaseTarball(work, B);

    const result = runUpdate(["--tarball", archive], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("switch to");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
    const seen = readCalls();
    expect(seen.some((c) => c.includes(" stop "))).toBe(true);
    expect(seen.some((c) => c.includes(" start "))).toBe(true);
  });

  it("起動後の identity が食い違えば rollback 手順を出して失敗する", () => {
    // VERSION and dist/build-info.json disagree, so the id the install
    // recorded is not what `current` reports back. Exit 0 from systemctl is
    // not the postcondition; what the release answers is.
    const archive = makeReleaseTarball(work, B, { version: revisionOf("other") });

    const result = runUpdate(["--tarball", archive], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("did NOT reach a good state");
    expect(result.stderr).toContain("--rollback");
  });

  it("成功時に --keep まで prune し、current と previous は残す", () => {
    const old1 = revisionOf("old-1");
    const old2 = revisionOf("old-2");
    seedRelease(old1);
    seedRelease(old2);
    // Retention orders by install time, so the fixture states it explicitly
    // rather than relying on the order these directories happened to be
    // created in — which is what an earlier version of this test did, and it
    // passed or failed depending on how `ls -t` broke a tie.
    const now = Date.now() / 1000;
    utimesSync(join(root, "releases", old2), now - 40, now - 40);
    utimesSync(join(root, "releases", old1), now - 30, now - 30);
    utimesSync(join(root, "releases", A), now - 20, now - 20);
    const archive = makeReleaseTarball(work, B);

    const result = runUpdate(["--tarball", archive, "--keep", "1"], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(0);
    const remaining = readdirSync(join(root, "releases"));
    // `current` (B) and `previous` (A) survive --keep 1 unconditionally: the
    // runner resolves the codex wrapper lazily, so a release still reachable
    // as current is loaded from long after startup, and previous is the only
    // way back.
    expect(remaining).toContain(B);
    expect(remaining).toContain(A);
    expect(remaining).not.toContain(old1);
    expect(remaining).not.toContain(old2);
  });

  // Titled for what it measures: argument validation, which happens long
  // before any pruning. The "current / previous survive an aggressive
  // --keep" property is pinned by the --keep 1 case above.
  it("--keep 0 は引数エラーとして拒否する", () => {
    const archive = makeReleaseTarball(work, B);

    const result = runUpdate(["--tarball", archive, "--keep", "0"], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("--keep must be at least 1");
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${A}`);
  });

  it("option に見える値は下流の parser へ渡す前に弾く", () => {
    const result = runUpdate(["--tarball", "-rf"], {
      KAOIRO_SYSTEMCTL: systemctlStub({ execStart: goodExecStart() }),
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("must not begin with '-'");
  });
});
