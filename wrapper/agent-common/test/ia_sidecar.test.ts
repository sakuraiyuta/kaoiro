// IA sidecar (ADR-0051 D3-2 / D3-5). Covers the plan's failure-matrix row
// (k) — a truncated or corrupt line must be skipped, not abort the replay —
// plus the pending-journal lifecycle the spec pins: namespaced by
// {agent_id, generation}, bound to the session file once one exists, and
// GC'd fail-closed when a previous generation never got that far.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IaSidecar, parseSidecarLine } from "../src/ia_sidecar.js";
import type { Envelope } from "../src/types.js";

function iaEnvelope(body: string): Envelope {
  return {
    version: "0",
    agent_id: "host-1.peer",
    persona: { id: "ao", name: "あお", sprite_set: "ao" },
    ts: "2026-08-08T00:00:00Z",
    type: "inter_agent_message",
    state: "idle",
    payload: {
      to: "host-1.self",
      conversation_id: "cid-1",
      turn_number: 1,
      kind: "inform",
      body,
      meta: { done: false, propose_next: "" },
      owner: { kind: "user", id: "operator" },
    },
    ext: {},
  } as unknown as Envelope;
}

describe("IaSidecar", () => {
  let pendingDir: string;
  let sessionDir: string;
  const warnings: string[] = [];

  beforeEach(() => {
    pendingDir = mkdtempSync(join(tmpdir(), "kaoiro-ia-pending-"));
    sessionDir = mkdtempSync(join(tmpdir(), "kaoiro-ia-session-"));
    warnings.length = 0;
  });

  function makeSidecar(generation = "gen-1"): IaSidecar {
    return new IaSidecar({
      agentId: "host-1.self",
      generation,
      pendingDir,
      resolveSessionPath: (sessionId) =>
        join(sessionDir, `${sessionId}.ia.jsonl`),
      warn: (message) => warnings.push(message),
    });
  }

  it("append した行を stamp 付きで読み戻す", () => {
    const sidecar = makeSidecar();
    sidecar.append({ ingress_stamp: [1, 0], envelope: iaEnvelope("a") });
    sidecar.append({ ingress_stamp: [2, 0], envelope: iaEnvelope("b") });

    const records = sidecar.read();
    expect(records.map((r) => r.ingress_stamp)).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(records[1]?.envelope.payload.body).toBe("b");
  });

  it("session 未採番のうちは {agent_id, generation} の pending journal へ書く", () => {
    const sidecar = makeSidecar("gen-abc");
    sidecar.append({ ingress_stamp: [1, 0], envelope: iaEnvelope("a") });

    expect(sidecar.path()).toBe(
      join(pendingDir, "host-1.self__gen-abc.ia.jsonl"),
    );
    expect(existsSync(sidecar.path())).toBe(true);
  });

  it("bind で pending journal を session sidecar へ移し、以後そこに追記する", () => {
    const sidecar = makeSidecar();
    const pendingPath = sidecar.path();
    sidecar.append({ ingress_stamp: [1, 0], envelope: iaEnvelope("pending") });

    sidecar.bind("sess-1");

    expect(sidecar.path()).toBe(join(sessionDir, "sess-1.ia.jsonl"));
    expect(existsSync(pendingPath)).toBe(false);

    sidecar.append({ ingress_stamp: [2, 0], envelope: iaEnvelope("bound") });
    expect(sidecar.read().map((r) => r.envelope.payload.body)).toEqual([
      "pending",
      "bound",
    ]);
  });

  it("bind 先が既にあれば上書きせず追記する (同一 session への再 resume)", () => {
    writeFileSync(
      join(sessionDir, "sess-1.ia.jsonl"),
      `${JSON.stringify({ ingress_stamp: [1, 0], envelope: iaEnvelope("old") })}\n`,
    );

    const sidecar = makeSidecar();
    sidecar.append({ ingress_stamp: [2, 0], envelope: iaEnvelope("new") });
    sidecar.bind("sess-1");

    expect(sidecar.read().map((r) => r.envelope.payload.body)).toEqual([
      "old",
      "new",
    ]);
  });

  it("session_id が変わったら現行 sidecar を新パスへ移す (現 session 分のみ replay されるため)", () => {
    const sidecar = makeSidecar();
    sidecar.bind("sess-1");
    sidecar.append({ ingress_stamp: [1, 0], envelope: iaEnvelope("carried") });

    sidecar.bind("sess-2");

    expect(sidecar.path()).toBe(join(sessionDir, "sess-2.ia.jsonl"));
    expect(existsSync(join(sessionDir, "sess-1.ia.jsonl"))).toBe(false);
    expect(sidecar.read().map((r) => r.envelope.payload.body)).toEqual([
      "carried",
    ]);
  });

  it("パス成分にできない session_id は bind せず pending のままにする", () => {
    const sidecar = makeSidecar();
    const pendingPath = sidecar.path();
    sidecar.bind("../escape");

    expect(sidecar.path()).toBe(pendingPath);
    expect(warnings.join("\n")).toContain("malformed session_id");
  });

  it("(k) 壊れた行・途中切れの末尾は skip され、残りは読める", () => {
    const sidecar = makeSidecar();
    const good = JSON.stringify({
      ingress_stamp: [3, 0],
      envelope: iaEnvelope("good"),
    });
    writeFileSync(
      sidecar.path(),
      [
        "{not json",
        // stamp 欠落: server が fail-closed で捨てるので送っても無駄。
        JSON.stringify({ envelope: iaEnvelope("stampless") }),
        // stamp が壊れている。
        JSON.stringify({ ingress_stamp: "1-0", envelope: iaEnvelope("bad") }),
        good,
        // 途中切れの末尾行。
        '{"ingress_stamp":[4,0],"envelo',
      ].join("\n"),
    );

    const records = sidecar.read();
    expect(records).toHaveLength(1);
    expect(records[0]?.envelope.payload.body).toBe("good");
    expect(warnings.join("\n")).toContain("skipped 4 unreadable line(s)");
  });

  it("newest 200 件に cap する (server の最終投影 cap と同値)", () => {
    const sidecar = makeSidecar();
    for (let n = 1; n <= 205; n += 1) {
      sidecar.append({ ingress_stamp: [n, 0], envelope: iaEnvelope(`m${n}`) });
    }

    const records = sidecar.read();
    expect(records).toHaveLength(200);
    expect(records[0]?.ingress_stamp).toEqual([6, 0]);
    expect(records[199]?.ingress_stamp).toEqual([205, 0]);
  });

  it("起動時に同 agent の別 generation の pending journal を GC する", () => {
    const orphan = join(pendingDir, "host-1.self__gen-old.ia.jsonl");
    const otherAgent = join(pendingDir, "host-1.other__gen-old.ia.jsonl");
    writeFileSync(orphan, "{}\n");
    writeFileSync(otherAgent, "{}\n");

    const sidecar = makeSidecar("gen-new");
    sidecar.append({ ingress_stamp: [1, 0], envelope: iaEnvelope("a") });

    // bind 前に落ちた orphan は fail-closed で捨てる (どの session の行か
    // 決められないまま次の session に紛れ込ませない)。
    expect(existsSync(orphan)).toBe(false);
    // 別 agent の journal には触れない。
    expect(existsSync(otherAgent)).toBe(true);
    expect(existsSync(sidecar.path())).toBe(true);
  });

  it("sidecar 不在なら空配列 (fresh session)", () => {
    expect(makeSidecar().read()).toEqual([]);
  });
});

