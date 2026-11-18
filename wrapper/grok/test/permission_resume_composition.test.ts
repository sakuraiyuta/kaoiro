import "../../../scripts/test/fixtures/test-isolation.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { Envelope, PermissionControlExt, PermissionSyncMessage } from "@kaoiro/protocol";
import { ServerLink } from "@kaoiro/wrapper-core";
import { runGrokCli } from "../src/cli.js";
import { GrokHost } from "../src/host.js";
import { phoenixLoopback } from "./fixtures/phoenix_loopback.js";

// Projection shape: server/test/kaoiro_server/permission_settings_state_test.exs.
function joinSync(control: PermissionControlExt): PermissionSyncMessage {
  expect(control.status).toBe("applied");
  if (control.status !== "applied") throw new Error("Missing applied permission observation");
  return {
    version: "0",
    control: {
      revision: control.revision,
      requested: control.requested,
      constraints: control.constraints,
      status: "pending",
      last_effective: control.effective,
    },
    next: { revision: control.revision, requested: control.requested },
  };
}

it.each([
  ["danger-full-access", "operator"],
  ["danger-full-access", "inter-agent"],
  ["workspace-write", "operator"],
  ["workspace-write", "inter-agent"],
] as const)("resumes %s history and dispatches %s input", async (sandbox, channel) => {
  const cwd = mkdtempSync(join(tmpdir(), "kaoiro-grok-permission-resume-"));
  let saved: PermissionSyncMessage = { version: "0", control: null, next: null };
  try {
    for (const phase of ["fresh", "resume"] as const) {
      const server = await phoenixLoopback(() => ({ permission_sync: true }));
      const envelopes = () => server.received.filter(x => x.event === "envelope")
        .map(x => x.payload as unknown as Envelope);
      let host: GrokHost | undefined;
      const methods: string[] = [];
      const syncWait = vi.spyOn(ServerLink.prototype, "waitForPermissionSync");
      const syncApplied = vi.spyOn(GrokHost.prototype, "applyPermissionSync");
      const work = runGrokCli({
        cwd,
        parseCliArgs: () => ({ configPath: "fixture" }),
        loadConfig: () => ({ ...(phase === "resume" ? { resume_session_id: "fixture-session" } : {}),
          agent_id: "resume.grok",
          display_name: "Grok",
          persona: { id: "default", name: "Default", sprite_set: "default" },
          server_url: server.url,
          sandbox,
          network_access: true,
        }),
        createHost: options => new GrokHost({ ...options,
          executable: fileURLToPath(new URL("./fixtures/grok.mjs", import.meta.url)),
        }),
        onHostCreated: value => { host = value; },
        onMetadata: event => { if (event.direction === "out" && event.method) methods.push(event.method); },
      });
      void work.catch(() => {});
      try {
        await vi.waitFor(() => expect(server.joins).toBe(1));
        server.push("persona_prompt", { version: "0", prompt: "Fixture persona" });
        server.push("permission_sync", saved);
        await vi.waitFor(() => expect(host?.state).toBe("waiting_input"), { timeout: 5000 });
        expect(methods).toContain(phase === "resume" ? "session/resume" : "session/new");
        if (phase === "resume" && channel === "inter-agent") {
          server.push("envelope", {
            version: "0", type: "inter_agent_message", agent_id: "peer", display_name: "Peer",
            persona: { id: "default", name: "Default", sprite_set: "default" },
            ts: new Date().toISOString(), state: "idle",
            payload: { to: "resume.grok", conversation_id: "permission-resume", turn_number: 1,
              kind: "request", body: "RESUMED_INPUT", meta: { done: false, propose_next: "" } },
          });
        } else {
          server.push("instruction", { version: "0", text: "RESUMED_INPUT" });
        }
        await vi.waitFor(() => expect(syncWait).toHaveBeenCalled());
        let synchronized = false;
        void (syncWait.mock.results[0]!.value as Promise<void>).then(() => { synchronized = true; });
        await vi.waitFor(() => expect(synchronized, "permission sync must release the dispatch wait").toBe(true));
        await vi.waitFor(() => expect(envelopes().filter(x => x.type === "result"))
          .toHaveLength(1), { timeout: 5000 });
        expect(methods).toContain("session/prompt");
        expect(envelopes().some(x => x.type === "log" && x.payload.kind === "assistant" &&
          typeof x.payload.text === "string" && x.payload.text.length > 0)).toBe(true);
        if (phase === "resume" && channel === "inter-agent") {
          expect(envelopes().some(x => x.type === "inter_agent_message" && x.payload.body === "fixture reply")).toBe(true);
        } else {
          expect(envelopes().some(x => x.type === "log" && x.payload.kind === "assistant" &&
            x.payload.text === "RESUMED_INPUT")).toBe(true);
        }
        const result = envelopes().find(x => x.type === "result")!;
        expect(result.payload.is_error).toBe(false);
        expect(result.payload.error_subtype).toBeUndefined();
        expect(host!.state).toBe("waiting_input");
        const control = host!.statusExtSnapshot().permission_control as PermissionControlExt;
        if (phase === "resume") {
          const received = syncApplied.mock.calls[0]![0].control!.last_effective!;
          expect(received).toEqual(saved.control?.last_effective);
          expect(Object.hasOwn(received.permission, "enforcement"))
            .toBe(sandbox !== "danger-full-access");
        }
        saved = joinSync(control);
        const permission = saved.control!.last_effective!.permission;
        expect(Object.hasOwn(permission, "enforcement")).toBe(sandbox !== "danger-full-access");
        if (sandbox === "workspace-write") expect(permission.enforcement).toBe("os");
      } finally {
        syncWait.mockRestore();
        syncApplied.mockRestore();
        host?.close();
        try { await work; } finally { await server.close(); }
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);
