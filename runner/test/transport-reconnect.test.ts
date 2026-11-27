import "../../scripts/test/fixtures/test-isolation.mjs";
import type { RunnerRegister } from "@kaoiro/protocol";
import { ServerLink } from "@kaoiro/wrapper-core";
import { describe, expect, it, vi } from "vitest";
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const register = { version: "0" as const, host_id: "outage-host",
  cwd_allowlist: [] };
type OutageServer = Awaited<ReturnType<typeof startPhoenixOutageServer>>;

async function withRunner(
  run: (server: OutageServer, link: RunnerLink) => Promise<void>,
) {
  const server = await startPhoenixOutageServer();
  const link = new RunnerLink(server.url("/runner"), register.host_id, {
    register, heartbeatMs: 60_000,
  });
  try {
    expect(await waitUntil(() => server.count("register") === 1, 5_000))
      .toBe(true);
    await run(server, link);
  } finally { link.close(); await server.close(); }
}

async function failedClose(server: OutageServer) {
  server.send("runner:outage-host", "phx_error");
  await delay(50);
  await server.outage("502", 0, 1000);
  await delay(100);
}

describe("runner channel-failure recovery boundaries", () => {
  it.each(["plain", "other-topic", "phx_close", "rejoined"])(
    "keeps normal 1000 terminal after %s", async (mode) => withRunner(
      async (server) => {
        if (mode !== "plain") {
          server.send(mode === "other-topic" ? "runner:other" :
            "runner:outage-host", "phx_error");
          await delay(50);
        }
        if (mode === "phx_close") {
          server.send("runner:outage-host", "phx_close");
          await delay(50);
        }
        if (mode === "rejoined") {
          expect(await waitUntil(() => server.count("phx_join") === 2,
            3_000)).toBe(true);
          await delay(100);
        }
        await server.outage("502", 0, 1000);
        await delay(1_300);
        expect(server.count("register")).toBe(1);
        expect(server.count("phx_join")).toBe(mode === "rejoined" ? 2 : 1);
      },
    ),
  );

  it("cancels delayed recovery on close", async () => withRunner(
    async (server, link) => {
      await failedClose(server);
      link.close();
      await delay(1_300);
      expect(server.count("phx_join")).toBe(1);
    },
  ));

  it("backs off across automatic generations even after successful joins",
    async () => withRunner(async (server, link) => {
      for (const [index, quietMs] of [500, 1_200, 4_200, 4_200].entries()) {
        await failedClose(server);
        await delay(quietMs);
        expect(server.count("register")).toBe(index + 1);
        expect(await waitUntil(() => server.count("register") === index + 2,
          2_000)).toBe(true);
      }
    }),
    25_000,
  );

  it("cancels recovery when Phoenix reopens after heartbeat timeout",
    async () => {
      const realTimeout = globalThis.setTimeout;
      const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(
        ((callback: Parameters<typeof setTimeout>[0], ms?: number,
          ...args: unknown[]) => Reflect.apply(realTimeout, globalThis,
          [callback, ms === 30_000 ? 100 : ms, ...args])) as typeof setTimeout,
      );
      const output = vi.spyOn(process.stderr, "write");
      try {
        await withRunner(async (server) => {
          server.rejectJoins();
          server.silenceCurrentHeartbeats();
          server.send("runner:outage-host", "phx_error");
          expect(await waitUntil(() => server.connections() === 2,
            900)).toBe(true);
          expect(timer.mock.calls.some(([, ms]) => ms === 30_000)).toBe(true);
          expect(output.mock.calls.some(([line]) =>
            String(line).includes("code=1000"))).toBe(true);
          await delay(1_300);
          expect(server.count("register")).toBe(1);
          expect(server.connections()).toBe(2);
        });
      } finally { timer.mockRestore(); output.mockRestore(); }
    },
  );

  it("preserves the wrapper's terminal 1000 behavior", async () => {
    const server = await startPhoenixOutageServer();
    const link = new ServerLink(server.url("/wrapper"), "outage-agent", {
      personaId: "p",
    });
    try {
      expect(await waitUntil(() => server.count("phx_join") === 1, 2_000))
        .toBe(true);
      server.send("wrapper:outage-agent", "phx_error");
      await delay(50);
      await server.outage("502", 0, 1000);
      await delay(1_300);
      expect(server.count("phx_join")).toBe(1);
    } finally { link.close(); await server.close(); }
  });
});

describe(`reconnect after a server restart (Node ${process.versions.node})`, () => {
  // After a 3 s outage Phoenix's next attempt lands about 1.3 s after the
  // server is back. 5 s stays short of the 7 s the handshake bound would take
  // to rescue a failed attempt, so the failure close is what passes here.
  it.each<[OutageMode, number, number]>([
    ["refuse", 5_000, 1012],
    ["502", 5_000, 1012],
    // The hung attempt ends only at the 10 s handshake bound.
    ["silent", 15_000, 1012],
    ["refuse", 5_000, 1000],
    ["502", 5_000, 1000],
    ["silent", 15_000, 1000],
  ])("RunnerLink recovers from %s within %i ms after %i", async (mode, recoveryMs, code) => {
    const server = await startPhoenixOutageServer();
    const register: RunnerRegister = { version: "0", host_id: "outage-host", cwd_allowlist: [] };
    const link = new RunnerLink(server.url("/runner"), "outage-host", {
      register,
      heartbeatMs: 60_000,
      logHeartbeats: () => false,
    });
    try {
      expect(await waitUntil(() => server.count("register") === 1, 5_000)).toBe(true);
      if (code === 1000) {
        server.send("runner:outage-host", "phx_error");
        await new Promise((resolve) => setTimeout(resolve, 50));
        link.updateRegister({ ...register, cwd_allowlist: ["/updated"] });
      }
      await server.outage(mode, OUTAGE_MS, code);
      const recovered = await waitUntil(() => server.count("register") === 2, recoveryMs);
      expect(recovered, describeEvents(server.events)).toBe(true);
      if (code === 1000) {
        expect(server.events.filter((e) => e.event === "register").at(-1)
          ?.payload).toMatchObject({ cwd_allowlist: ["/updated"] });
      }
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
        5_000,
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
