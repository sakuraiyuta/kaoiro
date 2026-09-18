import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerSession } from "../src/app_server_session.js";
import type { AppServerTurn } from "../src/app_server_transport.js";
import { appServerSettingsForAttempt, appServerSettingsAfterSuccess, type AppServerSettingsIntent, type AppServerPendingSettings, type AppServerPreparedSettings } from "../src/app_server_settings.js";
import { captureAppServerPermission, observeAppServerPermission, type AppServerPermissionAttempt } from "../src/app_server_permission.js";
import { createPermissionState, beginPermissionExecution, requestPermission, permissionObservationApplied } from "../src/permission_state.js";
import { codexPermissionContextAfter } from "../src/rollout.js";

// CLI startup may make outward update requests. Analytics/plugins are disabled;
// all model traffic and authentication in this test use the loopback fixture.
it("observes terminal policy before closing the default child and restores settings after a failed switch", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-permission-live-"));
  const requests: Array<{ model: string; reasoning: { effort: string } }> = [];

  const server = createServer(async (request, response) => {
    let body = "";for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.at(-1)?.model === "broken") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Rejected fixture model", type: "invalid_request_error", code: "model_not_found" } }));return;
    }
    const id = `response-${requests.length}`;
    const item = { id: `answer-${requests.length}`, type: "message", role: "assistant", phase: "final_answer", status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();if (!address || typeof address === "string") throw new Error("No local port");
  const configure = (effort?: string) => writeFile(join(home, "config.toml"), `model = "gpt-5.6-sol"
approvals_reviewer = "auto_review"
model_provider = "local"
${effort ? `model_reasoning_effort = "${effort}"` : ""}
[model_providers.local]
name = "Local control test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
plugins = false
[analytics]
enabled = false
`);
  let session: AppServerSession | undefined;
  async function terminal(turn: AppServerTurn, status: string) {
    const events = [];for await (const event of turn.events) events.push(event);
    expect(events.filter(e => e.method === "turn/completed")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ id: turn.identity.turnId, status }) }) }),
    ]);
  }
  async function context(turn: AppServerTurn) {
    // Read before child shutdown and without a history RPC that could flush storage.
    let found: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      for (const path of (await readdir(join(home, "sessions"), { recursive: true })).filter(p => p.endsWith(".jsonl"))) {
        const lines = (await readFile(join(home, "sessions", path), "utf8")).split("\n");
        for (const line of lines.slice(0, -1).filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.type === "turn_context" && record.payload.turn_id === turn.identity.turnId) found = record.payload;
        }
      }
      expect(found).toBeDefined();
    }, { timeout: 1000, interval: 25 });
    expect(found).toMatchObject({ approval_policy: "never", approvals_reviewer: "user" });
    return found!;
  }
  try {
    await configure("medium");vi.stubEnv("CODEX_HOME", home);vi.stubEnv("HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
    session = await AppServerSession.create({ thread: { cwd: home, sandbox: "read-only" }, turnSignal: () => null });
    const threadId = await session.startThread();
    expect(session.initialSettings).toEqual({ model: "gpt-5.6-sol", effort: "medium" });
    let baseline: AppServerSettingsIntent = { ...session.initialSettings!, effortIntent: "default" };
    let state = createPermissionState({ revision: 1, requested: { sandbox: "workspace-write", network_access: false } }, true);
    let count = 0;
    let receipt: AppServerPreparedSettings = {};
    let attempt: AppServerPermissionAttempt;
    const noPending = { model: null, effort: null, effortReset: false };
    const start = (pending: AppServerPendingSettings, rollback = false) => {
      const selection = state.next;
      return session!.startTurn({ threadId, hostTurnToken: `host-${++count}`, input: "Reply OK",
        settings: { ...appServerSettingsForAttempt(baseline, pending, rollback),
          permission: { sandbox: selection.requested.sandbox, networkAccess: selection.requested.network_access } },
        beforeDispatch: async () => {},
        onDispatch: (identity, settings) => {
          receipt = settings;
          attempt = captureAppServerPermission(join(home, "sessions"), state, selection, identity, count === 1);
          state = beginPermissionExecution(state, attempt.submission);
        },
      });
    };
    const firstPending = { model: "gpt-6-astra", effort: "high", effortReset: false };
    const first = await start(firstPending);await terminal(first, "completed");
    const firstAttempt = attempt!;
    const observed = await observeAppServerPermission(firstAttempt, first.identity, () => state);
    expect(observed, JSON.stringify(firstAttempt)).toMatchObject({ applied: true, observation: {
      turn_id: first.identity.turnId, permission: { sandbox: "workspace-write", approval: "never", enforcement: "os" }, network_access: false,
    } });
    if (!observed?.applied) throw new Error("Missing live observation");
    state = permissionObservationApplied(state, observed.observation).state;
    baseline = appServerSettingsAfterSuccess(baseline, firstPending, receipt);
    await configure("low");
    state = requestPermission(state, { revision: 2, requested: { sandbox: "workspace-write", network_access: true } });
    const nextPending = { model: "gpt-5.6-sol", effort: null, effortReset: false };
    const changed = await start(nextPending);await terminal(changed, "completed");
    expect(await context(changed)).toMatchObject({ model: "gpt-5.6-sol", effort: "high", sandbox_policy: { type: "workspace-write", network_access: true } });
    expect((await observeAppServerPermission(attempt!, changed.identity, () => state))?.applied).toBe(true);
    expect(codexPermissionContextAfter(attempt!.cursor, threadId, first.identity.turnId)).toBeNull();
    baseline = appServerSettingsAfterSuccess(baseline, nextPending, receipt);
    const failed = await start({ model: "broken", effort: "low", effortReset: false });await terminal(failed, "failed");
    const rollback = await start(noPending, true);await terminal(rollback, "completed");
    expect(await context(rollback)).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
    const resetPending = { model: null, effort: null, effortReset: true };
    const reset = await start(resetPending);await terminal(reset, "completed");
    baseline = appServerSettingsAfterSuccess(baseline, resetPending, receipt);
    expect(baseline).toMatchObject({ effort: "low", effortIntent: "default" });
    await configure("medium");
    const defaults = await start(noPending, true);await terminal(defaults, "completed");
    baseline = appServerSettingsAfterSuccess(baseline, noPending, receipt, true);
    expect(baseline.effort).toBe("medium");
    expect(requests.map(r => [r.model, r.reasoning.effort])).toEqual([
      ["gpt-6-astra", "high"], ["gpt-5.6-sol", "high"], ["broken", "low"],
      ["gpt-5.6-sol", "high"], ["gpt-5.6-sol", "low"], ["gpt-5.6-sol", "medium"],
    ]);
    expect(session.stderrTail).not.toMatch(/unknown.config/i);
  } finally {
    await session?.close();vi.unstubAllEnvs();server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