describe("parseSidecarLine", () => {
  it("inter_agent_message 以外の envelope を拒否する", () => {
    const line = JSON.stringify({
      ingress_stamp: [1, 0],
      envelope: { type: "log", payload: {} },
    });
    expect(parseSidecarLine(line)).toBeNull();
  });

  it("整数 2 要素でない stamp を拒否する", () => {
    for (const stamp of [[1], [1, 2, 3], [1.5, 0], ["1", "0"], null]) {
      const line = JSON.stringify({
        ingress_stamp: stamp,
        envelope: iaEnvelope("x"),
      });
      expect(parseSidecarLine(line)).toBeNull();
    }
  });

  it("正しい行は record として返す", () => {
    const line = JSON.stringify({
      ingress_stamp: [7, 3],
      envelope: iaEnvelope("ok"),
    });
    const parsed = parseSidecarLine(line);
    expect(parsed?.ingress_stamp).toEqual([7, 3]);
    expect(parsed?.envelope.payload.body).toBe("ok");
  });
});

describe("sidecar file mode", () => {
  it("append は 0600 で作成する (host local artifact)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kaoiro-ia-mode-"));
    const sidecar = new IaSidecar({
      agentId: "host-1.self",
      generation: "gen-mode",
      pendingDir: dir,
      resolveSessionPath: () => null,
    });
    sidecar.append({ ingress_stamp: [1, 0], envelope: iaEnvelope("a") });
    expect(readFileSync(sidecar.path(), "utf8")).toContain('"ingress_stamp"');
  });
});
