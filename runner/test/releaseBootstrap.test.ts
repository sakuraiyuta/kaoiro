// runner/deploy/kaoiro-runner-bootstrap.sh (issue #314): single entry point
// for a fresh host's first-time runner install — wizard -> install ->
// switch -> service unit -> enable/start.
//
// The wizard itself is NOT faked. It needs a real TTY (setup-cli.ts's own
// contract) and this suite runs with stdin piped, so invoking the REAL
// kaoiro-runner-setup.sh naturally exits 78 ("needs an interactive
// terminal" once built, or "wizard not built" before `pnpm build` has run —
// either way, a real, honest config-error) instead of standing in for it
// with a fake. That is exactly the failure shape this file pins for the
// "wizard would run" cases; the "config already exists" cases never reach
// it at all, which this file also pins by asserting a clean exit.
//
// HOME IS ALWAYS AN ISOLATED TEMP DIR, NEVER THE REAL ONE. Every scenario
// writes a systemd unit / launchd plist under `$HOME`; without an override
// that would land in the CI/dev user's real `~/.config` or
// `~/Library/LaunchAgents`.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfigDir } from "../src/setup.js";
import { makeReleaseTarball, revisionOf, runScript } from "./releaseFixture.js";

const bootstrapScript = fileURLToPath(
  new URL("../deploy/kaoiro-runner-bootstrap.sh", import.meta.url),
);
const commonScript = fileURLToPath(
  new URL("../deploy/kaoiro-runner-common.sh", import.meta.url),
);

const TOKEN = "kaoiro-secret-token-do-not-print-9f3a";

/** Runs `kaoiro_config_dir` (kaoiro-runner-common.sh) in isolation, the same
 *  way any deploy/*.sh sourcing the file would call it. Every override key
 *  defaults to `undefined` (removed) so a case only reflects what it states,
 *  never an ambient value the host or CI runner happens to carry. */
const configDirViaShell = (
  env: Record<string, string | undefined>,
) =>
  runScript("sh", ["-c", `. ${JSON.stringify(commonScript)}; kaoiro_config_dir`], {
    HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    KAOIRO_RUNNER_DIR: undefined,
    KAOIRO_UNAME: undefined,
    ...env,
  });

