import { describe, expect, it, vi } from "vitest";
import {
  detectCodexAuthMode,
  parseCodexAuthMode,
  resolveCodexAuthMode,
} from "../src/codex-auth.js";

function doctorReport(mode: unknown): unknown {
  return {
    checks: {
      "auth.credentials": {
        details: {
          "stored auth mode": mode,
          "stored API key": "secret-api-key-marker",
          "stored ChatGPT tokens": "secret-token-marker",
        },
      },
    },
  };
}

describe("parseCodexAuthMode", () => {
  it.each(["chatgpt", "apikey"] as const)("%s を正規化する", (mode) => {
    expect(parseCodexAuthMode(doctorReport(mode))).toBe(mode);
  });

  it("field 欠落と未知値を unknown にする", () => {
    expect(parseCodexAuthMode({ checks: {} })).toBe("unknown");
    expect(parseCodexAuthMode(doctorReport("device-code"))).toBe("unknown");
  });
});

describe("detectCodexAuthMode", () => {
  it("doctor JSON から stored auth mode だけを返す", async () => {
    const mode = await detectCodexAuthMode(async () => ({
      stdout: JSON.stringify(doctorReport("chatgpt")),
    }));
    expect(mode).toBe("chatgpt");
  });

  it.each([
    ["実行失敗", async () => Promise.reject(new Error("secret in error"))],
    ["JSON parse失敗", async () => ({ stdout: "secret malformed output" })],
    [
      "field欠落",
      async () => ({
        stdout: JSON.stringify({ checks: { "auth.credentials": {} } }),
      }),
    ],
  ])("%s は unknown + token非露出warnにする", async (_name, runDoctor) => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await expect(detectCodexAuthMode(runDoctor)).resolves.toBe("unknown");
      const warning = stderr.mock.calls.flat().join("");
      expect(warning).toContain("model catalog will be empty");
      expect(warning).not.toContain("secret in error");
      expect(warning).not.toContain("secret malformed output");
      expect(warning).not.toContain("secret-api-key-marker");
      expect(warning).not.toContain("secret-token-marker");
    } finally {
      stderr.mockRestore();
    }
  });
});

/** Phase-24: explicit `codex.auth_mode` > doctor detection > "unknown".
 *  Injectable policy resolver — CLI startup と hot reload の両方から呼ばれる
 *  ため、doctor 呼出回数を含めて全遷移を pin する。explicit 経路で
 *  doctor が絶対に呼ばれないことは runner 環境 PATH に codex binary が
 *  無い場合の catalog 空回帰対策そのもの (dogfood 直接原因)。 */
