import "../../../scripts/test/fixtures/test-isolation.mjs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST_MODULE = pathToFileURL(join(PACKAGE_ROOT, "dist", "host.js")).href;
const SECRET = "abcdef123456";
const RPC_MODULE = pathToFileURL(join(PACKAGE_ROOT, "dist", "app_server_rpc.js")).href;
const MASKED = "api_key=********";

describe("CodexHost stderr — production default", () => {
  it("redacts native initialization stderr and keeps the wire failure private", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaoiro-codex-home-"));
    const codexHome = join(root, `api_key=${SECRET}`);
    await mkdir(join(codexHome, "state_5.sqlite"), { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "[features]\nplugins = false\n");
    const childSource = `
      import { CodexHost } from ${JSON.stringify(HOST_MODULE)};
      import { AppServerRpc } from ${JSON.stringify(RPC_MODULE)};
      const raw = new AppServerRpc({ requestTimeoutMs: 2000, shutdownTimeoutMs: 1000 });
      try {
        await raw.request("initialize", { clientInfo: { name: "diagnostic-positive", version: "0" }, capabilities: { experimentalApi: false } }).result;
      } catch {}
      finally { await raw.close(); }
      const nativeDiagnosticObserved = raw.stderrTail.includes(${JSON.stringify(SECRET)});
      const logs = [];
      let ended = false;
      let host;
      host = new CodexHost({
        agent_id: "stderr-production-default.codex",
        persona: { id: "momo", name: "Momo", sprite_set: "momo" },
        display_name: "Momo",
        server_url: "ws://localhost:1/wrapper",
        codex_auth_mode: "apikey",
        sandbox: "read-only",
        network_access: false,
      }, {
        onState: () => {},
        onLog: (envelope) => logs.push(envelope),
        onTurnEnd: () => { ended = true; },
        onTurnFinalized: () => host.close(),
        appendSystemPrompt: "Reply briefly.",
      });
      const timeout = setTimeout(() => {
        host.close();
        process.exitCode = 3;
      }, 15_000);
      await host.run("Reply OK");
      clearTimeout(timeout);
      process.stdout.write(JSON.stringify({ ended, logs, nativeDiagnosticObserved }) + "\\n");
      if (!ended) process.exitCode = 4;
    `;
    const { CODEX_API_KEY: _codexApiKey, OPENAI_API_KEY: _openAiApiKey, ...environment } = process.env;

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", childSource],
        {
          cwd: PACKAGE_ROOT,
          encoding: "utf8",
          env: { ...environment, CODEX_HOME: codexHome },
          timeout: 20_000,
        },
      );
      const output = JSON.parse(stdout) as { ended: boolean; logs: unknown[]; nativeDiagnosticObserved: boolean };

      expect(output.nativeDiagnosticObserved).toBe(true);
      expect(output.ended).toBe(true);
      expect(stderr).toContain(MASKED);
      expect(stderr).not.toContain(SECRET);
      expect(output.logs).toContainEqual(expect.objectContaining({ type: "result",
        payload: expect.objectContaining({ is_error: true, error_detail: expect.stringContaining("App-server") }) }));
      expect(JSON.stringify(output.logs)).not.toContain(SECRET);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
