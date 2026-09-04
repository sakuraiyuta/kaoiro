import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolHost } from "../src/toolhost.js";

const bridgePath = fileURLToPath(new URL("../dist/bridge.js", import.meta.url));

async function runBridge(environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = (await import("node:child_process")).spawn(process.execPath, [bridgePath, "list"], {
    env: environment,
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
  it("one-shot listはToolHostへ応答後socketを閉じてexit 0する", async () => {
    const host = await ToolHost.listen([{ name: "whoami", description: "identity", inputSchema: {}, handler: async () => ({ content: [] }) }]);
    try {
      const result = await Promise.race([
        runBridge({ ...process.env, KAOIRO_BRIDGE_SOCKET: host.socketPath, KAOIRO_BRIDGE_NONCE: host.nonce }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge child did not exit")), 1_000)),
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ name: "whoami" })]);
    } finally {
      host.close();
    }
  });
});