describe("resolveCodexAuthMode (Phase-24 startup + hot reload policy)", () => {
  function makeDetect(returnMode: "chatgpt" | "apikey" | "unknown") {
    const fn = vi.fn(async () => returnMode);
    return fn as ReturnType<typeof vi.fn> &
      (() => Promise<"chatgpt" | "apikey" | "unknown">);
  }

  // ---- Startup 経路 (prev* 未定義) ----
  describe("startup", () => {
    it("Codex disabled → 'unknown' で doctor 非呼出", async () => {
      const detect = makeDetect("chatgpt");
      const mode = await resolveCodexAuthMode({
        nextCodex: { chatgpt_plan: "plus" },
        nextEnabled: false,
        detect,
      });
      expect(mode).toBe("unknown");
      expect(detect).not.toHaveBeenCalled();
    });

    it("explicit chatgpt → doctor 非呼出で採用", async () => {
      const detect = makeDetect("apikey");
      const mode = await resolveCodexAuthMode({
        nextCodex: { auth_mode: "chatgpt", chatgpt_plan: "plus" },
        nextEnabled: true,
        detect,
      });
      expect(mode).toBe("chatgpt");
      expect(detect).not.toHaveBeenCalled();
    });

    it("explicit apikey → doctor 非呼出で採用", async () => {
      const detect = makeDetect("chatgpt");
      const mode = await resolveCodexAuthMode({
        nextCodex: { auth_mode: "apikey" },
        nextEnabled: true,
        detect,
      });
      expect(mode).toBe("apikey");
      expect(detect).not.toHaveBeenCalled();
    });

    it("auth_mode absent → doctor に fallback (返り値をそのまま採用)", async () => {
      const detect = makeDetect("apikey");
      const mode = await resolveCodexAuthMode({
        nextCodex: { chatgpt_plan: "plus" },
        nextEnabled: true,
        detect,
      });
      expect(mode).toBe("apikey");
      expect(detect).toHaveBeenCalledTimes(1);
    });

    it("chatgpt_plan からの暗黙推定は禁止 (auth_mode 未指定なら plan があっても doctor)", async () => {
      const detect = makeDetect("apikey");
      const mode = await resolveCodexAuthMode({
        nextCodex: { chatgpt_plan: "plus" },
        nextEnabled: true,
        detect,
      });
      // apikey が返る = chatgpt_plan="plus" を根拠に chatgpt に決めていない。
      expect(mode).toBe("apikey");
    });
  });

  // ---- Hot reload 経路 (prev* 定義済み) ----
  describe("hot reload", () => {
    it("next disabled → 'unknown' で doctor 非呼出 (prev mode を破棄)", async () => {
      const detect = makeDetect("chatgpt");
      const mode = await resolveCodexAuthMode({
        nextCodex: {},
        nextEnabled: false,
        prevCodex: { auth_mode: "chatgpt" },
        prevEnabled: true,
        prevMode: "chatgpt",
        detect,
      });
      expect(mode).toBe("unknown");
      expect(detect).not.toHaveBeenCalled();
    });

    it("explicit → explicit 変更 (chatgpt → apikey) は doctor 非呼出", async () => {
      const detect = makeDetect("chatgpt");
      const mode = await resolveCodexAuthMode({
        nextCodex: { auth_mode: "apikey" },
        nextEnabled: true,
        prevCodex: { auth_mode: "chatgpt" },
        prevEnabled: true,
        prevMode: "chatgpt",
        detect,
      });
      expect(mode).toBe("apikey");
      expect(detect).not.toHaveBeenCalled();
    });

    it("explicit → absent (operator が pin を外した) は doctor 再走", async () => {
      const detect = makeDetect("apikey");
      const mode = await resolveCodexAuthMode({
        nextCodex: { chatgpt_plan: "plus" },
        nextEnabled: true,
        prevCodex: { auth_mode: "chatgpt" },
        prevEnabled: true,
        prevMode: "chatgpt",
        detect,
      });
      expect(mode).toBe("apikey");
      expect(detect).toHaveBeenCalledTimes(1);
    });

    it("off → on (absent) は doctor 実行", async () => {
      const detect = makeDetect("chatgpt");
      const mode = await resolveCodexAuthMode({
        nextCodex: { chatgpt_plan: "plus" },
        nextEnabled: true,
        prevCodex: undefined,
        prevEnabled: false,
        prevMode: "unknown",
        detect,
      });
      expect(mode).toBe("chatgpt");
      expect(detect).toHaveBeenCalledTimes(1);
    });

    it("off → on (explicit) は doctor 非呼出で採用", async () => {
      const detect = makeDetect("apikey");
      const mode = await resolveCodexAuthMode({
        nextCodex: { auth_mode: "chatgpt" },
        nextEnabled: true,
        prevCodex: undefined,
        prevEnabled: false,
        prevMode: "unknown",
        detect,
      });
      expect(mode).toBe("chatgpt");
      expect(detect).not.toHaveBeenCalled();
    });

    it("absent → absent enabled 継続 → 現 mode 維持 (doctor 非呼出)", async () => {
      const detect = makeDetect("apikey");
      const mode = await resolveCodexAuthMode({
        nextCodex: { chatgpt_plan: "plus" },
        nextEnabled: true,
        prevCodex: { chatgpt_plan: "plus" },
        prevEnabled: true,
        prevMode: "chatgpt",
        detect,
      });
      expect(mode).toBe("chatgpt");
      expect(detect).not.toHaveBeenCalled();
    });

    it("absent → absent enabled 継続 で prevMode 欠落なら 'unknown' 継承", async () => {
      const detect = makeDetect("apikey");
      const mode = await resolveCodexAuthMode({
        nextCodex: undefined,
        nextEnabled: true,
        prevCodex: undefined,
        prevEnabled: true,
        detect,
      });
      expect(mode).toBe("unknown");
      expect(detect).not.toHaveBeenCalled();
    });
  });

});
