import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import { phoenixLoopback } from "../../../runner/test/fixtures/phoenix_loopback.js";

it.each(["startup", "live"])("applies %s rename through the real ServerLink", async phase => {
  const cwd = mkdtempSync(join(tmpdir(), "kaoiro-grok-rename-"));
  const server = await phoenixLoopback(() => ({ permission_sync: false }));
  const persona = { id: "default", name: "Default", sprite_set: "default" };
  const canonical = JSON.stringify(persona);
  const config = { agent_id: "rename.grok", display_name: "Original", persona, server_url: server.url };
  let host: GrokHost | undefined;
  const states = () => server.received.filter(x => x.event === "envelope" && x.payload.type === "state_change").map(x => x.payload);
  const sync = (name: string, revision: number) => server.push("display_name_sync", { version: "0", display_name: name, revision });
  const work = runGrokCli({
    cwd,
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => config,
    createHost: options => new GrokHost({ ...options,
      executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
    }),
    onHostCreated: value => { host = value; },
  });
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    if (phase === "startup") {
      sync("Renamed", 5);
      sync("Old", 4);
      server.push("persona_sync", { version: "0", name: "Duplicate", revision: 5 });
      expect(host).toBeUndefined();
    }
    server.push("persona_prompt", { version: "0", prompt: "Fixture persona" });
    await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5000 });
    if (phase === "live") sync("Renamed", 5);
    await vi.waitFor(() => expect(states().at(-1)?.display_name).toBe("Renamed"));
    expect(config.display_name).toBe("Renamed");
    sync("Old", 4);
    server.push("persona_sync", { version: "0", name: "Duplicate", revision: 5 });
    sync("Latest", 6);
    await vi.waitFor(() => expect(states().at(-1)?.display_name).toBe("Latest"));
    expect(config.display_name).toBe("Latest");
    expect(states().map(x => x.display_name)).not.toContain("Old");
    expect(states().map(x => x.display_name)).not.toContain("Duplicate");
    expect(states().every(x => JSON.stringify(x.persona) === canonical)).toBe(true);
    expect(JSON.stringify(config.persona)).toBe(canonical);
  } finally {
    host?.close();
    try { await work; } finally { await server.close(); rmSync(cwd, { recursive: true, force: true }); }
  }
}, 15000);
