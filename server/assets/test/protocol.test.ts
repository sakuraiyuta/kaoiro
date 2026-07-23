import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineCatalogResult } from "../src/lib/protocol";
import {
  ATTACH_CHUNK_SIZE,
  buildChunkPayload,
  fetchPersonaManifest,
  fanOutInterAgentHistory,
  formatAgentLabel,
  hostIdFromAgentId,
  interAgentMessageOf,
  isReplyEnvelope,
  logOf,
  mergeTranscriptEntries,
  modelsFrom,
  modelSwitchStateFrom,
  switchErrorFrom,
  parseDirectory,
  parseHosts,
  parseSessions,
  pendingPermissionFrom,
  pendingQuestionFrom,
  parseHistoryReset,
  resultOf,
  resetTranscriptHistory,
  resumeDriftFrom,
  parseSessionResetCompleted,
  parseSessionResetFailed,
  parseSessionResetStarted,
  sessionCapabilitiesFrom,
  sessionResetAvailability,
  shouldInterceptAsSessionReset,
  userInputDialogAvailability,
} from "../src/lib/protocol";
import type { Envelope, SessionCapabilities } from "../src/lib/protocol";

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

describe("pendingQuestionFrom (ADR-0027)", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-07-03T00:00:00Z",
    type: "state_change",
    state: "waiting_question",
  };
  const questions = [
    {
      question: "どれ?",
      header: "選択",
      multiSelect: false,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    },
  ];

  it("state_change.ext.pending_question を絞り込む", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        pending_question: {
          request_id: "q-1",
          questions,
          ts: "2026-07-03T00:00:00Z",
        },
      },
    };
    expect(pendingQuestionFrom(envelope)?.request_id).toBe("q-1");
    expect(pendingQuestionFrom(envelope)?.questions).toEqual(questions);
  });

  it("waiting_question 以外の state_change でも ext に乗っていれば拾う", () => {
    const envelope: Envelope = {
      ...base,
      state: "tool_running",
      ext: { pending_question: { request_id: "q-1", questions } },
    };
    expect(pendingQuestionFrom(envelope)?.request_id).toBe("q-1");
  });

  it("ext 無し・pending_question 無し・questions 非配列は null", () => {
    expect(pendingQuestionFrom(base)).toBeNull();
    expect(pendingQuestionFrom({ ...base, ext: {} })).toBeNull();
    expect(
      pendingQuestionFrom({
        ...base,
        ext: { pending_question: { request_id: "q-1", questions: "no" } },
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
            default_effort: "high",
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
        default_effort: "high",
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

  it("isReplyEnvelope は log/result/inter_agent_message/session_boundary が true", () => {
    expect(isReplyEnvelope(log)).toBe(true);
    expect(isReplyEnvelope({ ...log, type: "result" })).toBe(true);
    expect(isReplyEnvelope({ ...log, type: "inter_agent_message" })).toBe(true);
    // phase-17 17-7: session_boundary は transcript 用 marker で
    // latest-state map を上書きしない。review round 1 finding 対応。
    expect(isReplyEnvelope({ ...log, type: "session_boundary" })).toBe(true);
    expect(isReplyEnvelope({ ...log, type: "state_change" })).toBe(false);
    expect(isReplyEnvelope({ ...log, type: "permission_request" })).toBe(false);
  });
});

describe("interAgentMessageOf (protocol-inter-agent, phase-8)", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "agent-a",
    ts: "2026-06-29T00:00:00Z",
    type: "inter_agent_message",
    state: "tool_running",
  };

  it("to/kind/body を備えた inter_agent_message を返す", () => {
    const env: Envelope = {
      ...base,
      payload: {
        to: "agent-b",
        conversation_id: "cnv-1",
        turn_number: 2,
        kind: "propose",
        body: "CSV にしよう",
        meta: { done: false, propose_next: "B の意見" },
        owner: { kind: "user", id: "operator" },
      },
    };
    const out = interAgentMessageOf(env);
    expect(out?.to).toBe("agent-b");
    expect(out?.kind).toBe("propose");
    expect(out?.body).toBe("CSV にしよう");
  });

  it("型違いの envelope や payload 欠落は null", () => {
    expect(interAgentMessageOf({ ...base, type: "log" })).toBeNull();
    // base にそもそも payload は無いのでスプレッドのみで「payload 欠落」を表現
    // (exactOptionalPropertyTypes 下で `payload: undefined` を渡すと型エラー)。
    expect(interAgentMessageOf({ ...base })).toBeNull();
    expect(
      interAgentMessageOf({ ...base, payload: { to: "b", kind: "propose" } }),
    ).toBeNull();
  });
});

describe("inter-agent history replay (#105)", () => {
  const message: Envelope = {
    version: "0",
    agent_id: "agent-a",
    ts: "2026-07-13T05:00:00Z",
    type: "inter_agent_message",
    state: "idle",
    payload: {
      to: "agent-b",
      conversation_id: "cnv-105",
      turn_number: 1,
      kind: "inform",
      body: "復元対象",
    },
  };
  const log: Envelope = {
    ...message,
    ts: "2026-07-13T04:59:00Z",
    type: "log",
  };

  it("sender-keyed history を sender と receiver の両 transcript へ展開する", () => {
    const expanded = fanOutInterAgentHistory({ "agent-a": [message, log] });
    expect(expanded["agent-a"]).toEqual([log, message]);
    expect(expanded["agent-b"]).toEqual([message]);
  });

  it("issue #109: receiver の clear watermark が envelope.ts 以上なら peer pane から drop", () => {
    // agent-b (receiver) の watermark が envelope.ts と同じ → drop (<=)。
    const expanded = fanOutInterAgentHistory(
      { "agent-a": [message] },
      { "agent-b": message.ts },
    );
    // sender pane (server で既に filter 済みだが、client fanOut は sender
    // pane 由来のエントリを丸ごと入れる、そこは既存挙動と一致)。
    expect(expanded["agent-a"]).toEqual([message]);
    // receiver pane では drop されているので key 自体が生えない。
    expect(expanded["agent-b"]).toBeUndefined();
  });

  it("issue #109: receiver の watermark が envelope.ts より古ければ peer pane に届く", () => {
    const older = "2026-07-13T04:00:00Z"; // message.ts (05:00:00Z) より前
    const expanded = fanOutInterAgentHistory(
      { "agent-a": [message] },
      { "agent-b": older },
    );
    expect(expanded["agent-b"]).toEqual([message]);
  });

  it("issue #109: 該当 pane に watermark 未設定なら従来どおり fanOut される (regression pin)", () => {
    const expanded = fanOutInterAgentHistory(
      { "agent-a": [message] },
      { "unrelated-agent": "2999-01-01T00:00:00Z" },
    );
    expect(expanded["agent-b"]).toEqual([message]);
  });

  it("resume history_reset では inter-agent envelope だけを保持する", () => {
    expect(resetTranscriptHistory([log, message], true)).toEqual([message]);
  });

  it("clear history_reset では inter-agent envelope も消去する", () => {
    expect(resetTranscriptHistory([log, message], false)).toEqual([]);
  });

  it("history_reset flag の省略は preserve=true として後方互換にする", () => {
    expect(parseHistoryReset({ agent_id: "agent-a" })).toEqual({
      agent_id: "agent-a",
      preserve_inter_agent: true,
    });
    expect(
      parseHistoryReset({
        agent_id: "agent-a",
        preserve_inter_agent: false,
      }),
    ).toEqual({ agent_id: "agent-a", preserve_inter_agent: false });
  });

  it("durable IA と SPA 残留 log を timestamp 順に merge する", () => {
    const ia2 = { ...message, ts: "2026-07-13T05:00:02Z", seq: 2 };
    const ia4 = { ...message, ts: "2026-07-13T05:00:04Z", seq: 4 };
    const log1 = { ...log, ts: "2026-07-13T05:00:01Z", seq: 1 };
    const log3 = { ...log, ts: "2026-07-13T05:00:03Z", seq: 3 };
    const log5 = { ...log, ts: "2026-07-13T05:00:05Z", seq: 5 };

    expect(
      mergeTranscriptEntries([ia2, ia4], [log1, log3, log5]).map((e) => e.seq),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("history_reset 後の逐次 replay log を保持 IA の間へ挿入する", () => {
    const ia2 = { ...message, ts: "2026-07-13T05:00:02Z", seq: 2 };
    const ia4 = { ...message, ts: "2026-07-13T05:00:04Z", seq: 4 };
    const replay = [
      { ...log, ts: "2026-07-13T05:00:01Z", seq: 1 },
      { ...log, ts: "2026-07-13T05:00:03Z", seq: 3 },
      { ...log, ts: "2026-07-13T05:00:05Z", seq: 5 },
    ];
    let transcript = resetTranscriptHistory([ia2, ia4], true);
    for (const envelope of replay) {
      transcript = mergeTranscriptEntries(transcript, [envelope]);
    }

    expect(transcript.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("history と buffered の重複 envelope は一度だけ保持する", () => {
    expect(mergeTranscriptEntries([log, message], [log, message])).toEqual([
      log,
      message,
    ]);
  });

  it("別 sender の同 ts/seq/type envelope は fan-out transcript で潰さない", () => {
    const fromB = { ...message, agent_id: "agent-b", seq: 7 };
    const fromC = { ...message, agent_id: "agent-c", seq: 7 };
    expect(mergeTranscriptEntries([fromB], [fromC])).toEqual([fromB, fromC]);
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

describe("parseDirectory (ADR-0030)", () => {
  const mio = { id: "mio", name: "澪", sprite_set: "mio" };

  it("directory マップを DirectoryEntry の Record へ変換する", () => {
    expect(
      parseDirectory({
        "lab-pc-1.rev1": { persona: mio, last_seen: 1_720_000_000 },
        "lab-pc-1.rev2": { persona: mio, last_seen: null },
      }),
    ).toEqual({
      "lab-pc-1.rev1": { persona: mio, last_seen: 1_720_000_000 },
      "lab-pc-1.rev2": { persona: mio, last_seen: null },
    });
  });

  it("persona 欠落 / 不正な entry は捨てる", () => {
    expect(
      parseDirectory({
        bad_no_persona: { last_seen: 1 },
        bad_persona_null: { persona: null, last_seen: 1 },
        bad_persona_no_id: { persona: { name: "x" }, last_seen: 1 },
        ok: { persona: mio, last_seen: 1 },
      }),
    ).toEqual({
      ok: { persona: mio, last_seen: 1 },
    });
  });

  it("last_seen が number でなければ null 化する", () => {
    expect(
      parseDirectory({
        agent: { persona: mio, last_seen: "not-a-number" },
      }),
    ).toEqual({
      agent: { persona: mio, last_seen: null },
    });
  });

  it("マップでない値は空 record", () => {
    expect(parseDirectory(null)).toEqual({});
    expect(parseDirectory(undefined)).toEqual({});
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

describe("formatAgentLabel (name(id) helper)", () => {
  const persona = { id: "ao", name: "あお", sprite_set: "ao" };
  function makeEnvelope(id: string, name?: string): Envelope {
    return {
      version: "0",
      agent_id: id,
      ts: "2026-06-29T00:00:00Z",
      type: "state_change",
      state: "idle",
      ...(name !== undefined ? { persona: { ...persona, name } } : {}),
    };
  }

  it("persona.name と id が揃っていれば name(id) 形式", () => {
    const agents = { "lab.alpha": makeEnvelope("lab.alpha", "あお") };
    expect(formatAgentLabel(agents, "lab.alpha")).toBe("あお(lab.alpha)");
  });

  it("persona 未登録の id は bare id を返す", () => {
    expect(formatAgentLabel({}, "lab.unknown")).toBe("lab.unknown");
  });

  it("name が無い envelope は bare id を返す", () => {
    const agents = {
      "lab.beta": {
        version: "0",
        agent_id: "lab.beta",
        ts: "x",
        type: "state_change",
        state: "idle",
      } as Envelope,
    };
    expect(formatAgentLabel(agents, "lab.beta")).toBe("lab.beta");
  });

  it("synthetic server sender は server だけを返す", () => {
    expect(formatAgentLabel({}, "server")).toBe("server");
  });

  it("name が id と同一の冗長ケースは name 単体に畳む", () => {
    const id = "lab.same";
    const agents = { [id]: makeEnvelope(id, id) };
    expect(formatAgentLabel(agents, id)).toBe(id);
  });
});

describe("resumeDriftFrom (ADR-0014 F1 addendum, phase-15 D8)", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-07-12T00:00:00Z",
    type: "state_change",
    state: "idle",
  };

  it("ext.resume_drift 未 stamp (fresh spawn) は null", () => {
    expect(resumeDriftFrom(base)).toBeNull();
    expect(resumeDriftFrom({ ...base, ext: {} })).toBeNull();
  });

  it("clean resume は空配列を返す", () => {
    const envelope: Envelope = { ...base, ext: { resume_drift: [] } };
    expect(resumeDriftFrom(envelope)).toEqual([]);
  });

  it("drift エントリを field/prev/now でパースする", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        resume_drift: [
          { field: "model", prev: "claude-opus-4-7", now: "claude-sonnet-4-6" },
          { field: "network_access", prev: false, now: true },
        ],
      },
    };
    expect(resumeDriftFrom(envelope)).toEqual([
      { field: "model", prev: "claude-opus-4-7", now: "claude-sonnet-4-6" },
      { field: "network_access", prev: false, now: true },
    ]);
  });

  it("field が欠けた malformed entry は落として残りを返す", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        resume_drift: [
          { field: "model", prev: "a", now: "b" },
          { prev: "x", now: "y" },
          "not-an-object",
          { field: "sandbox", prev: undefined, now: "workspace-write" },
        ],
      },
    };
    expect(resumeDriftFrom(envelope)).toEqual([
      { field: "model", prev: "a", now: "b" },
      { field: "sandbox", prev: undefined, now: "workspace-write" },
    ]);
  });

  it("ext.resume_drift が配列でなければ null (fresh spawn 扱い)", () => {
    const envelope: Envelope = {
      ...base,
      ext: { resume_drift: "unexpected" },
    };
    expect(resumeDriftFrom(envelope)).toBeNull();
  });
});

describe("modelSwitchStateFrom (ADR-0035 F3)", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-07-13T00:00:00Z",
    type: "state_change",
    state: "idle",
  };

  it("pending / effort reset / rollback error を防御的に読む", () => {
    expect(
      modelSwitchStateFrom({
        ...base,
        ext: {
          pending_model: "gpt-sol",
          pending_effort: "high",
          effort_reset: true,
          switch_error: {
            kind: "model",
            requested: "bad-slug",
            reason: "turn_failed",
            rolled_back_to: "gpt-terra",
          },
        },
      }),
    ).toEqual({
      pending_model: "gpt-sol",
      pending_effort: "high",
      effort_reset: true,
      switch_error: {
        kind: "model",
        requested: "bad-slug",
        reason: "turn_failed",
        rolled_back_to: "gpt-terra",
      },
    });
  });

  it("未指定・malformed は fail-closed default", () => {
    expect(
      modelSwitchStateFrom({
        ...base,
        ext: {
          pending_model: 1,
          effort_reset: "true",
          switch_error: { kind: "model", reason: "unknown" },
        },
      }),
    ).toEqual({
      pending_model: null,
      pending_effort: null,
      effort_reset: false,
      switch_error: null,
    });
  });

  it("switchErrorFrom はreasonを開いたstringとして保持する", () => {
    expect(
      switchErrorFrom({
        ...base,
        ext: {
          switch_error: {
            kind: "effort",
            requested: "ultra",
            reason: "future_reason",
          },
        },
      }),
    ).toEqual({
      kind: "effort",
      requested: "ultra",
      reason: "future_reason",
    });
  });
});

describe("sessionCapabilitiesFrom (ADR-0034 F1/F2)", () => {
  const base: Envelope = {
    version: "0",
    agent_id: "a",
    ts: "2026-07-12T00:00:00Z",
    type: "state_change",
    state: "idle",
  };

  it("ext.session_capabilities 未 stamp は null (fail-closed)", () => {
    expect(sessionCapabilitiesFrom(base)).toBeNull();
    expect(sessionCapabilitiesFrom({ ...base, ext: {} })).toBeNull();
  });

  it("両 boolean field が揃えばパース (Claude 相当)", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
    });
  });

  it("supports_context_usage は tri-state を保存し malformed は drop (ADR-0040)", () => {
    // absent は field を出力しない — svelte 側で `=== undefined` が hide 判定。
    // explicit true / false は保存されて 3-state 分岐に流れる。
    const absent: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
        },
      },
    };
    expect(sessionCapabilitiesFrom(absent)?.supports_context_usage).toBeUndefined();

    const supported: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_context_usage: true,
        },
      },
    };
    expect(sessionCapabilitiesFrom(supported)?.supports_context_usage).toBe(true);

    const unsupported: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: false,
          supports_user_input_dialog: true,
          supports_context_usage: false,
        },
      },
    };
    expect(sessionCapabilitiesFrom(unsupported)?.supports_context_usage).toBe(
      false,
    );

    // malformed (non-boolean) は field を drop、fail-closed で absent 相当。
    const malformed: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_context_usage: "true",
        },
      },
    };
    expect(
      sessionCapabilitiesFrom(malformed)?.supports_context_usage,
    ).toBeUndefined();
  });

  it("model / effort switch capability は boolean のみ保持し未指定は fail-closed", () => {
    const advertised: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: false,
          supports_user_input_dialog: true,
          supports_model_switch: true,
          supports_effort_switch: false,
        },
      },
    };
    expect(sessionCapabilitiesFrom(advertised)).toEqual({
      supports_attachments: false,
      supports_user_input_dialog: true,
      supports_model_switch: true,
      supports_effort_switch: false,
    });

    const malformed: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: false,
          supports_user_input_dialog: true,
          supports_model_switch: "true",
          supports_effort_switch: 1,
        },
      },
    };
    const parsed = sessionCapabilitiesFrom(malformed);
    expect(parsed?.supports_model_switch === true).toBe(false);
    expect(parsed?.supports_effort_switch === true).toBe(false);
  });

  it("Codex 相当: image-only attachment capability を保持する", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          attachment_types: ["image"],
          supports_user_input_dialog: true,
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      attachment_types: ["image"],
      supports_user_input_dialog: true,
    });
  });

  it("attachment_types は closed vocabulary にし、unknown は空 restriction として fail-closed", () => {
    const envelope: Envelope = {
      ...base,
      ext: { session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        attachment_types: ["image", "pdf"],
      } },
    };
    expect(sessionCapabilitiesFrom(envelope)?.attachment_types).toEqual(["image"]);
    expect(sessionCapabilitiesFrom({ ...envelope, ext: { session_capabilities: {
      supports_attachments: true, supports_user_input_dialog: true, attachment_types: ["pdf"],
    } } })?.attachment_types).toEqual([]);
  });

  it("boolean が欠けたら null (partial 判定は許可しない)", () => {
    const envelope: Envelope = {
      ...base,
      ext: { session_capabilities: { supports_attachments: true } },
    };
    expect(sessionCapabilitiesFrom(envelope)).toBeNull();
  });

  it("user_input_modes は string 配列だけ pass、malformed は drop", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          user_input_modes: ["default", 42, "plan", null],
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
      user_input_modes: ["default", "plan"],
    });
  });

  it("user_input_modes が空配列なら field 省略 (unconditional 扱い)", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          user_input_modes: [],
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
    });
  });

  it("supports_session_reset=false は field を保持 (明示 unsupported)", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: false,
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_session_reset: false,
    });
  });

  it("supports_session_reset=true + valid modes 配列を保持", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: true,
          session_reset_modes: ["new", "clear"],
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
    });
  });

  it("supports_session_reset=true + modes 未指定は fail-closed (両 field drop)", () => {
    // ADR-0036 F5: true + missing/empty modes は invalid advertisement。
    // parser は両 field を drop し、availability judge が "unsupported" に
    // 落ちる (SessionCapabilities 自体は valid のまま他 capability を保持)。
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: true,
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
    });
  });

  it("supports_session_reset=true + 空 modes は fail-closed (両 field drop)", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: true,
          session_reset_modes: [],
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
    });
  });

  it("session_reset_modes の malformed 要素は drop、残り non-empty で保持", () => {
    const envelope: Envelope = {
      ...base,
      ext: {
        session_capabilities: {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: true,
          session_reset_modes: ["new", "invalid", null, "clear"],
        },
      },
    };
    expect(sessionCapabilitiesFrom(envelope)).toEqual({
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
    });
  });
});

