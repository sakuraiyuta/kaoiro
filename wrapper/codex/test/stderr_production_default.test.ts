import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST_MODULE = pathToFileURL(join(PACKAGE_ROOT, "dist", "host.js")).href;
const SECRET = "abcdef123456";
const MASKED = "api_key=********3456";

describe("CodexHost stderr — production default", () => {
  it("masks a real SDK config failure on the child process stderr and wire", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "kaoiro-codex-home-"));
    await writeFile(join(codexHome, "config.toml"), `api_key=${SECRET}\n`);
    const childSource = `
      import { CodexHost } from ${JSON.stringify(HOST_MODULE)};
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
      process.stdout.write(JSON.stringify({ ended, logs }) + "\\n");
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
      const output = JSON.parse(stdout) as { ended: boolean; logs: unknown[] };

      expect(output.ended).toBe(true);
      expect(stderr).toContain(MASKED);
      expect(stderr).not.toContain(SECRET);
      expect(JSON.stringify(output.logs)).toContain(MASKED);
      expect(JSON.stringify(output.logs)).not.toContain(SECRET);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
