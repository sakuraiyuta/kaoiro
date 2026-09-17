import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { expect, it, vi } from "vitest";
import { CodexHost } from "../src/host.js";

it("keeps the default SDK factory non-interactive despite host auto_review", async () => {
  const root = await mkdtemp(join(tmpdir(), "fuji-357-approval-"));
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_approval_test", object: "response", status: "completed",
        output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No local port");
  const config = `approvals_reviewer = "auto_review"
model = "gpt-5.6-sol"
model_provider = "local"
[model_providers.local]
name = "Local test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
[features]
shell_snapshot = false
`;
  const observed = async (home: string) => {
    const sessions = join(home, "sessions");
    const paths = await readdir(sessions, { recursive: true });
    const contexts: Record<string, unknown>[] = [];
    for (const path of paths.filter((path) => path.endsWith(".jsonl"))) {
      for (const line of (await readFile(join(sessions, path), "utf8")).trim().split("\n")) {
        const entry = JSON.parse(line);
        if (entry.type === "turn_context") contexts.push(entry.payload);
      }
    }
    return contexts;
  };
  let host: CodexHost | undefined;
  let running: Promise<void> | undefined;
  try {
    const baseline = join(root, "baseline");
    const fixed = join(root, "fixed");
    for (const home of [baseline, fixed]) {
      await mkdir(home);
      await writeFile(join(home, "config.toml"), config);
    }
    // The CLI, not a hand-written config merger, supplies both observations.
    const control = new Codex({ env: { ...process.env, CODEX_HOME: baseline } });
    const { events } = await control.startThread({
      sandboxMode: "read-only", skipGitRepoCheck: true, workingDirectory: root,
    }).runStreamed("Reply OK without tools.", { signal: AbortSignal.timeout(10_000) });
    for await (const _event of events) {}
    expect(await observed(baseline)).toEqual([
      expect.objectContaining({ approval_policy: "on-request", approvals_reviewer: "auto_review" }),
    ]);

    vi.stubEnv("CODEX_HOME", fixed);
    vi.stubEnv("KAOIRO_CODEX_TURN_TRACE_DIR", join(root, "traces"));
    const states: Envelope[] = [];
    let ended = 0;
    const wrapperConfig: WrapperConfig = {
      agent_id: "test.approval-config", server_url: "ws://localhost:4000/wrapper",
      display_name: "Approval test", codex_auth_mode: "chatgpt", codex_chatgpt_plan: "plus", sandbox: "read-only", network_access: false,
      persona: { id: "test", name: "Test", sprite_set: "test" },
    };
    host = new CodexHost(wrapperConfig, {
      onState: (state) => states.push(state), appendSystemPrompt: "Reply OK without tools.",
      onTurnEnd: () => { ended += 1; },
      permissionSyncSupported: true, permissionRolloutRoot: join(fixed, "sessions"),
    });
    host.applyPermissionSync({ version: "0", control: null, next: null });
    running = host.run("first");
    await vi.waitFor(() => expect(ended).toBe(1), { timeout: 10_000 });
    expect(states.at(-1)?.ext.permission_control).toMatchObject({ status: "applied" });
    await host.send("second");
    await vi.waitFor(() => expect(ended).toBe(2), { timeout: 10_000 });
    expect(states.at(-1)?.ext.permission_control).toMatchObject({ status: "applied" });
    host.close();
    await running;
    const contexts = await observed(fixed);
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context).toMatchObject({ approval_policy: "never", approvals_reviewer: "user" });
    }
    expect(states.some((state) => state.state === "error")).toBe(false);
    expect(await readFile(join(fixed, "config.toml"), "utf8")).toBe(config);
  } finally {
    host?.close();
    await running;
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
