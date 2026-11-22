import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import type { WrapperConfig } from "@kaoiro/agent-common";
import type { AntigravityHost } from "../src/host.js";
import { runAntigravityCli } from "../src/cli.js";
import { loadWrapperBuildInfo } from "@kaoiro/wrapper-core";
import { fileURLToPath } from "node:url";
import { expectWhoamiDirectoryName, expectWhoamiDirectoryNameUnavailable } from "../../agent-common/test/whoami_contract.js";
import { createTestHost, type FakeAgy, type TestHost } from "./acp_fake.js";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** whoami over the MCP server the host gave this process at attach. */
async function callWhoami(agy: FakeAgy): Promise<Record<string, unknown>> {
  const request = agy.requests.find((q) => q.method === "session/new" || q.method === "session/resume")!;
  const server = (request.params.mcpServers as { url: string; headers: { name: string; value: string }[] }[])[0]!;
  const mcp = { url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
  const { body } = await agy.callTool("whoami", {}, { mcp });
  const parsed = JSON.parse(body) as { result?: { content?: { text?: string }[] } };
  return JSON.parse(parsed.result!.content![0]!.text!) as Record<string, unknown>;
}

describe("Antigravity CLI whoami composition (issue #418)", () => {
  it("reports session_id via whoami tool only after init event is received", async () => {
    const config: WrapperConfig = {
      agent_id: "test.agent",
      persona: { id: "momo", name: "Momo", sprite_set: "momo" },
      display_name: "Momo",
      server_url: "ws://localhost:4000",
    };
    const baked = loadWrapperBuildInfo(fileURLToPath(new URL("../dist/build-info.json", import.meta.url)));
    expect(baked.revision).not.toBe("unknown");
    let test!: TestHost;
    let hostResolve!: () => void;
    const hostReady = new Promise<void>((resolve) => {
      hostResolve = resolve;
    });
    let displayName: string | undefined = "Original";
    const link = {
      requestSelfIdentity: async () => displayName === undefined ? null : { agent_id: config.agent_id, display_name: displayName },
      close: () => {},
      send: () => {},
      setSessionId: () => {},
      reportDisconnectIntent: async () => true,
    };

    const cliPromise = runAntigravityCli({
      parseCliArgs: () => ({ configPath: "test" }),
      loadConfig: () => config,
      createServerLink: (_url, _agentId, options) => {
        expect(options.buildInfo).toEqual(baked);
        queueMicrotask(() => options.onPersonaPrompt?.("system prompt"));
        return link as never;
      },
      createHost: (cfg, options) => {
        test = createTestHost(cfg, options);
        test.onSpawn = (agy) => agy.hold.add("session/new");
        hostResolve();
        return test.host as AntigravityHost;
      },
    });

    await hostReady;
    try {
      void test.host.send("hello");
      await waitFor(() => test.agys[0]?.requests.some((q) => q.method === "session/new") === true);
      const agy = test.agys[0]!;
      // Negative control: before the session attached, session_id is absent.
      const beforeAttach = await callWhoami(agy);
      expect(beforeAttach).not.toHaveProperty("session_id");
      expectWhoamiDirectoryName(beforeAttach, "Original", config.persona, "antigravity/initial");
      displayName = "Renamed";
      expectWhoamiDirectoryName(await callWhoami(agy), "Renamed", config.persona, "antigravity/renamed");
      displayName = undefined;
      expectWhoamiDirectoryNameUnavailable(await callWhoami(agy), "antigravity/unavailable");
      expect(config.display_name).toBe("Momo");
      expect(beforeAttach.build).toEqual({revision:baked.revision,dirty:baked.dirty,version:baked.version,channel:baked.channel,
        ...(baked.branch === undefined ? {} : {branch:baked.branch})});

      agy.release("session/new");
      await waitFor(() => agy.promptOpen);
      // After attach, session_id is the engine's session.
      expect(await callWhoami(agy)).toMatchObject({ session_id: agy.sessionId });
      agy.respond("end_turn");
    } finally {
      await test.host.close();
      for (const agy of test.agys) agy.exit(0);
      await cliPromise;
    }
  });
});
