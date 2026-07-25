import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineCatalogResult } from "../src/lib/protocol";
import {
  ATTACH_CHUNK_SIZE,
  buildChunkPayload,
  errorSubtypeLabel,
  fetchPersonaManifest,
  fanOutInterAgentHistory,
  findPrecedingUserPrompt,
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
  parseHistoryReplayComplete,
  parseHistoryReset,
  parseHistoryPayload,
  filterInterAgentTargetsByWatermark,
  filterAfterHistoryCleared,
  mergeHistories,
  projectAndMergeHistory,
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

  it("ふじ R3 (2026-07-23): fanOutInterAgentHistory は legacy-server branch — sender-keyed history を receiver pane にも複製する", () => {
    // R3 で復活: modern server は `history_projection: 'per-pane-v1'` を
    // 立てて pre-fan-out 済み payload を送る → client は fanOut スキップ。
    // 旧 server (marker 無し) の payload は sender-keyed のみなので、
    // client がこの関数で receiver pane へ fanOut する。この test は
    // 後者の legacy branch を pin する。
    const senderKeyed = { "agent-a": [log, message] };
    const out = fanOutInterAgentHistory(senderKeyed);
    // sender pane はそのまま。
    expect(out["agent-a"]).toEqual([log, message]);
    // receiver pane に IA だけが複製される (log は fanOut 対象外)。
    expect(out["agent-b"]).toEqual([message]);
  });

  it("ふじ R3: legacy branch の fanOut では receiver 側 watermark が envelope.ts 以降なら drop", () => {
    // pre-M6 の server は sender-keyed history のみを送ってきて、client
    // が receiver 側 filter を担っていた。marker-less rolling upgrade で
    // その旧 semantics に戻る場面の pin。
    const senderKeyed = { "agent-a": [message] };
    const out = fanOutInterAgentHistory(senderKeyed, {
      "agent-b": "2099-01-01T00:00:00Z",
    });
    // sender pane は影響なし。
    expect(out["agent-a"]).toEqual([message]);
    // receiver pane は watermark >= envelope.ts で drop → key なし。
    expect(out["agent-b"]).toBeUndefined();
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

  it("resume replay completion は agent_id と replay_id が揃う場合だけ受け取る", () => {
    expect(
      parseHistoryReplayComplete({ agent_id: "agent-a", replay_id: "replay-1" }),
    ).toEqual({ agent_id: "agent-a", replay_id: "replay-1" });
    expect(parseHistoryReplayComplete({ agent_id: "agent-a" })).toBeNull();
    expect(parseHistoryReplayComplete({ replay_id: "replay-1" })).toBeNull();
  });

  it("server synthetic IA は同 ts/seq でも recipient ごとに merge で別行を保つ", () => {
    const first: Envelope = {
      ...message,
      agent_id: "server",
      session_id: "quota-session",
      seq: 42,
      payload: { ...message.payload!, to: "agent-a" },
    };
    const second: Envelope = {
      ...first,
      payload: { ...first.payload!, to: "agent-b" },
    };
    expect(mergeTranscriptEntries([], [first, second])).toEqual([first, second]);
  });

  // ふじ R3 must-fix (2026-07-23): projection marker で rolling upgrade
  // の両方向を pin する。marker あり = new server pre-fanned、marker
  // 無し = old server sender-keyed のみ → client が fanOut を担当。
  describe("parseHistoryPayload (R3 projection marker)", () => {
    it("new server: history_projection=per-pane-v1 を通す", () => {
      const parsed = parseHistoryPayload({
        agents: { "agent-a": [message] },
        clear_watermarks: { "agent-a": "2026-07-23T15:00:00Z" },
        history_projection: "per-pane-v1",
      });
      expect(parsed.projection).toBe("per-pane-v1");
      expect(parsed.histories["agent-a"]).toEqual([message]);
      expect(parsed.clearWatermarks["agent-a"]).toBe("2026-07-23T15:00:00Z");
    });

    it("old server: history_projection 未同梱なら projection=undefined (legacy 分岐)", () => {
      const parsed = parseHistoryPayload({
        agents: { "agent-a": [message] },
        clear_watermarks: {},
      });
      expect(parsed.projection).toBeUndefined();
      expect(parsed.histories["agent-a"]).toEqual([message]);
    });

    it("garbage な history_projection 値は undefined に落として safe-legacy 分岐", () => {
      // 非文字列 / 空文字列 は legacy 扱い。fanOut を再走行しても既に
      // fan-out 済みデータには影響しないが、fan-out 未済みなら receiver
      // pane を組み立てないと表示落ちする → 迷ったら legacy が安全。
      const parsed = parseHistoryPayload({
        agents: { "agent-a": [message] },
        history_projection: 42,
      });
      expect(parsed.projection).toBeUndefined();
    });

    it("payload 全体が壊れていても空 map を返す (fail-safe)", () => {
      expect(parseHistoryPayload(null)).toEqual({
        histories: {},
        clearWatermarks: {},
      });
      expect(parseHistoryPayload("string")).toEqual({
        histories: {},
        clearWatermarks: {},
      });
    });
  });

  // ふじ R4 must-fix (2026-07-23): live 経路の best-effort watermark
  // filter を pin。server pre-fanout は reload 経路の authoritative filter、
  // live は wire ts を watermark 文字列と比較する best-effort 版。
  describe("R4 live watermark filter", () => {
    it("filterInterAgentTargetsByWatermark: pane watermark が envelope.ts 以上なら pane を drop", () => {
      const kept = filterInterAgentTargetsByWatermark(
        message, // message.ts = "2026-07-13T05:00:00Z"
        ["agent-a", "agent-b"],
        {
          "agent-a": "2026-07-14T00:00:00Z",
          "agent-b": "2026-01-01T00:00:00Z",
        },
      );
      // agent-a は watermark > ts で drop。agent-b は watermark < ts で keep。
      expect(kept).toEqual(["agent-b"]);
    });

    it("filterInterAgentTargetsByWatermark: watermark 未設定 pane は常に keep", () => {
      const kept = filterInterAgentTargetsByWatermark(
        message,
        ["agent-a", "agent-b"],
        {},
      );
      expect(kept).toEqual(["agent-a", "agent-b"]);
    });

    it("filterInterAgentTargetsByWatermark: 同 ts (境界) は drop (server の <= と semantics 一致)", () => {
      const kept = filterInterAgentTargetsByWatermark(
        message,
        ["agent-a"],
        { "agent-a": message.ts },
      );
      expect(kept).toEqual([]);
    });

    it("filterAfterHistoryCleared: 旧 session の非 IA は session_id filter で drop", () => {
      const stale = { ...log, session_id: "sess-old" };
      const current = { ...log, session_id: "sess-cur" };
      const kept = filterAfterHistoryCleared([stale, current], "sess-cur");
      expect(kept).toEqual([current]);
    });

    it("filterAfterHistoryCleared: 同 session の IA でも boundary >= ts なら drop (R4 helper 仕様)", () => {
      // 実機検収 2 (2026-07-23) 以降、`clearWatermark` 引数の意味は
      // 「clear 時点」から「A の現行 session 開始 (=IA 表示 boundary)」に
      // shift 済み。 pre-boundary IA が同 session_id でも drop される
      // 挙動は helper level では不変 (呼び手の意味が変わっただけ)。
      const preBoundary = {
        ...message,
        ts: "2026-07-13T05:00:00Z",
        session_id: "sess-cur",
      };
      const postBoundary = {
        ...message,
        ts: "2026-07-13T07:00:00Z",
        session_id: "sess-cur",
      };
      const kept = filterAfterHistoryCleared(
        [preBoundary, postBoundary],
        "sess-cur",
        "2026-07-13T06:00:00Z",
      );
      expect(kept).toEqual([postBoundary]);
    });

    it("filterAfterHistoryCleared: watermark 未指定なら watermark filter は無効", () => {
      const ia = { ...message, session_id: "sess-cur" };
      const kept = filterAfterHistoryCleared([ia], "sess-cur");
      expect(kept).toEqual([ia]);
    });

    it("filterAfterHistoryCleared: 非 IA は watermark filter を bypass (session_id filter のみ)", () => {
      // log は clear watermark に関係なく session_id で判断される
      // (session_id === sess-cur なら残る)。
      const nonIa = { ...log, session_id: "sess-cur" };
      const kept = filterAfterHistoryCleared(
        [nonIa],
        "sess-cur",
        "2099-01-01T00:00:00Z",
      );
      expect(kept).toEqual([nonIa]);
    });
  });

  // ふじ A2 must-fix (2026-07-23, 3rd review): R3 が生む 4 象限 (new/old
  // client × new/old server) を production helper 1 本で通す合成 table
  // test。App.svelte の onHistory glue は現状:
  //   const projected = projection === "per-pane-v1"
  //     ? histories
  //     : fanOutInterAgentHistory(histories, clearWatermarks);
  //   logs = mergeHistories(projected, logs);
  // これを test 側で再現し、e503 の markerless-per-pane 中間版
  // (server が pre-fan out しつつ marker を立てない実装、R3 前の状態)
  // も含めて全経路で visible transcript が正しくなることを pin する。
  describe("R3 4 象限 composite (parse → project → merge)", () => {
    // IA の 1 turn。sender = agent-a, receiver = agent-b。
    const ia: Envelope = {
      version: "0",
      agent_id: "agent-a",
      ts: "2026-07-23T05:00:00Z",
      seq: 1,
      type: "inter_agent_message",
      state: "tool_running",
      payload: {
        to: "agent-b",
        conversation_id: "cid-comp",
        turn_number: 1,
        kind: "inform",
        body: "hello",
      },
    };

    // App.svelte onHistory の glue と 1 対 1 対応する compose 関数。
    // ふじ 4th advisory 2 (2026-07-23): production helper
    // `projectAndMergeHistory` を呼ぶだけの薄いラッパ。App の glue も
    // 同じ helper を呼ぶので、この test は本物の production 経路を
    // 通しで pin することになる (旧版は fanOut/merge を手動合成して
    // いたので drift 余地があった)。
    function applyOnHistory(
      payload: unknown,
      local: Record<string, Envelope[]> = {},
    ): Record<string, Envelope[]> {
      const parsed = parseHistoryPayload(payload);
      return projectAndMergeHistory(
        parsed.histories,
        parsed.clearWatermarks,
        parsed.projection,
        local,
      );
    }

    it("quadrant 1: new server + new client (marker=per-pane-v1, direct merge)", () => {
      // server pre-fan-out 済み: sender pane / receiver pane 双方に copy 済み。
      const payload = {
        agents: { "agent-a": [ia], "agent-b": [ia] },
        clear_watermarks: {},
        history_projection: "per-pane-v1",
      };
      const merged = applyOnHistory(payload);
      expect(merged["agent-a"]).toEqual([ia]);
      expect(merged["agent-b"]).toEqual([ia]);
    });

    it("quadrant 2: new server + old client (marker=per-pane-v1 だが client 側 fanOut 走る) → dedupe で 1 copy", () => {
      // 「old client」= marker を無視して常に fanOut する挙動を再現するた
      // め、marker を undefined にしたのと等価な payload を渡す (=
      // marker present でも client が旧経路を走る shape)。
      // このケースは new server が既に receiver pane に配った copy と
      // client fanOut が生む receiver copy が identity key で dedupe
      // されるため、最終的に receiver pane に 1 copy だけ残る。
      const payload = {
        agents: { "agent-a": [ia], "agent-b": [ia] },
        clear_watermarks: {},
        // marker を落として old-client の behavior を強制。
      };
      const merged = applyOnHistory(payload);
      expect(merged["agent-a"]).toEqual([ia]);
      // dedupe が効くので 1 copy のみ (fanOut が同じ envelope を追加
      // 積みしても identity key で潰される)。
      expect(merged["agent-b"]).toEqual([ia]);
    });

    it("quadrant 3: old server + new client (marker absent → fanOut fallback で receiver pane を組み立てる)", () => {
      // 旧 server は sender-keyed history のみ送る (受信 pane 未組立)。
      // 新 client が marker absent を検知して fanOut fallback を走らせ、
      // receiver pane に copy を追加する。
      const payload = {
        agents: { "agent-a": [ia] },
        clear_watermarks: {},
      };
      const merged = applyOnHistory(payload);
      expect(merged["agent-a"]).toEqual([ia]);
      expect(merged["agent-b"]).toEqual([ia]);
    });

    it("quadrant 4: old server + old client (baseline, marker absent → fanOut で receiver pane 組立)", () => {
      // 前 R3 状態と等価。新 client の marker-absent 分岐がこの挙動を
      // 保存していることを直接 pin (quadrant 3 と同 payload、同結果)。
      const payload = {
        agents: { "agent-a": [ia] },
        clear_watermarks: {},
      };
      const merged = applyOnHistory(payload);
      expect(merged["agent-a"]).toEqual([ia]);
      expect(merged["agent-b"]).toEqual([ia]);
    });

    it("e503 中間版 (server pre-fan-out 済み だが marker 未添付) + new client → dedupe で receiver 1 copy", () => {
      // R3 の regression が実際に起きた中間 build 状態: server は per-pane
      // 化していたが marker を送っていなかったので、new client が
      // fanOut fallback に落ちて receiver pane を 2 重に組立てるはず。
      // でも identity key dedupe が働くので visible には 1 copy。
      // (それでも protocol 標識を欠かすと意味論が曖昧なので R3 で
      // marker を追加した、という regression pin)
      const payload = {
        agents: { "agent-a": [ia], "agent-b": [ia] },
        clear_watermarks: {},
      };
      const merged = applyOnHistory(payload);
      expect(merged["agent-a"]).toEqual([ia]);
      expect(merged["agent-b"]).toEqual([ia]);
    });

    it("local 側 live-buffer との merge も pane ごとに identity dedupe される", () => {
      // 実運用: join と history push の間に onEnvelope で live IA が
      // 届いていることがある。history 到達時に merge して同じ envelope
      // が 2 度描画されないことを pin (mergeHistories の invariant)。
      const payload = {
        agents: { "agent-a": [ia], "agent-b": [ia] },
        clear_watermarks: {},
        history_projection: "per-pane-v1",
      };
      const local: Record<string, Envelope[]> = {
        "agent-a": [ia],
        "agent-b": [ia],
      };
      const merged = applyOnHistory(payload, local);
      expect(merged["agent-a"]).toEqual([ia]);
      expect(merged["agent-b"]).toEqual([ia]);
    });
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

  it("clear_watermark 文字列は保持 (ADR-0036 F3 復元, 2026-07-24)", () => {
    expect(
      parseSessionResetCompleted({
        request_id: "rs_3",
        agent_id: "a.3",
        mode: "clear",
        to_session_id: "sess-new",
        clear_watermark: "2026-07-24T00:00:00.000Z",
      }),
    ).toEqual({
      request_id: "rs_3",
      agent_id: "a.3",
      mode: "clear",
      to_session_id: "sess-new",
      clear_watermark: "2026-07-24T00:00:00.000Z",
    });
  });

  it("clear_watermark が空文字/非文字列/欠落なら key を落とす", () => {
    expect(
      parseSessionResetCompleted({
        request_id: "rs_4",
        agent_id: "a.4",
        mode: "clear",
        to_session_id: null,
        clear_watermark: "",
      }),
    ).toEqual({
      request_id: "rs_4",
      agent_id: "a.4",
      mode: "clear",
      to_session_id: null,
    });

    expect(
      parseSessionResetCompleted({
        request_id: "rs_5",
        agent_id: "a.5",
        mode: "new",
        to_session_id: null,
      }),
    ).toEqual({
      request_id: "rs_5",
      agent_id: "a.5",
      mode: "new",
      to_session_id: null,
    });
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

describe("errorSubtypeLabel (issue #127)", () => {
  it("既知の 4 subtype を日本語ラベルに変換", () => {
    expect(errorSubtypeLabel("error_max_turns")).toBe("最大ターン数到達");
    expect(errorSubtypeLabel("error_during_execution")).toBe("実行中エラー");
    expect(errorSubtypeLabel("error_max_budget_usd")).toBe("予算上限到達");
    expect(errorSubtypeLabel("error_max_structured_output_retries")).toBe(
      "構造化出力リトライ上限",
    );
  });

  it("未知 / 空 / undefined は null (caller 側で omit または fallback)", () => {
    expect(errorSubtypeLabel(undefined)).toBeNull();
    expect(errorSubtypeLabel("")).toBeNull();
    expect(errorSubtypeLabel("some_new_subtype")).toBeNull();
  });
});

describe("findPrecedingUserPrompt (issue #128)", () => {
  function userLog(seq: number, text: string): Envelope {
    return {
      version: "0",
      agent_id: "agent-a",
      session_id: "s1",
      ts: `2026-07-25T00:00:0${seq}Z`,
      seq,
      type: "log",
      state: "thinking",
      payload: { kind: "user", text },
    } as unknown as Envelope;
  }

  function assistantLog(seq: number, text: string): Envelope {
    return {
      version: "0",
      agent_id: "agent-a",
      session_id: "s1",
      ts: `2026-07-25T00:00:0${seq}Z`,
      seq,
      type: "log",
      state: "thinking",
      payload: { kind: "assistant", text },
    } as unknown as Envelope;
  }

  function errorResult(seq: number): Envelope {
    return {
      version: "0",
      agent_id: "agent-a",
      session_id: "s1",
      ts: `2026-07-25T00:00:0${seq}Z`,
      seq,
      type: "result",
      state: "error",
      payload: { is_error: true, error_subtype: "error_during_execution" },
    } as unknown as Envelope;
  }

  it("直近の user log の text を返す (同 turn 内)", () => {
    const entries = [
      userLog(1, "問題を解いて"),
      assistantLog(2, "考え中…"),
      errorResult(3),
    ];
    expect(findPrecedingUserPrompt(entries, 2)).toBe("問題を解いて");
  });

  it("前 turn の result envelope で走査を止める (別 turn の user は再送対象外)", () => {
    const entries = [
      userLog(1, "旧 turn の質問"),
      errorResult(2),
      // 現 turn: user log が無く先頭が assistant のみ
      assistantLog(3, "reply"),
      errorResult(4),
    ];
    expect(findPrecedingUserPrompt(entries, 3)).toBeNull();
  });

  it("同 turn 内に user log が無ければ null", () => {
    const entries = [assistantLog(1, "hi"), errorResult(2)];
    expect(findPrecedingUserPrompt(entries, 1)).toBeNull();
  });

  it("text が空文字なら null", () => {
    const entries = [userLog(1, ""), errorResult(2)];
    expect(findPrecedingUserPrompt(entries, 1)).toBeNull();
  });

  it("resultIndex=0 (先頭) では走査対象なしで null", () => {
    const entries = [errorResult(1)];
    expect(findPrecedingUserPrompt(entries, 0)).toBeNull();
  });

  it("複数 user log があれば最後 (直近) の text", () => {
    const entries = [
      userLog(1, "first"),
      userLog(2, "second"),
      errorResult(3),
    ];
    expect(findPrecedingUserPrompt(entries, 2)).toBe("second");
  });

  it("session_boundary で走査を止める (クロエ round 2 must-fix 1)", () => {
    // /new が積む session_boundary marker を越えると前 session の user prompt
    // を拾ってしまう。/new 直後の inter-agent 起因エラー turn は user log を
    // 持たないため boundary で null 返しにしないと stale text が飛ぶ。
    function sessionBoundary(seq: number): Envelope {
      return {
        version: "0",
        agent_id: "agent-a",
        session_id: "s2",
        ts: `2026-07-25T00:00:0${seq}Z`,
        seq,
        type: "session_boundary",
        state: "thinking",
        payload: {},
      } as unknown as Envelope;
    }
    const entries = [
      userLog(1, "前 session の prompt"),
      sessionBoundary(2),
      // 現 session に user log 無し (inter-agent 起因)
      assistantLog(3, "reply"),
      errorResult(4),
    ];
    expect(findPrecedingUserPrompt(entries, 3)).toBeNull();
  });

  it("truncated:true の user log は null (原文再送保証、クロエ round 2 must-fix 2)", () => {
    // wrapper 側 16KB クリップ済の user log。原文そのまま再送できないので
    // ボタン非表示 (null 返し)。
    const truncated: Envelope = {
      version: "0",
      agent_id: "agent-a",
      session_id: "s1",
      ts: "2026-07-25T00:00:01Z",
      seq: 1,
      type: "log",
      state: "thinking",
      payload: { kind: "user", text: "truncated head…", truncated: true },
    } as unknown as Envelope;
    expect(findPrecedingUserPrompt([truncated, errorResult(2)], 1)).toBeNull();
  });
});