describe("sessionResetAvailability (ADR-0036 F5, phase-17)", () => {
  it("caps=null なら unsupported (fail-closed)", () => {
    expect(sessionResetAvailability(null, "new")).toBe("unsupported");
    expect(sessionResetAvailability(null, "clear")).toBe("unsupported");
  });

  it("supports_session_reset 未指定なら unsupported", () => {
    expect(
      sessionResetAvailability(
        { supports_attachments: true, supports_user_input_dialog: true },
        "new",
      ),
    ).toBe("unsupported");
  });

  it("supports_session_reset=false なら unsupported", () => {
    expect(
      sessionResetAvailability(
        {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: false,
        },
        "new",
      ),
    ).toBe("unsupported");
  });

  it("supports=true + modes=[] (parser drop 後の invalid) は unsupported", () => {
    expect(
      sessionResetAvailability(
        {
          supports_attachments: true,
          supports_user_input_dialog: true,
          supports_session_reset: true,
          session_reset_modes: [],
        },
        "new",
      ),
    ).toBe("unsupported");
  });

  it("supports=true + 要求 mode が modes に含まれれば on", () => {
    const caps: SessionCapabilities = {
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_session_reset: true,
      session_reset_modes: ["new", "clear"],
    };
    expect(sessionResetAvailability(caps, "new")).toBe("on");
    expect(sessionResetAvailability(caps, "clear")).toBe("on");
  });

  it("supports=true でも要求 mode が modes に無ければ conditional-off", () => {
    const capsOnlyNew: SessionCapabilities = {
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_session_reset: true,
      session_reset_modes: ["new"],
    };
    expect(sessionResetAvailability(capsOnlyNew, "clear")).toBe(
      "conditional-off",
    );
    const capsOnlyClear: SessionCapabilities = {
      supports_attachments: true,
      supports_user_input_dialog: true,
      supports_session_reset: true,
      session_reset_modes: ["clear"],
    };
    expect(sessionResetAvailability(capsOnlyClear, "new")).toBe(
      "conditional-off",
    );
  });
});

