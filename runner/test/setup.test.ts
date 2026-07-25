import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import {
  type Prompt,
  type SetupAnswers,
  buildRunnerConfig,
  buildRunnerEnv,
  generateToken,
  nextSteps,
  resolveConfigDir,
  runSetup,
} from "../src/setup.js";

const answers: SetupAnswers = {
  hostId: "lab-pc-1",
  serverUrl: "wss://kaoiro.example.com/runner",
  cwdAllowlist: ["/home/user/git/kaoiro"],
  capabilities: ["claude-code", "codex"],
  token: "deadbeef",
};

/** Scripted prompt: answers are consumed in order. `asked` records the
 *  questions so tests can assert on re-prompting. */
function scripted(script: string[]): Prompt & { asked: string[] } {
  const queue = [...script];
  const asked: string[] = [];
  const take = (question: string): string => {
    asked.push(question);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted prompt: ${question}`);
    return next;
  };
  return {
    asked,
    ask: (question, fallback) => {
      const answer = take(question);
      return Promise.resolve(
        answer === "" && fallback !== undefined && fallback !== ""
          ? fallback
          : answer,
      );
    },
    confirm: (question) => Promise.resolve(take(question) === "y"),
    info: () => {},
  };
}

describe("generateToken", () => {
  it("32 バイト = 64 文字の hex を返す", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("呼び出しごとに異なる", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("resolveConfigDir", () => {
  it("macOS は Application Support 配下", () => {
    expect(resolveConfigDir({}, "darwin", "/Users/me")).toBe(
      "/Users/me/Library/Application Support/kaoiro",
    );
  });

  it("Linux は ~/.config 配下", () => {
    expect(resolveConfigDir({}, "linux", "/home/me")).toBe(
      "/home/me/.config/kaoiro",
    );
  });

  it("XDG_CONFIG_HOME を尊重する", () => {
    expect(
      resolveConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me"),
    ).toBe("/xdg/kaoiro");
  });

  it("KAOIRO_RUNNER_DIR が最優先 (launch シムと同じ順序)", () => {
    expect(
      resolveConfigDir(
        { KAOIRO_RUNNER_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" },
        "darwin",
        "/Users/me",
      ),
    ).toBe("/custom");
  });
});

describe("buildRunnerConfig", () => {
  it("ローダを通した config を返す", () => {
    expect(buildRunnerConfig(answers)).toEqual({
      host_id: "lab-pc-1",
      server_url: "wss://kaoiro.example.com/runner",
      cwd_allowlist: ["/home/user/git/kaoiro"],
      capabilities: ["claude-code", "codex"],
    });
  });

  it("codex 有効時のみ auth_mode を書く", () => {
    const withCodex = buildRunnerConfig({
      ...answers,
      codexAuthMode: "chatgpt",
    });
    expect(withCodex.codex).toEqual({ auth_mode: "chatgpt" });

    // The loader's literal is "apikey" (no hyphen) — "api-key" would make
    // parseRunnerConfig throw and take the whole wizard down.
    const apiKey = buildRunnerConfig({ ...answers, codexAuthMode: "apikey" });
    expect(apiKey.codex).toEqual({ auth_mode: "apikey" });

    const withoutCodex = buildRunnerConfig({
      ...answers,
      capabilities: ["claude-code"],
      codexAuthMode: "chatgpt",
    });
    expect(withoutCodex.codex).toBeUndefined();
  });

  it("token を config には書かない (env 側の責務)", () => {
    expect(JSON.stringify(buildRunnerConfig(answers))).not.toContain(
      "deadbeef",
    );
  });

  it("ローダが弾く値は ConfigError で落ちる", () => {
    expect(() => buildRunnerConfig({ ...answers, hostId: "bad id" })).toThrow(
      ConfigError,
    );
  });
});

describe("buildRunnerEnv", () => {
  it("token を代入し、シェルとして妥当な行を出す", () => {
    const env = buildRunnerEnv(answers);
    expect(env).toContain("KAOIRO_RUNNER_TOKEN='deadbeef'");
    expect(env.endsWith("\n")).toBe(true);
  });

  it("token 未設定ならコメントアウトして出す", () => {
    const env = buildRunnerEnv({ ...answers, token: "" });
    expect(env).toContain("#KAOIRO_RUNNER_TOKEN=");
    expect(env).not.toMatch(/^KAOIRO_RUNNER_TOKEN=/m);
  });

  it("single quote を含む値をエスケープする", () => {
    const env = buildRunnerEnv({ ...answers, token: "a'b" });
    expect(env).toContain("KAOIRO_RUNNER_TOKEN='a'\\''b'");
  });

  it("nodePath 指定時は KAOIRO_NODE を有効行で書く", () => {
    const env = buildRunnerEnv({ ...answers, nodePath: "/opt/node/bin/node" });
    expect(env).toContain("KAOIRO_NODE='/opt/node/bin/node'");
    const commented = buildRunnerEnv(answers);
    expect(commented).toContain("#KAOIRO_NODE=");
  });
});

describe("runSetup", () => {
  const options = (dir: string) => ({
    env: { KAOIRO_RUNNER_DIR: dir },
    platform: "linux",
    home: "/home/unused",
  });

  it("回答から 2 ファイルを書き、env は 0600 になる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-setup-"));
    const prompt = scripted([
      "lab-pc-1", // host id
      "ws://localhost:4000/runner", // server url
      "/tmp/work", // cwd #1
      "", // cwd #2 -> end
      "y", // claude-code
      "n", // codex
      "y", // set a token?
      "n", // generate?
      "manual-token", // token
      "", // node path
    ]);

    const result = await runSetup(prompt, options(dir));

    expect(result.configPath).toBe(join(dir, "runner.config.json"));
    expect(result.token).toBe("manual-token");
    expect(result.skipped).toEqual([]);

    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(config).toEqual({
      host_id: "lab-pc-1",
      server_url: "ws://localhost:4000/runner",
      cwd_allowlist: ["/tmp/work"],
      capabilities: ["claude-code"],
    });

    const env = readFileSync(result.envPath, "utf8");
    expect(env).toContain("KAOIRO_RUNNER_TOKEN='manual-token'");
    // The token lives here, so the mode matters (issue #141).
    expect(statSync(result.envPath).mode & 0o777).toBe(0o600);
  });

  it("不正な host_id / server_url / 相対パスは聞き直す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-setup-"));
    const prompt = scripted([
      "bad id", // rejected: space
      "lab-pc-1",
      "http://nope", // rejected: not ws://
      "ws://localhost:4000/runner",
      "relative/path", // rejected: not absolute
      "", // rejected: list still empty
      "/tmp/work",
      "", // end list
      "y", // claude-code
      "n", // codex
      "n", // no token
      "", // node path
    ]);

    const result = await runSetup(prompt, options(dir));

    expect(result.token).toBe("");
    expect(prompt.asked.filter((q) => q === "Host ID")).toHaveLength(2);
    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(config.cwd_allowlist).toEqual(["/tmp/work"]);
  });

  it("自動生成を選ぶと 64 文字の token を書く", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-setup-"));
    const prompt = scripted([
      "lab-pc-1",
      "ws://localhost:4000/runner",
      "/tmp/work",
      "",
      "n", // claude-code off
      "y", // codex on
      "y", // codex uses a ChatGPT plan
      "y", // set a token
      "y", // generate
      "", // node path
    ]);

    const result = await runSetup(prompt, options(dir));

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(config.capabilities).toEqual(["codex"]);
    expect(config.codex).toEqual({ auth_mode: "chatgpt" });
  });

  it("既存ファイルの上書きを断ると内容を保ち skipped に載せる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-setup-"));
    const configPath = join(dir, "runner.config.json");
    writeFileSync(configPath, "KEEP ME");
    const prompt = scripted([
      "lab-pc-1",
      "ws://localhost:4000/runner",
      "/tmp/work",
      "",
      "y", // claude-code
      "n", // codex
      "n", // no token
      "", // node path
      "n", // overwrite runner.config.json? -> no
      // runner.env does not exist yet, so no overwrite question follows.
    ]);

    const result = await runSetup(prompt, options(dir));

    expect(result.skipped).toEqual([configPath]);
    expect(readFileSync(configPath, "utf8")).toBe("KEEP ME");
    // The env file did not exist, so it was written without asking.
    expect(readFileSync(result.envPath, "utf8")).toContain(
      "#KAOIRO_RUNNER_TOKEN=",
    );
  });

  it("codex を API key 認証にすると auth_mode=apikey を書く", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-setup-"));
    const prompt = scripted([
      "lab-pc-1",
      "ws://localhost:4000/runner",
      "/tmp/work",
      "",
      "n", // claude-code off
      "y", // codex on
      "n", // ChatGPT plan? -> no, so API key
      "n", // no token
      "", // node path
    ]);

    const result = await runSetup(prompt, options(dir));

    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(config.codex).toEqual({ auth_mode: "apikey" });
  });

  it("既存 runner.env を上書きしても 0600 に締め直す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-setup-"));
    const envPath = join(dir, "runner.env");
    writeFileSync(envPath, "OLD=1\n");
    // A file left at 0644 by an earlier hand-edit: writeFileSync's `mode` is
    // ignored on overwrite, so only an explicit chmod re-tightens it.
    chmodSync(envPath, 0o644);

    const prompt = scripted([
      "lab-pc-1",
      "ws://localhost:4000/runner",
      "/tmp/work",
      "",
      "y", // claude-code
      "n", // codex
      "y", // set a token
      "n", // generate?
      "tok", // token
      "", // node path
      "y", // runner.env exists -> overwrite
    ]);

    const result = await runSetup(prompt, options(dir));

    expect(result.skipped).toEqual([]);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(envPath, "utf8")).not.toContain("OLD=1");
  });

  it("engine を全部 off にしたら claude-code へ落とす", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-setup-"));
    const prompt = scripted([
      "lab-pc-1",
      "ws://localhost:4000/runner",
      "/tmp/work",
      "",
      "n", // claude-code off
      "n", // codex off
      "n", // no token
      "", // node path
    ]);

    const result = await runSetup(prompt, options(dir));

    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(config.capabilities).toEqual(["claude-code"]);
  });
});

describe("nextSteps", () => {
  const result = {
    configPath: "/cfg/runner.config.json",
    envPath: "/cfg/runner.env",
    skipped: [],
    token: "abc",
  };

  it("token があればサーバ側の対応行を案内する", () => {
    const lines = nextSteps(result, "abc").join("\n");
    expect(lines).toContain("KAOIRO_RUNNER_TOKENS=<host_id>:abc");
    expect(lines).toContain("kaoiro-runner-launch.sh");
  });

  it("token 無しなら dev 限定である旨を出す", () => {
    const lines = nextSteps({ ...result, token: "" }, "").join("\n");
    expect(lines).toContain("dev only");
    expect(lines).not.toContain("KAOIRO_RUNNER_TOKENS=");
  });

  it("skipped があれば残したパスを出す", () => {
    const lines = nextSteps(
      { ...result, skipped: ["/cfg/runner.env"] },
      "abc",
    ).join("\n");
    expect(lines).toContain("kept existing: /cfg/runner.env");
  });
});
