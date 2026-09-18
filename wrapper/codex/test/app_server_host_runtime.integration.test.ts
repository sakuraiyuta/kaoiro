import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppServerHostRuntime, type AppServerRuntimeHooks } from "../src/app_server_host_runtime.js";
import { beginPermissionExecution, createPermissionState, requestPermission, permissionObservationApplied } from "../src/permission_state.js";

// CLI startup may make outward update requests. Analytics/plugins are disabled;
// all model traffic and authentication in this test use the loopback fixture.
it("runs default runtime start/resume, next-turn policy, failed-switch rollback and interrupted-baseline retention", async () => {
  const home = await mkdtemp(join(tmpdir(), "fuji-348-runtime-live-"));
  const codexHome = join(home, ".codex");await mkdir(codexHome);
  let hold = false;
  const requests: Array<{ model: string; reasoning: { effort: string } }> = [];

  const server = createServer(async (request, response) => {
    let body = "";for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.at(-1)?.model === "broken") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Rejected fixture model", type: "invalid_request_error", code: "model_not_found" } }));return;
    }
    if (hold) return;
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
  const configure = (effort?: string) => writeFile(join(codexHome, "config.toml"), `model = "gpt-5.6-sol"
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
  let runtime: AppServerHostRuntime | undefined;
  const pendingNone = { model: null, effort: null, effortReset: false };
  let pending: { model: string | null; effort: string | null; effortReset: boolean } = pendingNone;
  let state = createPermissionState({ revision: 1, requested: { sandbox: "workspace-write", network_access: false } }, true);
  const projections: unknown[] = [];
  const hooks: AppServerRuntimeHooks = {
    snapshot: () => ({ pending, permission: state }), waitForPermissionSync: async () => {},
    onDispatch: attempt => { if (attempt.permission) state = beginPermissionExecution(state, attempt.permission.submission); },
    onPermission: result => { if (result.applied) state = permissionObservationApplied(state, result.observation).state; },
    onProjection: event => projections.push(event),
  };
  let count = 0;
  const run = async (status = "completed") => {
    const result = await runtime!.run({ input: "Reply OK", hostTurnToken: `host-${++count}` }, hooks);
    expect(result.terminal.status).toBe(status);
    expect(result.permission).toMatchObject({ applied: true, observation: { turn_id: result.identity.turnId, revision: state.current!.submission.revision } });
    return result;
  };
  try {
    await configure("medium");vi.stubEnv("CODEX_HOME", codexHome);vi.stubEnv("HOME", home);
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"]) vi.stubEnv(name, undefined);
    const options = { session: { thread: { cwd: home, sandbox: "read-only" as const }, turnSignal: () => null }, effortIntent: "default" as const };
    runtime = new AppServerHostRuntime(options);
    pending = { model: "gpt-6-astra", effort: "high", effortReset: false };
    const first = await run();
    expect(first.attempt.permission?.cursor.sessionId).toBeNull();
    expect(runtime.baseline).toEqual({ model: "gpt-6-astra", effort: "high", effortIntent: "explicit" });
    state = requestPermission(state, { revision: 2, requested: { sandbox: "workspace-write", network_access: true } });
    pending = { model: "gpt-5.6-sol", effort: null, effortReset: false };
    const second = await run();expect(second.permission).toMatchObject({ observation: { network_access: true } });
    pending = { model: "broken", effort: "low", effortReset: false };
    await run("failed");expect(runtime.baseline).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
    pending = pendingNone;await run();
    expect(requests.at(-1)).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort: "high" } });
    hold = true;pending = { model: "gpt-6-astra", effort: "low", effortReset: false };
    const stopped = run("interrupted");
    await vi.waitFor(() => expect(requests).toHaveLength(5), { timeout: 10_000 });
    expect(await runtime.interrupt("host-4")).toBe(false);
    expect(await runtime.interrupt("host-5")).toBe(true);
    await stopped;expect(runtime.baseline).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
    hold = false;pending = pendingNone;await run();
    expect(requests.at(-1)).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort: "high" } });
    await configure("low");pending = { model: null, effort: null, effortReset: true };await run();
    expect(runtime.baseline).toMatchObject({ effort: "low", effortIntent: "default" });
    const threadId = await runtime.open();expect(threadId).toBe(first.identity.threadId);
    // The live cursor reader has already observed each terminal before this shutdown.
    await runtime.close();runtime = new AppServerHostRuntime({ ...options, resumeThreadId: threadId });
    pending = pendingNone;const resumed = await run();
    expect(resumed.identity.threadId).toBe(threadId);
    expect(resumed.attempt.permission?.cursor.sessionId).toBe(threadId);
    expect(projections).toContainEqual(expect.objectContaining({ kind: "log" }));
    expect(projections).not.toContainEqual(expect.objectContaining({ kind: "result" }));
  } finally {
    await runtime?.close();vi.unstubAllEnvs();server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