describe("kaoiro-runner-bootstrap.sh (issue #314)", () => {
  let dir: string;
  let home: string;
  let root: string;
  let configDir: string;
  let work: string;
  let bin: string;
  let calls: string;

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

  /** `is-active --quiet <service>` reports active (exit 0) only for
   *  `options.activeService`, else inactive (exit 3, matching real
   *  systemctl's own code for that case) — the one fact apply_systemd
   *  reads before deciding whether a unit-file change needs a "restart it
   *  yourself" notice. Every invocation is logged. */
  const systemctlStub = (options: { activeService?: string } = {}): string =>
    writeStub(
      "systemctl-stub",
      [
        `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
        `case "$*" in`,
        `  "--user is-active --quiet ${options.activeService ?? "__no_service_is_active__"}") exit 0 ;;`,
        `  *"is-active --quiet"*) exit 3 ;;`,
        `esac`,
        `exit 0`,
      ].join("\n"),
    );

  /** `print gui/<uid>/com.kaoiro.runner` reports loaded (exit 0) when
   *  `loaded` is true, else not-loaded (exit 1, matching real launchctl). */
  const launchctlStub = (options: { loaded?: boolean } = {}): string =>
    writeStub(
      "launchctl-stub",
      [
        `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
        `case "$*" in`,
        `  *"print gui/"*) exit ${options.loaded === true ? 0 : 1} ;;`,
        `esac`,
        `exit 0`,
      ].join("\n"),
    );

  const writeConfig = (): void => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "runner.config.json"),
      JSON.stringify({ host_id: "h1", server_url: "wss://example.invalid/runner" }),
    );
    writeFileSync(join(configDir, "runner.env"), `KAOIRO_RUNNER_TOKEN=${TOKEN}\n`);
    chmodSync(join(configDir, "runner.env"), 0o600);
  };

  const bootstrap = (
    args: string[],
    env: Record<string, string | undefined> = {},
    installDir: string = root,
  ) => {
    const merged: Record<string, string | undefined> = {
      HOME: home,
      KAOIRO_RUNNER_DIR: configDir,
      KAOIRO_UNAME: "Linux",
      ...env,
    };
    // Only fills in the default stub when the CALLER did not mention this
    // key at all. systemctlStub() writes a file as a side effect, so
    // computing it unconditionally here (even to a value `...env` then
    // discards) would overwrite whatever stub an explicit
    // `KAOIRO_SYSTEMCTL: systemctlStub({...})` in `env` had just written,
    // since object-literal properties are all evaluated before the spread
    // reassigns the key — the LAST write to the shared file path wins, not
    // the one the env override intended.
    if (!("KAOIRO_SYSTEMCTL" in env)) {
      merged.KAOIRO_SYSTEMCTL = systemctlStub();
    }
    return runScript(bootstrapScript, ["--install-dir", installDir, ...args], merged);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaoiro-runner-bootstrap-"));
    home = join(dir, "home");
    root = join(dir, "install-root");
    configDir = join(dir, "config");
    work = join(dir, "work");
    bin = join(dir, "bin");
    calls = join(dir, "service-calls");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(bin, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("順序と正常系(config 既存 = wizard スキップ)", () => {
    it("install → switch → unit 配置 → enable --now まで一気通貫で完了する", () => {
      writeConfig();
      const revision = revisionOf("bootstrap-happy");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive]);

      expect(result.status).toBe(0);
      // "running the setup wizard" is the exact phrase printed only when
      // it is actually INVOKED — the skip branch's own message legitimately
      // mentions "wizard" too (explaining why it was skipped), so a bare
      // substring check on the word itself would not distinguish the two.
      expect(result.stderr).toContain("skipping the setup wizard");
      expect(result.stderr).not.toContain("running the setup wizard");
      expect(readlinkSync(join(root, "current"))).toBe(`releases/${revision}`);
      const calledLines = readCalls();
      expect(calledLines.some((l) => l.startsWith("--user daemon-reload"))).toBe(true);
      expect(
        calledLines.some((l) => l.startsWith("--user enable --now kaoiro-runner")),
      ).toBe(true);
    });

    it("$HOME/.config/systemd/user/kaoiro-runner.service を書き、@@DEPLOY_DIR@@ を current/deploy へ解決する", () => {
      writeConfig();
      const revision = revisionOf("bootstrap-unit-content");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive]);

      expect(result.status).toBe(0);
      const unitPath = join(home, ".config", "systemd", "user", "kaoiro-runner.service");
      expect(existsSync(unitPath)).toBe(true);
      const content = readFileSync(unitPath, "utf8");
      expect(content).toContain(`ExecStart="${root}/current/deploy/kaoiro-runner-launch.sh"`);
      expect(content).not.toContain("@@DEPLOY_DIR@@");
    });
  });

  describe("wizard の呼び出し(config 不在 / --reconfigure)", () => {
    it("config が無ければ wizard を呼ぼうとし、TTY 無しの現実的な失敗を素通しする", () => {
      // configDir left empty: run_wizard=yes, and the REAL setup.sh (no
      // stub) is what runs. It exits 78 on its own — either "not built" or
      // "needs a TTY" — never a fake standing in for that judgement.
      const revision = revisionOf("bootstrap-no-config");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/wizard not built|needs an interactive terminal/);
      // Nothing after the wizard ran: no release installed, no unit touched.
      expect(existsSync(join(root, "current"))).toBe(false);
      expect(readCalls()).toEqual([]);
    });

    it("--reconfigure は既存 config を wizard 呼び出し前にタイムスタンプ付きで退避する", () => {
      writeConfig();
      const before = readFileSync(join(configDir, "runner.env"), "utf8");
      const revision = revisionOf("bootstrap-reconfigure");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive, "--reconfigure"]);

      // The wizard still hits the same real, TTY-less failure — this test
      // is about what happens BEFORE that point.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("backing up");
      const backups = execFileSync("sh", [
        "-c",
        `ls ${JSON.stringify(configDir)}/runner.env.bak-* 2>/dev/null || true`,
      ])
        .toString()
        .trim()
        .split("\n")
        .filter((l) => l !== "");
      expect(backups.length).toBe(1);
      const backupPath = backups[0];
      if (backupPath === undefined) throw new Error("unreachable: length checked above");
      expect(readFileSync(backupPath, "utf8")).toBe(before);
      // The ORIGINAL is untouched by the backup step itself.
      expect(readFileSync(join(configDir, "runner.env"), "utf8")).toBe(before);
    });
  });

  describe("--dry-run", () => {
    it("何も変更せず計画だけ表示し、config が無くても wizard を呼ばない", () => {
      // No writeConfig() — a fresh host. If dry-run invoked the real wizard
      // here it would exit 78 and this assertion on status would catch it.
      const revision = revisionOf("bootstrap-dry-run");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive, "--dry-run"]);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("DRY RUN");
      expect(result.stderr).toContain(archive);
      expect(existsSync(root)).toBe(false);
      expect(readCalls()).toEqual([]);
    });
  });

  describe("OS 分岐", () => {
    it("未知の OS は拒否し、何も変更しない", () => {
      writeConfig();
      const revision = revisionOf("bootstrap-unknown-os");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive], { KAOIRO_UNAME: "Plan9" });

      expect(result.status).toBe(78);
      expect(result.stderr).toContain("unsupported OS");
      expect(existsSync(join(root, "current"))).toBe(false);
    });

    it("Darwin は launchd 経路を通り、初回は bootstrap で読み込む", () => {
      writeConfig();
      const revision = revisionOf("bootstrap-darwin");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive], {
        KAOIRO_UNAME: "Darwin",
        KAOIRO_SYSTEMCTL: undefined,
        KAOIRO_LAUNCHCTL: launchctlStub({ loaded: false }),
      });

      expect(result.status).toBe(0);
      const plistPath = join(home, "Library", "LaunchAgents", "com.kaoiro.runner.plist");
      expect(existsSync(plistPath)).toBe(true);
      const content = readFileSync(plistPath, "utf8");
      expect(content).toContain(`${root}/current/deploy/kaoiro-runner-launch.sh`);
      expect(content).toContain(`${home}/Library/Logs/kaoiro/runner.log`);
      expect(readCalls().some((l) => l.startsWith("bootstrap gui/"))).toBe(true);
    });

    it("KAOIRO_UNAME=Darwin では os も config dir も揃って launchd 側へ振れる(食い違わない)", () => {
      // KAOIRO_RUNNER_DIR is explicitly left UNSET (unlike every other test
      // in this file, which overrides it to a fixed temp dir) so
      // kaoiro_config_dir genuinely runs its own uname branch here — round-1
      // review M-1: before the fix, this function always called bare
      // `uname -s`, so on a real-Linux CI host, os (from KAOIRO_UNAME) and
      // config_dir (from the real kernel) could disagree about which OS this
      // run is for. This test fails exactly that way if the fix regresses,
      // since this suite always runs on Linux.
      const revision = revisionOf("bootstrap-darwin-config-dir-parity");
      const archive = makeReleaseTarball(work, revision);

      const result = runScript(
        bootstrapScript,
        ["--install-dir", root, archive, "--dry-run"],
        { HOME: home, KAOIRO_UNAME: "Darwin", KAOIRO_RUNNER_DIR: undefined },
      );

      expect(result.status).toBe(0);
      const darwinConfigDir = join(home, "Library", "Application Support", "kaoiro");
      const linuxConfigDir = join(home, ".config", "kaoiro");
      expect(result.stderr).toContain(darwinConfigDir);
      expect(result.stderr).not.toContain(linuxConfigDir);
    });
  });

  describe("冪等な再実行", () => {
    it("unit file の内容が同じ2回目の実行では daemon-reload を呼ばない", () => {
      writeConfig();
      const first = revisionOf("bootstrap-idem-1");
      bootstrap([makeReleaseTarball(work, first)]);
      const firstCalls = readCalls();
      expect(firstCalls.filter((l) => l.startsWith("--user daemon-reload")).length).toBe(1);

      // Second run, SAME --install-dir (so @@DEPLOY_DIR@@ renders
      // identically) and a different release id — install/switch are
      // independently idempotent-safe; only the unit file's own diff
      // matters to this test.
      const second = revisionOf("bootstrap-idem-2");
      const result = bootstrap([makeReleaseTarball(work, second)]);
      expect(result.status).toBe(0);

      const secondCalls = readCalls().slice(firstCalls.length);
      expect(secondCalls.filter((l) => l.startsWith("--user daemon-reload")).length).toBe(0);
      expect(secondCalls.some((l) => l.startsWith("--user enable --now"))).toBe(true);
      expect(result.stderr).toContain("unit file unchanged");
    });

    it("unit file の内容が変わり、かつ稼働中なら書き換えるが再起動はせず、operator に委ねる", () => {
      writeConfig();
      const first = revisionOf("bootstrap-changed-1");
      bootstrap([makeReleaseTarball(work, first)]);

      // A DIFFERENT --install-dir changes @@DEPLOY_DIR@@'s rendered value,
      // so the unit file genuinely differs this time. The stub reports
      // kaoiro-runner as currently active.
      const otherRoot = join(dir, "install-root-2");
      const second = revisionOf("bootstrap-changed-2");
      const archive = makeReleaseTarball(work, second);
      const result = bootstrap(
        [archive],
        { KAOIRO_SYSTEMCTL: systemctlStub({ activeService: "kaoiro-runner" }) },
        otherRoot,
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("does NOT restart it for you");
      // The printed hint names whatever $systemctl_bin actually resolved to
      // (the fake stub's own path here), not a hardcoded "systemctl" —
      // checking the fixed suffix is what stays true either way.
      expect(result.stderr).toContain("--user restart kaoiro-runner");
      const calledLines = readCalls();
      expect(calledLines.some((l) => l.startsWith("--user daemon-reload"))).toBe(true);
      expect(calledLines.some((l) => l.includes("restart"))).toBe(false);
      const unitPath = join(home, ".config", "systemd", "user", "kaoiro-runner.service");
      expect(readFileSync(unitPath, "utf8")).toContain(`${otherRoot}/current/deploy`);
    });
  });

  describe("render の sed 置換値 escape (issue #314 round1 S-1)", () => {
    it("install root に & / | を含んでも @@DEPLOY_DIR@@ を正しい literal path に解決する", () => {
      writeConfig();
      // sed's own RHS specials: `&` (whole match) and `|` (this script's own
      // delimiter). Both are REAL, valid path-component bytes on Linux — an
      // install root is not guaranteed to avoid them. (`\` is pinned
      // separately below, via $HOME rather than the install root — see that
      // test for why.)
      for (const fragment of ["a&b", "a|b"]) {
        const weirdRoot = join(dir, `install-root-${fragment}`);
        const revision = revisionOf(`bootstrap-sed-escape-${fragment}`);
        const archive = makeReleaseTarball(work, revision);

        const result = bootstrap([archive], {}, weirdRoot);

        expect(result.status).toBe(0);
        const unitPath = join(home, ".config", "systemd", "user", "kaoiro-runner.service");
        const content = readFileSync(unitPath, "utf8");
        expect(content).toContain(`${weirdRoot}/current/deploy`);
        expect(content).not.toContain("@@DEPLOY_DIR@@");
      }
    });

    it("$HOME に \\ を含んでも launchd plist の @@HOME@@ を正しい literal path に解決する", () => {
      // The install ROOT deliberately does NOT carry a backslash here: GNU
      // tar's `-C` argument goes through tar's OWN backslash-unquoting
      // before kaoiro-runner-install.sh ever runs (measured live —
      // `tar xzf ... -C "a\1b/dir"` fails to open a directory that
      // demonstrably exists, because tar reads `\1` as an octal escape and
      // looks for a mangled name instead). That is a pre-existing tar
      // behavior on a script this round's scope explicitly leaves untouched
      // (install.sh), not a property of sed_escape_replacement, so this test
      // exercises the same `\` character through $HOME / the launchd plist
      // instead — a path render_launchd_plist substitutes directly and tar
      // never sees.
      writeConfig();
      const weirdHome = join(dir, "home-a\\1b");
      mkdirSync(weirdHome, { recursive: true });
      const revision = revisionOf("bootstrap-sed-escape-home-backslash");
      const archive = makeReleaseTarball(work, revision);

      const result = runScript(
        bootstrapScript,
        ["--install-dir", root, archive],
        {
          HOME: weirdHome,
          KAOIRO_RUNNER_DIR: configDir,
          KAOIRO_UNAME: "Darwin",
          KAOIRO_LAUNCHCTL: launchctlStub({ loaded: false }),
        },
      );

      expect(result.status).toBe(0);
      const plistPath = join(weirdHome, "Library", "LaunchAgents", "com.kaoiro.runner.plist");
      const content = readFileSync(plistPath, "utf8");
      expect(content).toContain(`${weirdHome}/Library/Logs/kaoiro/runner.log`);
      expect(content).not.toContain("@@HOME@@");
    });

    it("install root に改行を含む場合は描画前に拒否し、一時ファイルを残さない", () => {
      writeConfig();
      const weirdRoot = join(dir, "install-root-with\nnewline");
      const revision = revisionOf("bootstrap-newline-reject");
      const archive = makeReleaseTarball(work, revision);

      const result = bootstrap([archive], {}, weirdRoot);

      expect(result.status).toBe(70);
      expect(result.stderr).toContain("must not contain a newline");
      const unitDir = join(home, ".config", "systemd", "user");
      if (existsSync(unitDir)) {
        expect(readdirSync(unitDir).some((f) => f.includes(".new."))).toBe(false);
      }
    });
  });

  describe("token を一切表示しない", () => {
    it("runner.env の内容がどのモードの stdout/stderr にも現れない", () => {
      writeConfig();
      const revision = revisionOf("bootstrap-token-safety");
      const archive = makeReleaseTarball(work, revision);

      const scenarios = [
        bootstrap([archive, "--dry-run"]),
        bootstrap([archive]),
        bootstrap([archive, "--reconfigure"]),
        bootstrap([archive], { KAOIRO_UNAME: "NotAnOS" }),
      ];
      for (const result of scenarios) {
        expect(result.stdout).not.toContain(TOKEN);
        expect(result.stderr).not.toContain(TOKEN);
      }
    });
  });
});

