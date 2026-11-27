import "../../../scripts/test/fixtures/test-isolation.mjs";
import { expect, it, vi } from "vitest";
import { runAntigravityCli } from "../src/cli.js";
import type { AntigravityHost } from "../src/host.js";
import { phoenixLoopback } from "../../../runner/test/fixtures/phoenix_loopback.js";

it("buffers startup rename and applies later revisions through the default host and ServerLink", async () => {
  const server = await phoenixLoopback(() => ({ permission_sync: false }));
  const persona = { id: "default", name: "Default", sprite_set: "default" };
  const canonical = JSON.stringify(persona);
  const config = { agent_id: "rename.antigravity", display_name: "Original", persona, server_url: server.url };
  let host: AntigravityHost | undefined;
  const states = () => server.received.filter(x => x.event === "envelope" && x.payload.type === "state_change").map(x => x.payload);
  const sync = (name: string, revision: number) => server.push("display_name_sync", { version: "0", display_name: name, revision });
  const work = runAntigravityCli({
    parseCliArgs: () => ({ configPath: "fixture" }),
    loadConfig: () => config,
    onHostCreated: value => { host = value; },
    probeSshAgentIdentities: async () => "unknown",
  });
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(server.joins).toBe(1));
    sync("Startup rename", 5);
    sync("Old", 4);
    server.push("persona_sync", { version: "0", name: "Duplicate", revision: 5 });
    expect(host).toBeUndefined();
    server.push("persona_prompt", { version: "0", prompt: "Fixture persona" });
    await vi.waitFor(() => expect(host).toBeDefined());
    await vi.waitFor(() => expect(states().at(-1)?.display_name).toBe("Startup rename"));
    expect(config.display_name).toBe("Startup rename");
    sync("Live rename", 6);
    await vi.waitFor(() => expect(states().at(-1)?.display_name).toBe("Live rename"));
    sync("Old", 5);
    server.push("persona_sync", { version: "0", name: "Duplicate", revision: 6 });
    sync("Latest", 7);
    await vi.waitFor(() => expect(states().at(-1)?.display_name).toBe("Latest"));
    expect(states().map(x => x.display_name)).not.toContain("Old");
    expect(states().map(x => x.display_name)).not.toContain("Duplicate");
    expect(states().every(x => JSON.stringify(x.persona) === canonical)).toBe(true);
    expect(JSON.stringify(config.persona)).toBe(canonical);
  } finally {
    await host?.close();
    try { await work; } finally { await server.close(); }
  }
}, 15000);