describe("userInputDialogAvailability (ADR-0034 F3, phase-15 D5)", () => {
  it("caps が null なら unsupported (fail-closed)", () => {
    expect(userInputDialogAvailability(null, "default")).toBe("unsupported");
    expect(userInputDialogAvailability(null, null)).toBe("unsupported");
  });

  it("supports_user_input_dialog=false なら unsupported", () => {
    expect(
      userInputDialogAvailability(
        { supports_attachments: true, supports_user_input_dialog: false },
        "default",
      ),
    ).toBe("unsupported");
  });

  it("user_input_modes 未指定なら unconditional on", () => {
    expect(
      userInputDialogAvailability(
        { supports_attachments: true, supports_user_input_dialog: true },
        "default",
      ),
    ).toBe("on");
    // currentMode が null でも user_input_modes 未指定なら on
    expect(
      userInputDialogAvailability(
        { supports_attachments: true, supports_user_input_dialog: true },
        null,
      ),
    ).toBe("on");
  });

  it("user_input_modes に currentMode が含まれれば on", () => {
    expect(
      userInputDialogAvailability(
        {
          supports_attachments: true,
          supports_user_input_dialog: true,
          user_input_modes: ["default", "plan"],
        },
        "plan",
      ),
    ).toBe("on");
  });

  it("user_input_modes 指定 + currentMode 非該当なら conditional-off", () => {
    expect(
      userInputDialogAvailability(
        {
          supports_attachments: true,
          supports_user_input_dialog: true,
          user_input_modes: ["default"],
        },
        "bypassPermissions",
      ),
    ).toBe("conditional-off");
    // currentMode が null なら照合が成立しないので conditional-off
    expect(
      userInputDialogAvailability(
        {
          supports_attachments: true,
          supports_user_input_dialog: true,
          user_input_modes: ["default"],
        },
        null,
      ),
    ).toBe("conditional-off");
  });
});

