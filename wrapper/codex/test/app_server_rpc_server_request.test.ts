import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AppServerConnectionError, AppServerRpc, type AppServerServerRequest, type RpcObject,
} from "../src/app_server_rpc.js";
import { parseApprovalRequest } from "../src/app_server_approval.js";
import { fakeChild, harness, settle, THREAD } from "./app_server_approval_harness.js";

function rig(maxServerRequestIds?: number) {
  const f = fakeChild();
  const requests: AppServerServerRequest[] = [];
  const failures: Error[] = [];
  const rpc = new AppServerRpc({
    spawnChild: () => f.child, shutdownTimeoutMs: 10,
    ...(maxServerRequestIds === undefined ? {} : { maxServerRequestIds }),
    onServerRequest: request => requests.push(request),
    onFailure: error => failures.push(error),
  });
  const ask = (id: number | string) => f.send({ id, method: "item/commandExecution/requestApproval", params: {} });
  return { f, rpc, requests, failures, ask };
}

describe("AppServerRpc server requests", () => {
  it("hands each request to the hook with a typed key and answers only through respond", async () => {
    const { f, rpc, requests, ask } = rig();
    ask(1); ask("1"); await settle();
    expect(requests.map(r => [r.id, r.key])).toEqual([[1, "n:1"], ["1", "s:1"]]);
    expect(f.replies()).toEqual([]);
    expect(rpc.respond(1, { decision: "accept" })).toBe(true);
    await settle();
    expect(f.replies()).toEqual([{ id: 1, result: { decision: "accept" } }]);
    await rpc.close();
  });

  it("writes nothing once failed", async () => {
    const { f, rpc } = rig();
    await rpc.close();
    expect(rpc.failed).toBe(true);
    expect(rpc.respond(1, { decision: "accept" })).toBe(false);
    expect(rpc.respondError(1, { code: -32601, message: "x" })).toBe(false);
    expect(f.replies()).toEqual([]);
  });

  it("fails the connection on a reused id without answering it", async () => {
    const { f, requests, failures, ask } = rig();
    ask(0); await settle();
    ask(0); await settle();
    expect(requests).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(AppServerConnectionError);
    expect((failures[0] as AppServerConnectionError).kind).toBe("protocol");
    expect(f.replies()).toEqual([]);
  });

  it("keeps every id below the bound and fails at the request that would exceed it", async () => {
    const { f, requests, failures, ask } = rig(3);
    ask(0); ask(1); ask(2); await settle();
    expect(requests).toHaveLength(3);
    expect(failures).toEqual([]);
    ask(3); await settle();
    expect(requests).toHaveLength(3);
    expect((failures[0] as AppServerConnectionError).kind).toBe("protocol");
    expect(f.replies()).toEqual([]);
  });

  it("detects a duplicate of an early id just below the bound (nothing is evicted)", async () => {
    const { requests, failures, ask } = rig(3);
    ask(0); ask(1); await settle();
    ask(0); await settle();
    expect(requests).toHaveLength(2);
    expect((failures[0] as AppServerConnectionError).kind).toBe("protocol");
  });
});

// Candidate-native capture; only the scratch prefix is normalized for privacy.
// availableDecisions is experimental-schema-only; decline is a stable response.
// A pin bump must remeasure the request, decline reply and terminal outcome.
describe("the captured command approval shape on the pinned Codex", () => {
  const lines = readFileSync(new URL("./fixtures/app_server_approval_decline_0.161.0.jsonl", import.meta.url), "utf8")
    .trim().split("\n").map(raw => JSON.parse(raw) as { dir: string; line: string })
    .map(({ dir, line }) => ({ dir, message: JSON.parse(line) as RpcObject }));

  const metadata = JSON.parse(readFileSync(new URL("./fixtures/app_server_approval_decline_0.161.0.metadata.json", import.meta.url), "utf8")) as {
    version: string; native_version: string; native_sha256: string; fixture_sha256: string; initialize: { userAgent: string };
  };
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  function validateCapture(candidate: typeof metadata): void {
    if (candidate.version !== pkg.dependencies["@openai/codex"]) throw new Error("Capture version differs from the installed pin");
    expect(candidate.native_version).toBe(`codex-cli ${candidate.version}`);
    expect(candidate.initialize.userAgent).toContain(`/${candidate.version} `);
    expect(candidate.native_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.fixture_sha256).toBe(createHash("sha256").update(readFileSync(new URL("./fixtures/app_server_approval_decline_0.161.0.jsonl", import.meta.url))).digest("hex"));
  }

  it("is measured on the pinned version with an intact capture", () => {
    expect(pkg.dependencies["@openai/codex-sdk"]).toBe(pkg.dependencies["@openai/codex"]);
    validateCapture(metadata);
  });

  it("rejects a stale capture even when the remaining metadata is valid", () => {
    expect(() => validateCapture({ ...metadata, version: "0.160.0" })).toThrow("Capture version differs from the installed pin");
  });

  it("offers no decline in availableDecisions, and a decline reply leaves the item declined", () => {
    const request = lines[0]!.message;
    const params = request.params as RpcObject;
    expect(params.availableDecisions).toEqual([
      "accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch", "<scratch>/outside/target.txt"] } }, "cancel",
    ]);
    expect(params.availableDecisions).not.toContain("decline");
    expect(lines[1]).toEqual({ dir: "out", message: { id: 0, result: { decision: "decline" } } });
    expect(lines[2]!.message).toMatchObject({ method: "serverRequest/resolved", params: { requestId: 0 } });
    expect(lines[3]!.message).toMatchObject({ method: "item/completed", params: { item: { id: params.itemId, status: "declined" } } });
    expect(lines[4]!.message).toMatchObject({ method: "turn/completed", params: { turn: { status: "completed" } } });
  });

  it("parses, and an operator deny answers it with decline", async () => {
    const request = lines[0]!.message;
    expect(parseApprovalRequest(String(request.method), request.params)).not.toBeNull();
    const params = request.params as RpcObject;
    const h = await harness();
    await h.reserve();
    h.startNamed(String(params.turnId)); await settle();
    h.f.send({ ...request, params: { ...params, threadId: THREAD } });
    await settle();
    expect(h.slots.at(-1)).toMatchObject({ tool_name: "codex:command_execution" });
    h.decideAll(false); await settle();
    expect(h.f.replies()).toEqual([lines[1]!.message]);
    await h.finish();
  });
});
