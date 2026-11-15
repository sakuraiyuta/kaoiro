import "../../../scripts/test/fixtures/test-isolation.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { GrokHost, type GrokHostOptions } from "../src/host.js";

// Turns Grok starts on its own (issue 1128), scripted by the fake grok.
const executable = fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url));
const config: WrapperConfig = {
  agent_id: "self-started-1128", display_name: "Self started", server_url: "ws://127.0.0.1:1/agent",
  persona: { id: "default", name: "Default", sprite_set: "default" },
  sandbox: "workspace-write", network_access: true,
};
vi.setConfig({ testTimeout: 20_000 });
const hosts: GrokHost[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) { host.close(); await host.closed; }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function started(extra: Partial<GrokHostOptions> = {}) {
  const root = mkdtempSync(join(homedir(), ".kaoiro-grok-1128-"));
  scratch.push(root);
  const events = join(root, "events.jsonl");
  const envelopes: Envelope[] = [];
  const asked: string[] = [];
  const turns = { started: 0, ended: 0 };
  const host = new GrokHost({
    config: { ...config }, cwd: root, personaPrompt: "fixture", executable,
    env: { ...process.env, KAOIRO_TEST_GROK_EVENTS: events },
    send: (e) => envelopes.push(e),
    decidePermission: async (title) => { asked.push(title); return { allow: true }; },
    onTurnStart: () => { turns.started += 1; },
    onTurnEnd: () => { turns.ended += 1; },
    ...extra,
  });
  hosts.push(host);
  const run = host.run();
  void run.catch(() => {});
  await vi.waitFor(() => expect(host.state).toBe("waiting_input"), { timeout: 10_000 });
  const rows = () => existsSync(events)
    ? readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const logs = (kind: string) => envelopes.filter((e) => e.type === "log" && e.payload.kind === kind);
  return {
    host, envelopes, rows, asked, turns,
    row: (event: string) => rows().find((r) => r.event === event),
    texts: (kind: string) => logs(kind).map((e) => String(e.payload.text ?? e.payload.tool_name)),
    results: () => envelopes.filter((e) => e.type === "result"),
    ext: () => host.statusExtSnapshot() as Record<string, any>,
  };
}
type Started = Awaited<ReturnType<typeof started>>;
const ENDED = "Grok's own turn ended";
const STARTED = "Grok started a turn on its own (a background task ended)";
const ended = (t: Started) =>
  vi.waitFor(() => expect(t.texts("system")).toContain(ENDED), { timeout: 10_000 });

