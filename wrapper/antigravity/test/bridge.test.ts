import "../../../scripts/test/fixtures/test-isolation.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAntigravityBridge } from "../src/bridge.js";
import { ToolHost } from "../src/toolhost.js";

const kaoiroPath = fileURLToPath(new URL("../../../runner/dist/kaoiro.js", import.meta.url));

async function runBridge(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [kaoiroPath, "wrapper", "antigravity", "bridge", ...args], {
    env: { ...environment, CODEX_HOME: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, "exit") as [number | null];
  return { code, stdout, stderr };
}

describe("bridge CLI", () => {
  it("exports runAntigravityBridge without running on import", () => {
    expect(typeof runAntigravityBridge).toBe("function");
  });

  it("one-shot listはkaoiro wrapper antigravity bridge経由でToolHostへ応答後exit 0する", async () => {
    const host = await ToolHost.listen([{ name: "whoami", description: "identity", inputSchema: {}, handler: async () => ({ content: [{ type: "text", text: "ok" }] }) }]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        runBridge(["list"], { ...process.env, KAOIRO_BRIDGE_SOCKET: host.socketPath, KAOIRO_BRIDGE_NONCE: host.nonce }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("bridge child did not exit")), 5_000);
        }),
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ name: "whoami" })]);

      const callResult = await runBridge(
        ["call", "whoami", Buffer.from("{}", "utf8").toString("base64url")],
        { ...process.env, KAOIRO_BRIDGE_SOCKET: host.socketPath, KAOIRO_BRIDGE_NONCE: host.nonce },
      );
      expect(callResult.code).toBe(0);
      expect(callResult.stderr).toBe("");
      expect(JSON.parse(callResult.stdout)).toEqual({ content: [{ type: "text", text: "ok" }] });

      // Negative control: extra arguments after the entry subcommand fail usage check.
      for (const badArgs of [["list", "extra"], ["call", "whoami", "e30", "extra"], ["call", "whoami"]]) {
        const bad = await runBridge(badArgs, { ...process.env, KAOIRO_BRIDGE_SOCKET: host.socketPath, KAOIRO_BRIDGE_NONCE: host.nonce });
        expect(bad.code).toBe(1);
        expect(bad.stderr).toContain("usage:");
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      host.close();
    }
  }, 15_000);
});