describe("shouldInterceptAsSessionReset (ADR-0036 F1, phase-17 17-8)", () => {
  const supportedCaps: SessionCapabilities = {
    supports_attachments: true,
    supports_user_input_dialog: true,
    supports_session_reset: true,
    session_reset_modes: ["new", "clear"],
  };

  it("exact /new + no attachments + capability on → 'new'", () => {
    expect(shouldInterceptAsSessionReset("/new", undefined, supportedCaps)).toBe("new");
    expect(shouldInterceptAsSessionReset("/new", [], supportedCaps)).toBe("new");
  });

  it("exact /clear + no attachments + capability on → 'clear'", () => {
    expect(shouldInterceptAsSessionReset("/clear", undefined, supportedCaps)).toBe(
      "clear",
    );
  });

  it("trim 前後空白 (/new に空白) も intercept", () => {
    expect(shouldInterceptAsSessionReset("  /new\n", undefined, supportedCaps)).toBe(
      "new",
    );
  });

  it("引数付き /new hello は通常 instruction (fall through)", () => {
    expect(shouldInterceptAsSessionReset("/new hello", undefined, supportedCaps)).toBeNull();
  });

  it("attachment 付き /new は通常 instruction (fall through)", () => {
    expect(shouldInterceptAsSessionReset("/new", ["u1"], supportedCaps)).toBeNull();
  });

  it("caps null (旧 wrapper) は fall through", () => {
    expect(shouldInterceptAsSessionReset("/new", undefined, null)).toBeNull();
  });

  it("supports=false は fall through", () => {
    expect(
      shouldInterceptAsSessionReset("/new", undefined, {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_session_reset: false,
      }),
    ).toBeNull();
  });

  it("mode 非対応 (modes に new 無し) の /new は fall through", () => {
    expect(
      shouldInterceptAsSessionReset("/new", undefined, {
        supports_attachments: true,
        supports_user_input_dialog: true,
        supports_session_reset: true,
        session_reset_modes: ["clear"],
      }),
    ).toBeNull();
  });

  it("空文字 / 通常 text は fall through", () => {
    expect(shouldInterceptAsSessionReset("", undefined, supportedCaps)).toBeNull();
    expect(
      shouldInterceptAsSessionReset("ふつうの指示です", undefined, supportedCaps),
    ).toBeNull();
  });
});

