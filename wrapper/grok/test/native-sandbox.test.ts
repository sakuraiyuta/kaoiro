import { permitHostAccess } from "../../../scripts/test/fixtures/test-isolation.mjs";
import { createServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { nativeRun } from "./native-support.js";

permitHostAccess({
  kinds: ["network"],
  optIn: "KAOIRO_LIVE_GROK",
  reason: "live Grok provider run",
});
const live = process.env.KAOIRO_LIVE_GROK === "1";
for (const sandbox of [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const) {
  it.skipIf(!live)(
    `native ${sandbox} controls writes and literal-IP child network`,
    async () => {
      const root = mkdtempSync(join(homedir(), ".kaoiro-grok-sandbox-"));
      const cwd = join(root, "work");
      mkdirSync(cwd);
      const outside = join(root, "outside");
      const inside = join(cwd, "inside");
      let connections = 0;
      const server = createServer((socket) => {
        connections += 1;
        socket.end();
      });
      const reports = mkdtempSync(
        join(tmpdir(), "kaoiro-grok-sandbox-report-"),
      );
      const report = join(reports, "result.json");
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      const script = join(cwd, "sandbox-probe.py");
      writeFileSync(
        script,
        `import json, pathlib, socket, urllib.request
result = {}
for label, target in [
 ('inside', ${JSON.stringify(inside)}),
 ('outside', ${JSON.stringify(outside)})
]:
 try:
  pathlib.Path(target).write_text('fixture')
  result[label] = True
 except OSError:
  result[label] = False
try:
 socket.create_connection(('127.0.0.1', ${port}), timeout=3).close()
 result['literal_ip'] = True
except OSError:
 result['literal_ip'] = False
try:
 with urllib.request.urlopen('https://example.com', timeout=5) as response:
  result['hostname'] = response.status == 200
except OSError:
 result['hostname'] = False
pathlib.Path(${JSON.stringify(report)}).write_text(json.dumps(result))
print(json.dumps(result, sort_keys=True))
`,
      );
      const config: WrapperConfig = {
        agent_id: "native.sandbox",
        display_name: "Sandbox fixture",
        server_url: "ws://127.0.0.1:1/agent",
        sandbox,
        network_access: sandbox !== "read-only",
        persona: { id: "default", name: "Default", sprite_set: "default" },
      };
      try {
        await nativeRun(
          config,
          cwd,
          async (host, _callbacks, envelopes) => {
            await vi.waitFor(() => expect(host.state).toBe("waiting_input"), {
              timeout: 40_000,
            });
            await host.send(
              "Use run_terminal_command exactly once to run " +
                `python3 ${JSON.stringify(script)}. ` +
                "Report JSON verbatim; no other tools, retries or commentary.",
            );
            if (process.env.KAOIRO_LIVE_GROK_SANDBOX_REPORT) {
              writeFileSync(
                process.env.KAOIRO_LIVE_GROK_SANDBOX_REPORT +
                  "-" +
                  sandbox +
                  "-diagnostic.json",
                JSON.stringify({ envelopes }),
              );
            }
            expect(existsSync(report)).toBe(true);
            const observed = JSON.parse(readFileSync(report, "utf8"));
            expect(existsSync(inside)).toBe(sandbox !== "read-only");
            expect(existsSync(outside)).toBe(
              sandbox === "danger-full-access",
            );
            expect(connections > 0).toBe(sandbox !== "read-only");
            expect(observed).toEqual({
              inside: sandbox !== "read-only",
              outside: sandbox === "danger-full-access",
              literal_ip: sandbox !== "read-only",
              hostname: sandbox !== "read-only",
            });
            if (process.env.KAOIRO_LIVE_GROK_SANDBOX_REPORT) {
              writeFileSync(
                process.env.KAOIRO_LIVE_GROK_SANDBOX_REPORT +
                  "-" +
                  sandbox +
                  ".json",
                JSON.stringify(observed),
              );
            }
          },
          undefined,
          (payload) => JSON.stringify(payload).includes(script),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
        rmSync(reports, { recursive: true, force: true });
      }
    },
    180_000,
  );
}
