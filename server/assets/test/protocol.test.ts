import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPersonaManifest,
  isReplyEnvelope,
  logOf,
  pendingPermissionFrom,
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

describe("pendingPermissionFrom (ADR-0022)", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-06-11T00:00:00Z",
    type: "state_change",
    state: "waiting_permission",
  };

  it("state_change.ext.pending_permission を絞り込む", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        pending_permission: {
          request_id: "req-1",
          tool_name: "Bash",
          input: { c: "ls" },
          ts: "2026-06-11T00:00:00Z",
        },
      },
    };
    expect(pendingPermissionFrom(envelope)).toEqual({
      request_id: "req-1",
      tool_name: "Bash",
      input: { c: "ls" },
      ts: "2026-06-11T00:00:00Z",
    });
  });

  it("waiting_permission 以外の state_change(thinking 等)でも ext に乗っていれば拾う", () => {
    // ADR-0022 F3 の主眼: pending は state_change 種別を問わず持続する。
    const envelope: Envelope = {
      ...base,
      state: "thinking",
      ext: {
        pending_permission: {
          request_id: "req-1",
          tool_name: "Bash",
          ts: "2026-06-11T00:00:00Z",
        },
      },
    };
    expect(pendingPermissionFrom(envelope)?.request_id).toBe("req-1");
  });

  it("ext 無し・pending_permission 無し・形不正は null", () => {
    expect(pendingPermissionFrom(base)).toBeNull();
    expect(pendingPermissionFrom({ ...base, ext: {} })).toBeNull();
    expect(
      pendingPermissionFrom({
        ...base,
        ext: { pending_permission: { tool_name: "Bash" } },
      }),
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