describe("parseSessionResetStarted (ADR-0036 F7, phase-17 17-9)", () => {
  it("valid payload を型付きで返す", () => {
    expect(
      parseSessionResetStarted({
        request_id: "rs_1",
        agent_id: "a.1",
        mode: "new",
        previous_session_id: "sess-old",
      }),
    ).toEqual({
      request_id: "rs_1",
      agent_id: "a.1",
      mode: "new",
      previous_session_id: "sess-old",
    });
  });

  it("previous_session_id 省略も許容", () => {
    expect(
      parseSessionResetStarted({
        request_id: "rs_1",
        agent_id: "a.1",
        mode: "clear",
      }),
    ).toEqual({ request_id: "rs_1", agent_id: "a.1", mode: "clear" });
  });

  it("mode 不正は null (fail-closed)", () => {
    expect(
      parseSessionResetStarted({
        request_id: "rs_1",
        agent_id: "a.1",
        mode: "restart",
      }),
    ).toBeNull();
  });

  it("非 object / 必須 field 欠落は null", () => {
    expect(parseSessionResetStarted(null)).toBeNull();
    expect(parseSessionResetStarted("x")).toBeNull();
    expect(parseSessionResetStarted({ request_id: "x", mode: "new" })).toBeNull();
  });
});

describe("parseSessionResetCompleted (ADR-0036 F7, phase-17 17-9)", () => {
  it("valid + to_session_id string", () => {
    expect(
      parseSessionResetCompleted({
        request_id: "rs_1",
        agent_id: "a.1",
        mode: "new",
        previous_session_id: "sess-old",
        to_session_id: "sess-new",
      }),
    ).toEqual({
      request_id: "rs_1",
      agent_id: "a.1",
      mode: "new",
      previous_session_id: "sess-old",
      to_session_id: "sess-new",
    });
  });

  it("to_session_id=null (Codex lazy) も許容", () => {
    expect(
      parseSessionResetCompleted({
        request_id: "rs_2",
        agent_id: "a.2",
        mode: "new",
        to_session_id: null,
      }),
    ).toEqual({
      request_id: "rs_2",
      agent_id: "a.2",
      mode: "new",
      to_session_id: null,
    });
  });

  it("mode 不正は null", () => {
    expect(
      parseSessionResetCompleted({
        request_id: "rs_1",
        agent_id: "a.1",
        mode: "reset",
        to_session_id: null,
      }),
    ).toBeNull();
  });
});

