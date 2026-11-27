import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import { phoenixLoopback } from "../../../runner/test/fixtures/phoenix_loopback.js";
import { expectWhoamiDirectoryName, expectWhoamiDirectoryNameUnavailable } from "../../agent-common/test/whoami_contract.js";

it("whoami uses current directory names and never stale config across rename or unavailability", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kaoiro-grok-whoami-"));
  let name: string | undefined = "Original";
  const server = await phoenixLoopback(() => ({ permission_sync: false }), event =>
    event === "directory_request" && name !== undefined
      ? { self: { agent_id: "self.grok", display_name: name } } : {});
  const persona = { id: "default", name: "Default", sprite_set: "default" };
  const config = { agent_id: "self.grok", display_name: "Stale config", persona, server_url: server.url };
  let host: GrokHost | undefined;
  const work = runGrokCli({ cwd, parseCliArgs: () => ({ configPath: "fixture" }), loadConfig: () => config,
    createHost: options => new GrokHost({ ...options,
      executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
    }), onHostCreated: value => { host = value; },
  });
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    server.push("persona_prompt", { version: "0", prompt: "Fixture" });
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5000 });
    const read = async () => {
      const count = server.received.filter(x => x.event === "envelope" && x.payload.type === "result").length;
      await host!.send("whoami");
      await vi.waitFor(() => expect(server.received.filter(x => x.event === "envelope" && x.payload.type === "result")).toHaveLength(count + 1));
      const envelope = server.received.filter(x => x.event === "envelope" && x.payload.type === "result").at(-1)!;
      const tool = JSON.parse((envelope.payload.payload as { text: string }).text);
      return JSON.parse(tool.content[0].text);
    };
    expectWhoamiDirectoryName(await read(), "Original", persona, "grok/initial");
    name = "Renamed";
    expectWhoamiDirectoryName(await read(), "Renamed", persona, "grok/renamed");
    name = undefined;
    expectWhoamiDirectoryNameUnavailable(await read(), "grok/unavailable");
    expect(config.display_name).toBe("Stale config");
  } finally {
    host?.close();
    try { await work; } finally { await server.close(); rmSync(cwd, { recursive: true, force: true }); }
  }
}, 15000);
