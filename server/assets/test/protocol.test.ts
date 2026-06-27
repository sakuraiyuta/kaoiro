import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACH_CHUNK_SIZE,
  buildChunkPayload,
  fetchPersonaManifest,
  hostIdFromAgentId,
  isReplyEnvelope,
  logOf,
  modelsFrom,
  parseHosts,
  parseSessions,
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

describe("modelsFrom (#54)", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-06-11T00:00:00Z",
    type: "state_change",
    state: "idle",
  };

  it("ext.models を ModelOption[] に整形する(effort_levels/description の有無)", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        models: [
          {
            value: "default",
            display_name: "Default",
            description: "d",
            effort_levels: ["low", "high", "max"],
          },
          { value: "haiku", display_name: "Haiku" },
        ],
      },
    };
    expect(modelsFrom(envelope)).toEqual([
      {
        value: "default",
        display_name: "Default",
        description: "d",
        effort_levels: ["low", "high", "max"],
      },
      { value: "haiku", display_name: "Haiku" },
    ]);
  });

  it("ext 無し・models 非配列・必須欠落エントリは除外し空配列", () => {
    expect(modelsFrom(base)).toEqual([]);
    expect(modelsFrom({ ...base, ext: {} })).toEqual([]);
    expect(modelsFrom({ ...base, ext: { models: "x" } })).toEqual([]);
    expect(
      modelsFrom({
        ...base,
        ext: { models: [{ value: "x" }, { display_name: "y" }] },
      }),
    ).toEqual([]);
  });

  it("effort_levels の非文字列要素は除去し、非配列は省略する", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        models: [
          { value: "m", display_name: "M", effort_levels: ["low", 3, "high"] },
          { value: "n", display_name: "N", effort_levels: "high" },
        ],
      },
    };
    const out = modelsFrom(envelope);
    expect(out[0]?.effort_levels).toEqual(["low", "high"]);
    expect(out[1]).not.toHaveProperty("effort_levels");
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

describe("parseHosts (#22)", () => {
  const mio = { id: "mio", name: "澪", sprite_set: "mio" };

  it("hosts マップを HostInfo 配列へ変換する", () => {
    expect(
      parseHosts({
        "lab-pc-1": {
          personas: [mio],
          cwd_allowlist: ["/home/user/proj"],
          capabilities: ["claude"],
          runner_pid: "ignored",
        },
      }),
    ).toEqual([
      {
        host_id: "lab-pc-1",
        personas: [mio],
        cwd_allowlist: ["/home/user/proj"],
        capabilities: ["claude"],
      },
    ]);
  });

  it("personas / cwd_allowlist が欠けるエントリは捨てる", () => {
    expect(
      parseHosts({
        bad: { personas: [mio] },
        ok: { personas: [mio], cwd_allowlist: ["/p"] },
      }),
    ).toEqual([
      { host_id: "ok", personas: [mio], cwd_allowlist: ["/p"] },
    ]);
  });

  it("マップでない値は空配列", () => {
    expect(parseHosts(null)).toEqual([]);
    expect(parseHosts(undefined)).toEqual([]);
  });
});

describe("parseSessions (#22 phase-1)", () => {
  it("session 候補を絞り込み optional メタを保つ", () => {
    expect(
      parseSessions([
        { session_id: "s1", summary: "作業A", mtime: "2026-06-24T00:00:00Z" },
        { session_id: "s2" },
        { summary: "no id" },
        "bad",
      ]),
    ).toEqual([
      { session_id: "s1", summary: "作業A", mtime: "2026-06-24T00:00:00Z" },
      { session_id: "s2" },
    ]);
  });

  it("配列でない値は空配列", () => {
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions({})).toEqual([]);
  });
});

describe("hostIdFromAgentId (#22 terminate routing)", () => {
  it("末尾ドット前を host_id として復元する", () => {
    expect(hostIdFromAgentId("lab-pc-1.AbC123")).toBe("lab-pc-1");
  });
  it("host_id 自体にドットがあっても最後のドットで分割する", () => {
    expect(hostIdFromAgentId("lab.pc.1.AbC123")).toBe("lab.pc.1");
  });
  it("ドット無しはそのまま返す(runner 不在=no-op)", () => {
    expect(hostIdFromAgentId("nodot")).toBe("nodot");
  });
});

describe("buildChunkPayload (ファイルアップロード wire, ADR-0025)", () => {
  function parse(buf: ArrayBuffer): {
    upload_id: string;
    chunk_index: number;
    bytes: Uint8Array;
  } {
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    const idLen = view.getUint32(0, false);
    const upload_id = new TextDecoder().decode(u8.subarray(4, 4 + idLen));
    const chunk_index = view.getUint32(4 + idLen, false);
    const bytes = u8.subarray(4 + idLen + 4);
    return { upload_id, chunk_index, bytes };
  }

  it("spec layout (u32 BE upload_id_len + utf8 id + u32 BE chunk_index + bytes) で組み立てる", () => {
    const buf = buildChunkPayload("u-7a3f", 2, new Uint8Array([1, 2, 3, 4]));
    const parsed = parse(buf);
    expect(parsed.upload_id).toBe("u-7a3f");
    expect(parsed.chunk_index).toBe(2);
    expect(Array.from(parsed.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("UTF-8 マルチバイト upload_id を運べる", () => {
    const buf = buildChunkPayload("う1", 0, new Uint8Array([9]));
    expect(parse(buf).upload_id).toBe("う1");
  });

  it("ATTACH_CHUNK_SIZE は spec 推奨の 64 KB", () => {
    expect(ATTACH_CHUNK_SIZE).toBe(64 * 1024);
  });
});
