import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPersonaManifest, permissionRequestOf } from "../src/lib/protocol";
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
