import type { RunnerRegister } from "@kaoiro/protocol";
import { ServerLink } from "@kaoiro/wrapper-core";
import { describe, expect, it } from "vitest";
import { RunnerLink } from "../src/transport.js";
import { startPhoenixOutageServer } from "./phoenixOutageServer.js";
import type { OutageMode, WireEvent } from "./phoenixOutageServer.js";

// Production composition, nothing injected: RunnerLink and ServerLink build
// their sockets the way the runner and every wrapper do. A server restart
// (close 1012) followed by a few seconds of refused, 502 or silent upgrades
// must end in a reconnect. `@kaoiro/wrapper-core` resolves to its built dist,
// so these tests exercise the artifact that ships.

const OUTAGE_MS = 3_000;

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return done();
}

const describeEvents = (events: WireEvent[]) =>
  events.map((e) => `${e.topic} ${e.event}`).join("\n");

describe(`reconnect after a server restart (Node ${process.versions.node})`, () => {
  it.each<[OutageMode, number]>([
    ["refuse", 12_000],
    ["502", 12_000],
    // The hung attempt ends only at the 10 s handshake bound.
    ["silent", 15_000],
  ])("RunnerLink re-registers after close 1012 and a %s outage", async (mode, recoveryMs) => {
    const server = await startPhoenixOutageServer();
    const register: RunnerRegister = { version: "0", host_id: "outage-host", cwd_allowlist: [] };
    const link = new RunnerLink(server.url("/runner"), "outage-host", {
      register,
      heartbeatMs: 60_000,
      logHeartbeats: () => false,
    });
    try {
      expect(await waitUntil(() => server.count("register") === 1, 5_000)).toBe(true);
      await server.outage(mode, OUTAGE_MS);
      const recovered = await waitUntil(() => server.count("register") === 2, recoveryMs);
      expect(recovered, describeEvents(server.events)).toBe(true);
    } finally {
      link.close();
      await server.close();
    }
  }, 30_000);

  it("ServerLink rejoins after close 1012 and a refused outage, and its reply basis settles again", async () => {
    const server = await startPhoenixOutageServer((topic) =>
      topic.startsWith("wrapper:") ? { inter_agent_reply_basis: "v1" } : {},
    );
    const modes: string[] = [];
    const link = new ServerLink(server.url("/wrapper"), "outage-agent", {
      personaId: "p",
      interAgentReplyBasis: "v1",
      onReplyBasisMode: (mode) => modes.push(mode),
    });
    try {
      expect(await waitUntil(() => modes.includes("v1"), 5_000)).toBe(true);
      await server.outage("refuse", OUTAGE_MS);
      const recovered = await waitUntil(
        () => server.count("phx_join", "wrapper:") === 2 && modes.at(-1) === "v1",
        12_000,
      );
      expect(recovered, `${modes.join(",")}\n${describeEvents(server.events)}`).toBe(true);
      expect(modes.slice(modes.indexOf("v1") + 1)).toContain("pending");
      expect(await link.waitForReplyBasisMode()).toBe("v1");
    } finally {
      link.close();
      await server.close();
    }
  }, 30_000);
});
