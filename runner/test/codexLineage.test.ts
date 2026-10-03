import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLineage, forwardAccepted, restoreAccepted, type Lineage } from "./codexLineageHarness.js";

// Consecutive managed restores must succeed with no barrier directory: the
// restored home identity travels in the accepted transaction (issue 498).
describe.skipIf(process.platform !== "linux")("Codex state lineage through the shipped scripts", { timeout: 240_000 }, () => {
  let L: Lineage;
  beforeEach(async () => { L = await createLineage(); });
  afterEach(async () => { await L.teardown(); });

  const barriers = () => join(L.root, "codex-state/barriers");
  const write = (path: string, text: string) => writeFileSync(join(L.home, path), text);
  const text = (path: string) => readFileSync(join(L.home, path), "utf8");
  const forward = (to: "A" | "B" | "C", backup: string) => forwardAccepted(L, to, backup);
  const restore = (backup: string) => restoreAccepted(L, backup);
  const calls = () => L.callLog();

  it("restores C to B and then B to A with the inode carried by the accepted transaction", () => {
    write("sessions/old.jsonl", "HISTORY-A");
    const f1 = forward("B", "b1");
    const i0 = statSync(L.home).ino;
    write("sessions/old.jsonl", "HISTORY-B");
    const f2 = forward("C", "b2");
    expect(statSync(L.home).ino).toBe(i0);
    expect(f1.acceptance.binding.home.ino).toBe(i0);
    expect(f2.acceptance.binding.home.ino).toBe(i0);
    write("sessions/old.jsonl", "HISTORY-C");
    write("auth.json", "TOKEN-2");

    const r2 = restore("b2");
    const i1 = statSync(L.home).ino;
    expect(i1).not.toBe(i0);
    expect(r2.acceptance.binding.home.ino).toBe(i1);
    expect(r2.binding.home.ino).toBe(i0);
    expect(L.current()).toBe(L.ids.B);
    expect(text("sessions/old.jsonl")).toBe("HISTORY-B");
    expect(text("auth.json")).toBe("TOKEN-2");
    expect(L.reference(f2.uuid).restored).toBe(true);
    expect(L.transaction(f2.uuid).phase).toBe("restored");

    write("auth.json", "TOKEN-3");
    const r1 = restore("b1");
    const i2 = statSync(L.home).ino;
    expect(i2).not.toBe(i1);
    expect(r1.acceptance.binding.home.ino).toBe(i2);
    expect(L.current()).toBe(L.ids.A);
    expect(text("sessions/old.jsonl")).toBe("HISTORY-A");
    expect(text("auth.json")).toBe("TOKEN-3");
    expect(L.reference(f1.uuid).restored).toBe(true);
    expect(existsSync(barriers())).toBe(false);
    expect(calls()).toBe("stop\nstart\n".repeat(4));
  });

  it("uses a later accepted forward, retired before the older restore, as the home identity", () => {
    write("sessions/old.jsonl", "HISTORY-A");
    const f1 = forward("B", "b1");
    write("sessions/old.jsonl", "HISTORY-B");
    forward("C", "b2");
    write("auth.json", "TOKEN-2");
    const r2 = restore("b2");
    const i1 = statSync(L.home).ino;
    // F3 is B to B: same release, a distinct snapshot, and the restored home.
    const f3 = forward("B", "b3");
    expect(f3.acceptance.binding.home.ino).toBe(i1);
    expect(f3.sequence).toBeGreaterThan(r2.sequence);
    const proof = join(L.dir, "retire-f3.json");
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid: f3.uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
    const retired = L.state("retire", L.root, f3.uuid, proof);
    expect(retired.status, retired.stderr).toBe(0);
    expect(JSON.parse(retired.stdout)).not.toHaveProperty("barriersRetained");
    expect(L.transaction(f3.uuid).phase).toBe("retired");
    expect(L.transaction(f3.uuid).acceptance.binding.home.ino).toBe(i1);
    // The release only the retired history names is not needed to read it.
    rmSync(join(L.root, "releases", L.ids.C), { recursive: true });
    write("auth.json", "TOKEN-3");
    const r1 = restore("b1");
    expect(r1.acceptance.binding.home.ino).toBe(statSync(L.home).ino);
    expect(statSync(L.home).ino).not.toBe(i1);
    expect(L.current()).toBe(L.ids.A);
    expect(text("sessions/old.jsonl")).toBe("HISTORY-A");
    expect(text("auth.json")).toBe("TOKEN-3");
    expect(L.reference(f1.uuid).restored).toBe(true);
    expect(existsSync(barriers())).toBe(false);
  });

  it("restores an unaccepted newest forward without borrowing an older accepted event", () => {
    forward("B", "b1");
    expect(L.update("C", "b2").status).toBe(0);
    const f2 = L.transactions().at(-1)!;
    expect(f2.phase).toBe("awaiting-acceptance");
    const restored = restore("b2");
    expect(restored.acceptance.binding.home.ino).toBe(statSync(L.home).ino);
    expect(L.current()).toBe(L.ids.B);
    expect(L.transaction(f2.uuid).phase).toBe("restored");
  });

  it("refuses the second restore before stop when the home was replaced after the first", () => {
    write("sessions/old.jsonl", "HISTORY-A");
    forward("B", "b1");
    forward("C", "b2");
    restore("b2");
    const before = calls();
    renameSync(L.home, `${L.home}.original`);
    mkdirSync(L.home, { mode: 0o700 });
    writeFileSync(join(L.home, "auth.json"), "FOREIGN");
    const refused = L.restore("b1");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Service/home configuration changed after binding");
    expect(calls()).toBe(before);
    expect(L.current()).toBe(L.ids.B);
    expect(readdirSync(join(L.root, "codex-state/transactions")).filter((n) => n.endsWith(".json"))).toHaveLength(3);
    // The same restore succeeds once the managed home is back: only the home differs.
    rmSync(L.home, { recursive: true });
    renameSync(`${L.home}.original`, L.home);
    const again = L.restore("b1");
    expect(again.status, again.stderr).toBe(0);
    expect(L.current()).toBe(L.ids.A);
  });

  it("restores through an in-place configuration revert but refuses a rename-style edit", () => {
    const config = join(L.conf, "runner.env");
    const original = readFileSync(config, "utf8");
    forward("B", "b1");
    appendFileSync(config, "TOKEN=y\n");
    forward("C", "b2");
    restore("b2");
    // Same inode, original bytes: F1's recorded configuration is current again.
    writeFileSync(config, original);
    const before = calls();
    const restored = L.restore("b1");
    expect(restored.status, restored.stderr).toBe(0);
    expect(calls()).toBe(`${before}stop\nstart\n`);
    expect(L.current()).toBe(L.ids.A);
  });

  it("refuses restore after a rename-style edit of the runner configuration", () => {
    const config = join(L.conf, "runner.env");
    forward("B", "b1");
    forward("C", "b2");
    restore("b2");
    const before = calls();
    writeFileSync(`${config}.new`, `${readFileSync(config, "utf8")}TOKEN=changed\n`, { mode: 0o600 });
    renameSync(`${config}.new`, config);
    const refused = L.restore("b1");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Service/home configuration changed after binding");
    expect(calls()).toBe(before);
    expect(L.current()).toBe(L.ids.B);
  });

  it("refuses restore when the unit identity changes", () => {
    forward("B", "b1");
    forward("C", "b2");
    restore("b2");
    const before = calls();
    writeFileSync(join(L.dir, "unit-id"), "other-unit.service\n");
    const refused = L.restore("b1");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Service/home configuration changed after binding");
    expect(calls()).toBe(before);
  });
});
