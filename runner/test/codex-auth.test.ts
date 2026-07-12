import { describe, expect, it, vi } from "vitest";
import {
  detectCodexAuthMode,
  parseCodexAuthMode,
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
