// IA sidecar (ADR-0051 D3-2 / D3-5). Covers the plan's failure-matrix row
// (k) — a truncated or corrupt line must be skipped, not abort the replay —
// plus the pending-journal lifecycle the spec pins: namespaced by
// {agent_id, generation}, bound to the session file once one exists, and
// GC'd fail-closed when a previous generation never got that far.

import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IaSidecar, capNewestByStamp, parseSidecarLine } from "../src/ia_sidecar.js";
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

function sidecarRecord(stamp: number, body = `m${stamp}`) {
  return { ingress_stamp: [stamp, 0] as [number, number], envelope: iaEnvelope(body) };
}

function recordLine(stamp: number, body = `m${stamp}`): string {
  return `${JSON.stringify(sidecarRecord(stamp, body))}\n`;
}

function markerLine(retainedCap = 200, baselineBytes = 0, version = 1): string {
  return `${JSON.stringify({
    type: "kaoiro_ia_sidecar_compaction",
    version,
    retained_cap: retainedCap,
    baseline_bytes: baselineBytes,
  })}\n`;
}

function physicalLines(path: string): string[] {
  return readFileSync(path, "utf8").trimEnd().split("\n");
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

  afterEach(() => {
    rmSync(pendingDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function makeSidecar(
    generation = "gen-1",
    overrides: Partial<ConstructorParameters<typeof IaSidecar>[0]> = {},
  ): IaSidecar {
    return new IaSidecar({
      agentId: "host-1.self",
      generation,
      pendingDir,
      resolveSessionPath: (sessionId) =>
        join(sessionDir, `${sessionId}.ia.jsonl`),
      warn: (message) => warnings.push(message),
      ...overrides,
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

  // ふじ 30-10 must-fix M3 の実測再現: quota overshoot では synth notice
  // (高い stamp) が先に、それを起こした元 message (低い stamp) が ack 後に
  // append される。file 末尾 200 で切ると「古い方を捨てて新しい方を残す」
  // という cap の意味と逆の結果になる。
  it("append 順が ingress 順と逆でも、stamp 順で newest 200 を選ぶ", () => {
    const sidecar = makeSidecar();
    // stamp 2..201 を先に append し、最後に stamp 1 を追いつかせる。
    for (let n = 2; n <= 201; n += 1) {
      sidecar.append({ ingress_stamp: [n, 0], envelope: iaEnvelope(`m${n}`) });
    }
    sidecar.append({ ingress_stamp: [1, 0], envelope: iaEnvelope("m1") });

    const records = sidecar.read();

    expect(records).toHaveLength(200);
    // 落ちるのは最も古い stamp 1 であって、file 順で末尾から 201 番目の
    // stamp 2 ではない。
    expect(records[0]?.ingress_stamp).toEqual([2, 0]);
    expect(records[199]?.ingress_stamp).toEqual([201, 0]);
    expect(records.map((r) => r.envelope.payload.body)).not.toContain("m1");
  });

  it("read は file 順ではなく ingress_stamp 昇順で返す", () => {
    const sidecar = makeSidecar();
    sidecar.append({ ingress_stamp: [30, 0], envelope: iaEnvelope("third") });
    sidecar.append({ ingress_stamp: [10, 2], envelope: iaEnvelope("second") });
    sidecar.append({ ingress_stamp: [10, 1], envelope: iaEnvelope("first") });

    expect(sidecar.read().map((r) => r.envelope.payload.body)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("同一 stamp の重複行は 1 行に畳む (bind 時の append 由来)", () => {
    const sidecar = makeSidecar();
    sidecar.append({ ingress_stamp: [5, 0], envelope: iaEnvelope("dup") });
    sidecar.append({ ingress_stamp: [5, 0], envelope: iaEnvelope("dup") });
    sidecar.append({ ingress_stamp: [6, 0], envelope: iaEnvelope("next") });

    expect(sidecar.read().map((r) => r.ingress_stamp)).toEqual([
      [5, 0],
      [6, 0],
    ]);
  });

  it("matches the full reducer across reversed stamps, duplicates, and repeated compactions", () => {
    const sidecar = makeSidecar();
    const all = [];
    const payload = "x".repeat(15_000);
    for (let index = 0; index < 650; index += 1) {
      const stamp = index % 2 === 0 ? 650 - index : index;
      const record = sidecarRecord(stamp, `${payload}:${index}`);
      all.push(record);
      sidecar.append(record);
      if (index % 75 === 0) {
        const replacement = sidecarRecord(stamp, `${payload}:replacement:${index}`);
        all.push(replacement);
        sidecar.append(replacement);
      }
    }

    const restarted = makeSidecar();
    expect(restarted.read()).toEqual(capNewestByStamp(all));
    expect(physicalLines(restarted.path())[0]).toContain(
      '"type":"kaoiro_ia_sidecar_compaction"',
    );
  });

  it("proves a physical tail is not an exact newest-stamp reducer", () => {
    const physical = [];
    for (let stamp = 2; stamp <= 401; stamp += 1) {
      physical.push(sidecarRecord(stamp));
    }
    physical.push(sidecarRecord(1));

    const oracle = capNewestByStamp(physical);
    const blindTail = physical.slice(-200);
    expect(oracle[0]?.ingress_stamp).toEqual([202, 0]);
    expect(blindTail.map((record) => record.ingress_stamp[0])).toContain(1);
    expect(blindTail.map((record) => record.ingress_stamp[0])).not.toContain(202);
    expect(blindTail).not.toEqual(oracle);
  });

  it("compacts at the production 4 MiB budget and survives restart", () => {
    const sidecar = makeSidecar();
    const all = [];
    let appendedBytes = 0;
    for (let stamp = 1; appendedBytes < 4 * 1024 * 1024; stamp += 1) {
      const record = sidecarRecord(stamp, "x".repeat(18_000));
      const line = `${JSON.stringify(record)}\n`;
      appendedBytes += Buffer.byteLength(line);
      all.push(record);
      sidecar.append(record);
    }

    const lines = physicalLines(sidecar.path());
    expect(lines[0]).toContain('"type":"kaoiro_ia_sidecar_compaction"');
    expect(lines).toHaveLength(201);
    expect(lines.slice(1).map((line) => parseSidecarLine(line))).toEqual(
      capNewestByStamp(all),
    );

    const restarted = makeSidecar();
    expect(restarted.read()).toEqual(capNewestByStamp(all));
    let restartGrowth = 0;
    for (let stamp = 10_000; restartGrowth < 4 * 1024 * 1024; stamp += 1) {
      const record = sidecarRecord(stamp, "y".repeat(18_000));
      const line = `${JSON.stringify(record)}\n`;
      restartGrowth += Buffer.byteLength(line);
      all.push(record);
      restarted.append(record);
    }
    expect(physicalLines(restarted.path())).toHaveLength(201);
    expect(restarted.read()).toEqual(capNewestByStamp(all));
  });

  it("migrates an over-budget legacy file during bind without read", () => {
    const target = join(sessionDir, "sess-large.ia.jsonl");
    const rows = [];
    let bytes = 0;
    for (let stamp = 1; bytes <= 4 * 1024 * 1024; stamp += 1) {
      const line = recordLine(stamp, "x".repeat(18_000));
      rows.push(line);
      bytes += Buffer.byteLength(line);
    }
    writeFileSync(target, rows.join(""));

    const sidecar = makeSidecar();
    sidecar.bind("sess-large");
    const lines = physicalLines(target);
    expect(lines[0]).toContain('"type":"kaoiro_ia_sidecar_compaction"');
    expect(lines).toHaveLength(201);
    sidecar.append(sidecarRecord(10_000, "after-bind"));
    expect(sidecar.read().at(-1)?.envelope.payload.body).toBe("after-bind");
  });

  it("uses read as a backstop for a small unmarked legacy file", () => {
    const sidecar = makeSidecar();
    writeFileSync(
      sidecar.path(),
      [
        ...Array.from({ length: 205 }, (_, index) => recordLine(index + 1)),
        recordLine(205, "last duplicate wins"),
        "{broken tail",
      ].join(""),
    );

    const records = sidecar.read();
    expect(records).toHaveLength(200);
    expect(records.at(-1)?.envelope.payload.body).toBe("last duplicate wins");
    expect(physicalLines(sidecar.path())).toHaveLength(201);
    expect(makeSidecar().read()).toEqual(records);
  });

  it("keeps last-wins duplicate semantics when binding into a compacted target", () => {
    const target = join(sessionDir, "sess-merge.ia.jsonl");
    writeFileSync(
      target,
      Array.from({ length: 205 }, (_, index) => recordLine(index + 1)).join(""),
    );
    const existing = makeSidecar("existing");
    existing.bind("sess-merge");
    existing.read();

    const pending = makeSidecar("pending");
    pending.append(sidecarRecord(10, "pending duplicate wins"));
    pending.bind("sess-merge");

    const records = pending.read();
    expect(records.find((record) => record.ingress_stamp[0] === 10)?.envelope.payload.body)
      .toBe("pending duplicate wins");
    expect(records).toEqual(capNewestByStamp([
      ...Array.from({ length: 205 }, (_, index) => sidecarRecord(index + 1)),
      sidecarRecord(10, "pending duplicate wins"),
    ]));
  });

  it.each(["write", "rename"] as const)(
    "leaves original bytes intact and backs off after a %s failure",
    (failure) => {
      const sidecar = makeSidecar("failure", {
        testFileOperations: failure === "write"
          ? { writeTemp: (path) => {
              writeFileSync(path, "partial", { flag: "wx", mode: 0o600 });
              throw new Error("write failed");
            } }
          : { rename: () => { throw new Error("rename failed"); } },
      });
      writeFileSync(
        sidecar.path(),
        Array.from({ length: 205 }, (_, index) => recordLine(index + 1)).join(""),
      );
      const before = readFileSync(sidecar.path(), "utf8");

      expect(sidecar.read()).toEqual(
        capNewestByStamp(Array.from({ length: 205 }, (_, index) => sidecarRecord(index + 1))),
      );
      expect(readFileSync(sidecar.path(), "utf8")).toBe(before);
      const warningCount = warnings.length;
      sidecar.append(sidecarRecord(300, "below next budget"));
      expect(warnings).toHaveLength(warningCount);
      expect(readdirSync(dirname(sidecar.path())).some((name) => name.includes(".compact-")))
        .toBe(false);
    },
  );

  it("aborts replacement when the source changes after its scan", () => {
    let nextStamp = 300;
    const sidecar = makeSidecar("source-change", {
      testFileOperations: {
        beforeReplace: (path) => {
          appendFileSync(path, recordLine(nextStamp, `concurrent-${nextStamp}`));
          nextStamp += 1;
        },
      },
    });
    writeFileSync(
      sidecar.path(),
      Array.from({ length: 205 }, (_, index) => recordLine(index + 1)).join(""),
    );

    sidecar.read();
    sidecar.read();
    const text = readFileSync(sidecar.path(), "utf8");
    expect(text).toContain("concurrent-300");
    expect(text).toContain("concurrent-301");
    expect(text).not.toContain("kaoiro_ia_sidecar_compaction");
    expect(warnings.filter((warning) => warning.includes("source changed"))).toHaveLength(2);
  });

  it("treats unknown and mid-file markers conservatively and keeps the minimum cap", () => {
    const sidecar = makeSidecar();
    writeFileSync(
      sidecar.path(),
      [
        recordLine(1),
        markerLine(150),
        recordLine(2),
        markerLine(100),
        `${JSON.stringify({ type: "kaoiro_ia_sidecar_compaction", version: 1 })}\n`,
        markerLine(50, 0, 2),
        ...Array.from({ length: 203 }, (_, index) => recordLine(index + 3)),
      ].join(""),
    );

    expect(sidecar.read()).toHaveLength(200);
    const lines = physicalLines(sidecar.path());
    expect(JSON.parse(lines[0]!).retained_cap).toBe(100);
    expect(lines.slice(1).some((line) => line.includes("compaction"))).toBe(false);
    expect(warnings.join("\n")).toContain("unreadable line");
    expect(warnings.join("\n")).toContain("history is incomplete");
  });

  it("makes lossy retention explicit and creates no archive", () => {
    const sidecar = makeSidecar();
    writeFileSync(
      sidecar.path(),
      Array.from({ length: 205 }, (_, index) => recordLine(index + 1)).join(""),
    );

    sidecar.read();
    const text = readFileSync(sidecar.path(), "utf8");
    expect(text).not.toContain('"body":"m1"');
    expect(text).toContain('"body":"m205"');
    expect(readdirSync(dirname(sidecar.path())).filter((name) => name.includes("archive")))
      .toEqual([]);
  });

  it("cleans an orphan compaction temp on activation", () => {
    const pendingPath = join(pendingDir, "host-1.self__orphan.ia.jsonl");
    const orphan = `${pendingPath}.compact-1-orphan.tmp`;
    writeFileSync(orphan, "partial");

    makeSidecar("orphan");
    expect(existsSync(orphan)).toBe(false);
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
    expect(statSync(sidecar.path()).mode & 0o777).toBe(0o600);
  });
});