describe("prompt ids", () => {
  it("names every prompt it sends with a fresh id", async () => {
    const t = await started();
    await t.host.send("one");
    await t.host.send("two");
    const ids = t.rows().filter((r) => r.event === "prompt_id").map((r) => r.promptId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^kaoiro-[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it("writes one stderr line when Grok answers under another prompt id", async () => {
    const t = await started();
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    await t.host.send("no-prompt-id");
    expect(lines.filter((l) => l.includes("answered under another prompt id"))).toHaveLength(1);
  });
});

describe("a turn Grok starts while kaoiro is idle", () => {
  it("is shown as logs, refused its permission, and never becomes a kaoiro turn", async () => {
    const t = await started();
    await t.host.send("arm-foreign");
    const statesBefore = t.envelopes.filter((e) => e.type === "state_change").length;
    await ended(t);
    expect(t.texts("system")).toEqual([
      STARTED,
      "Refused a permission request from a turn Grok started on its own: foreign tool",
      ENDED,
    ]);
    expect(t.texts("assistant").join("")).toContain("FOREIGN_TEXT");
    expect(t.texts("tool_use")).toContain("foreign tool");
    expect(t.row("foreign-permission-response")?.outcome).toBe("cancelled");
    expect(t.asked).toEqual([]);
    expect(t.envelopes.filter((e) => e.type === "permission_request")).toEqual([]);
    expect(t.results()).toHaveLength(1);
    expect(t.turns).toEqual({ started: 1, ended: 1 });
    expect(t.envelopes.filter((e) => e.type === "state_change")).toHaveLength(statesBefore);
  });

  it("is cancelled by an interrupt, which starts no abort timer", async () => {
    const t = await started();
    await t.host.send("arm-foreign-hold");
    await vi.waitFor(() => expect(t.texts("system")).toContain(STARTED));
    await t.host.interrupt();
    await ended(t);
    expect(t.rows().filter((r) => r.event === "cancel").map((r) => r.target)).toEqual(["foreign"]);
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    expect(t.host.state).toBe("waiting_input");
    await t.host.send("still-open");
    expect(t.results().at(-1)?.payload.text).toBe("still-open");
  });

  it("sends nothing on an interrupt when nothing runs", async () => {
    const t = await started();
    await t.host.send("idle");
    await t.host.interrupt();
    expect(t.rows().filter((r) => r.event === "cancel")).toEqual([]);
  });
});

describe("a turn Grok starts while the operator's prompt waits", () => {
  it("keeps its text and permission out of the operator's turn", async () => {
    const t = await started();
    await t.host.send("foreign-during");
    expect(t.results().at(-1)?.payload.text).toBe("OWN_TEXT");
    expect(t.row("foreign-permission-response")?.outcome).toBe("cancelled");
    // Positive control: the own call in the same run still reaches the operator.
    expect(t.asked).toEqual(["own tool"]);
    expect(t.row("own-permission-response")?.outcome).toBe("selected");
    expect(t.texts("system")).toEqual([
      STARTED,
      "Refused a permission request from a turn Grok started on its own: foreign tool",
      ENDED,
    ]);
    expect(t.texts("assistant").join("")).toContain("FOREIGN_TEXT");
  });

  it("cancels the self-started turn, then the own prompt once it runs, without closing", async () => {
    const t = await started();
    const turn = t.host.send("foreign-interrupt");
    await vi.waitFor(() => expect(t.texts("system")).toContain(STARTED));
    await t.host.interrupt();
    await turn;
    expect(t.rows().filter((r) => r.event === "cancel").map((r) => r.target)).toEqual(["foreign", "own"]);
    expect(t.results().at(-1)?.ext).toMatchObject({ stop_reason: "cancelled", interrupted: true });
    expect(t.results().at(-1)?.payload.text).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    await t.host.send("still-open");
    expect(t.results().at(-1)?.payload.text).toBe("still-open");
  });

  it("treats a turn opened by its update as running when interrupted before the queue notice", async () => {
    const t = await started();
    const turn = t.host.send("foreign-interrupt-early");
    await vi.waitFor(() => expect(t.texts("system")).toContain(STARTED));
    await t.host.interrupt();
    await turn;
    expect(t.rows().filter((r) => r.event === "cancel").map((r) => r.target)).toEqual(["foreign", "own"]);
    expect(t.results().at(-1)?.ext).toMatchObject({ stop_reason: "cancelled", interrupted: true });
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    await t.host.send("still-open");
    expect(t.results().at(-1)?.payload.text).toBe("still-open");
  });
});

describe("permission ownership", () => {
  it("refuses a request whose tool call was never seen", async () => {
    const t = await started();
    await t.host.send("permission-unknown");
    expect(t.row("unknown-permission-response")?.outcome).toBe("cancelled");
    expect(t.asked).toEqual([]);
  });

  it.each(["permission-update-only", "permission-bare-tool-call"])(
    "does not take ownership from a weaker record (%s)", async (scene) => {
      const t = await started();
      await t.host.send(scene);
      expect(t.row("weak-permission-response")?.outcome).toBe("cancelled");
      expect(t.asked).toEqual([]);
    });
});

describe("token readings", () => {
  it("publishes a self-started turn's reading when it ends", async () => {
    const t = await started();
    await t.host.send("arm-foreign");
    expect(t.ext().context).toMatchObject({ used_tokens: 1110 });
    await ended(t);
    await vi.waitFor(() => expect(t.ext().context).toMatchObject({ used_tokens: 7000 }));
  });
});
