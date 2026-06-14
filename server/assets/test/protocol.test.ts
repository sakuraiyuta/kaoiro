import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPersonaManifest,
  isReplyEnvelope,
  logOf,
  permissionRequestOf,
  resultOf,
} from "../src/lib/protocol";
import type { Envelope } from "../src/lib/protocol";

describe("fetchPersonaManifest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("マニフェスト JSON を返す", async () => {
    const manifest = { version: "abc", personas: {} };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => manifest })),
    );

    expect(await fetchPersonaManifest()).toEqual(manifest);
    expect(fetch).toHaveBeenCalledWith("/api/personas");
  });

  it("非 2xx は null(スプライトなし描画へフォールバック)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    expect(await fetchPersonaManifest()).toBeNull();
  });

  it("ネットワークエラーは null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await fetchPersonaManifest()).toBeNull();
  });
});

describe("permissionRequestOf", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-06-11T00:00:00Z",
    type: "permission_request",
    state: "waiting_permission",
  };

  it("permission_request の payload を絞り込む", () => {
    const envelope = {
      ...base,
      payload: { request_id: "req-1", tool_name: "Bash", input: { c: "ls" } },
    };
    expect(permissionRequestOf(envelope)).toEqual({
      request_id: "req-1",
      tool_name: "Bash",
      input: { c: "ls" },
    });
  });

  it("他 type / 不正 payload は null", () => {
    expect(permissionRequestOf({ ...base, type: "state_change" })).toBeNull();
    expect(permissionRequestOf(base)).toBeNull();
    expect(
      permissionRequestOf({ ...base, payload: { tool_name: "Bash" } }),
    ).toBeNull();
  });
});

describe("logOf / resultOf / isReplyEnvelope", () => {
  const log: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-06-11T00:00:00Z",
    type: "log",
    state: "thinking",
  };

  it("log payload を絞り込み、kind 無し・他 type は null", () => {
    expect(logOf({ ...log, payload: { kind: "assistant", text: "hi" } })).toEqual(
      { kind: "assistant", text: "hi" },
    );
    expect(logOf({ ...log, payload: { kind: "user", text: "go" } })).toEqual(
      { kind: "user", text: "go" },
    );
    expect(logOf({ ...log, payload: {} })).toBeNull();
    expect(logOf({ ...log, type: "state_change" })).toBeNull();
  });

  it("result payload を絞り込み、他 type は null", () => {
    expect(
      resultOf({
        ...log,
        type: "result",
        state: "done",
        payload: { text: "done", is_error: false },
      }),
    ).toEqual({ text: "done", is_error: false });
    expect(resultOf(log)).toBeNull();
  });

  it("isReplyEnvelope は log/result のみ true", () => {
    expect(isReplyEnvelope(log)).toBe(true);
    expect(isReplyEnvelope({ ...log, type: "result" })).toBe(true);
    expect(isReplyEnvelope({ ...log, type: "state_change" })).toBe(false);
    expect(isReplyEnvelope({ ...log, type: "permission_request" })).toBe(false);
  });
});