// Separate top-level describe: unlike the suite above, these cases need no
// release tarball, install root, or fake service manager — only
// kaoiro-runner-common.sh's kaoiro_config_dir in isolation, compared against
// the TS function it claims to mirror.
describe("kaoiro_config_dir と resolveConfigDir の parity (issue #314 round1 M-1)", () => {
  // Same 4 shapes setup.test.ts's own resolveConfigDir suite pins on the TS
  // side (override / darwin / XDG set / XDG absent) — this proves the SHELL
  // side agrees with it, not merely that each agrees with itself.
  const cases: Array<{
    name: string;
    shellEnv: Record<string, string | undefined>;
    tsEnv: Record<string, string | undefined>;
    platform: string;
    home: string;
  }> = [
    {
      name: "KAOIRO_RUNNER_DIR が最優先",
      shellEnv: {
        HOME: "/Users/me",
        KAOIRO_UNAME: "Darwin",
        KAOIRO_RUNNER_DIR: "/custom",
        XDG_CONFIG_HOME: "/xdg",
      },
      tsEnv: { KAOIRO_RUNNER_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" },
      platform: "darwin",
      home: "/Users/me",
    },
    {
      name: "Darwin は Application Support 配下",
      shellEnv: { HOME: "/Users/me", KAOIRO_UNAME: "Darwin" },
      tsEnv: {},
      platform: "darwin",
      home: "/Users/me",
    },
    {
      name: "XDG_CONFIG_HOME を尊重する (Linux)",
      shellEnv: { HOME: "/home/me", KAOIRO_UNAME: "Linux", XDG_CONFIG_HOME: "/xdg" },
      tsEnv: { XDG_CONFIG_HOME: "/xdg" },
      platform: "linux",
      home: "/home/me",
    },
    {
      name: "XDG_CONFIG_HOME 未設定なら ~/.config (Linux)",
      shellEnv: { HOME: "/home/me", KAOIRO_UNAME: "Linux" },
      tsEnv: {},
      platform: "linux",
      home: "/home/me",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: shell (kaoiro_config_dir) と TS (resolveConfigDir) が同じ path を返す`, () => {
      const result = configDirViaShell(c.shellEnv);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(resolveConfigDir(c.tsEnv, c.platform, c.home));
    });
  }

  it("HOME が未設定なら KAOIRO_RUNNER_DIR を案内して exit 非 0", () => {
    const result = configDirViaShell({});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("KAOIRO_RUNNER_DIR");
  });
});