describe("parseSessionResetFailed (ADR-0036 F7, phase-17 17-9)", () => {
  it("valid + closed vocab reason", () => {
    expect(
      parseSessionResetFailed({
        request_id: "rs_1",
        agent_id: "a.1",
        mode: "new",
        reason: "spawn_failed",
      }),
    ).toEqual({
      request_id: "rs_1",
      agent_id: "a.1",
      mode: "new",
      reason: "spawn_failed",
    });
  });

  it("closed vocab 外の reason は null (fail-closed)", () => {
    expect(
      parseSessionResetFailed({
        request_id: "rs_1",
        agent_id: "a.1",
        mode: "new",
        reason: "not-in-vocab",
      }),
    ).toBeNull();
  });

  it("必須 field 欠落は null", () => {
    expect(
      parseSessionResetFailed({ request_id: "rs_1", agent_id: "a.1", mode: "new" }),
    ).toBeNull();
  });
});

describe("EngineCatalogResult (Option E, ADR-0039)", () => {
  // parseCatalogResult は module-private だが channel.on 経由でしか触れない。
  // 型の shape 契約を pin する: 必須 field / optional field の presence を
  // client 側でも保証。
  it("EngineCatalogResult 型に必須 field / optional field が揃っている", () => {
    const ok: EngineCatalogResult = {
      host_id: "lab-1",
      engine: "claude-code",
      request_id: "req-1",
      ok: true,
      models_count: 6,
    };
    const fail: EngineCatalogResult = {
      host_id: "lab-1",
      engine: "claude-code",
      request_id: "req-2",
      ok: false,
      reason: "auth_failed",
    };
    expect(ok.ok).toBe(true);
    expect(fail.reason).toBe("auth_failed");
  });
});
