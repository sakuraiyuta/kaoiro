import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLineage, forwardAccepted, restoreAccepted, type Fault, type Lineage, type Tx } from "./codexLineageHarness.js";

const PENDING = "Unresolved Codex recovery requires acceptance or operator recovery";

// Acceptance of a recovery settles the original reference and forward first
// and publishes the receipt last, so an interrupted run leaves a recovery that
// is still awaiting acceptance and a rerun of `accept` finishes it.
describe.skipIf(process.platform !== "linux")("interrupted recovery acceptance", { timeout: 300_000 }, () => {
  let L: Lineage;
  afterEach(async () => { await L.teardown(); });

  const files = () => readdirSync(join(L.root, "codex-state/transactions")).filter((name) => name.endsWith(".json")).sort();
  const txPath = (uuid: string) => `codex-state/transactions/${uuid}\\.json$`;
  const retireProof = (uuid: string) => {
    const proof = join(L.dir, `retire-${uuid}.json`);
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
    return proof;
  };

  // Every mutating entry point must refuse while the recovery is pending.
  const gatesHold = (original: Tx, recovery: Tx, target: "B" | "C", snapshot: string) => {
    const before = { calls: L.callLog(), current: L.current(), files: files() };
    const forwardAgain = L.update(target, "after-pending");
    expect(forwardAgain.status).not.toBe(0);
    expect(forwardAgain.stderr).toContain("Recover or accept the previous Codex state transaction first");
    const codeOnly = L.state("guard", L.root, L.ids.C, "");
    expect(codeOnly.status).toBe(78);
    expect(codeOnly.stderr).toContain("Unresolved Codex transaction requires recovery");
    const again = L.restore(snapshot);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain(PENDING);
    const retired = L.state("retire", L.root, original.uuid, retireProof(original.uuid));
    expect(retired.status).toBe(78);
    expect(retired.stderr).toContain("Recovery still depends on this snapshot");
    const protectedIds = L.state("protected", L.root).stdout.split("\n");
    expect(protectedIds).toContain(original.source.id);
    expect(protectedIds).toContain(recovery.source.id);
    expect(L.callLog()).toBe(before.calls);
    expect(L.current()).toBe(before.current);
    expect(files()).toEqual(before.files);
  };

  const variants: [string, (original: string, recovery: string) => Fault, { reference: boolean; original: boolean }][] = [
    ["the reference save", (original) => ({ match: txPath(original), nth: 1, when: "before" }), { reference: true, original: false }],
    ["the original forward save", (original) => ({ match: txPath(original), nth: 1, when: "after" }), { reference: true, original: true }],
    ["the final receipt save", (_original, recovery) => ({ match: txPath(recovery), nth: 1, when: "before" }), { reference: true, original: true }],
  ];
  it.each(variants)("keeps the recovery pending after a failure at %s and finishes on a rerun", async (_name, fault, settled) => {
    L = await createLineage();
    forwardAccepted(L, "B", "b1");
    const f2 = forwardAccepted(L, "C", "b2");
    const restored = L.restore("b2");
    expect(restored.status, restored.stderr).toBe(0);
    const r2 = L.transactions().at(-1)!;
    expect(r2).toMatchObject({ mode: "restore", phase: "awaiting-acceptance" });
    const failed = L.accept(r2.uuid, undefined, fault(f2.uuid, r2.uuid));
    expect(failed.status).toBe(78);
    expect(failed.stderr).toContain("injected failure");
    const pending = L.transaction(r2.uuid);
    expect(pending.phase).toBe("awaiting-acceptance");
    expect(pending).not.toHaveProperty("acceptance");
    expect(pending).not.toHaveProperty("sequence");
    expect(L.reference(f2.uuid).restored).toBe(settled.reference);
    expect(L.transaction(f2.uuid).phase).toBe(settled.original ? "restored" : "completed");
    gatesHold(f2, r2, "C", "b1");
    const retry = L.accept(r2.uuid);
    expect(retry.status, retry.stderr).toBe(0);
    expect(L.transaction(r2.uuid)).toMatchObject({ phase: "restored", sequence: 3 });
    expect(L.transaction(f2.uuid).phase).toBe("restored");
    expect(L.reference(f2.uuid).restored).toBe(true);
    const r1 = restoreAccepted(L, "b1");
    expect(r1.sequence).toBe(4);
    expect(L.current()).toBe(L.ids.A);
  });

  it("does not accept a recovery a second time when the final save fails after its rename", async () => {
    L = await createLineage();
    forwardAccepted(L, "B", "b1");
    const f2 = forwardAccepted(L, "C", "b2");
    expect(L.restore("b2").status).toBe(0);
    const r2 = L.transactions().at(-1)!;
    const failed = L.accept(r2.uuid, undefined, { match: txPath(r2.uuid), nth: 1, when: "after" });
    expect(failed.status).toBe(78);
    expect(failed.stderr).toContain("injected failure after rename");
    const visible = L.transaction(r2.uuid);
    expect(visible).toMatchObject({ phase: "restored", sequence: 3 });
    expect(L.transaction(f2.uuid).phase).toBe("restored");
    expect(L.reference(f2.uuid).restored).toBe(true);
    const files0 = files();
    const second = L.accept(r2.uuid);
    expect(second.status).toBe(78);
    expect(second.stderr).toContain("Transaction has not reached startup checks");
    expect(L.transaction(r2.uuid)).toEqual(visible);
    expect(files()).toEqual(files0);
    const r1 = restoreAccepted(L, "b1");
    expect(r1.sequence).toBe(4);
  });

  it("refuses to accept a recovery when another accepted recovery already names its original", async () => {
    L = await createLineage();
    forwardAccepted(L, "B", "b1");
    const f2 = forwardAccepted(L, "C", "b2");
    expect(L.restore("b2").status).toBe(0);
    const r2 = L.transactions().at(-1)!;
    const rival = structuredClone(r2);
    rival.uuid = "22222222-2222-4222-8222-222222222222";
    rival.order = r2.order + 10; rival.phase = "restored"; rival.sequence = 20;
    const binding = structuredClone(r2.binding);
    delete binding.live;
    binding.home.ino += 5;
    rival.acceptance = { version: 1, evidenceHash: "a".repeat(64), accepted: new Date().toISOString(), binding };
    const rivalFile = join(L.root, "codex-state/transactions", `${rival.uuid}.json`);
    writeFileSync(rivalFile, JSON.stringify(rival), { mode: 0o600 });
    const refused = L.accept(r2.uuid);
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain("Invalid accepted Codex recovery lineage");
    expect(L.transaction(r2.uuid).phase).toBe("awaiting-acceptance");
    expect(L.reference(f2.uuid).restored).toBe(false);
    expect(L.transaction(f2.uuid).phase).toBe("completed");
    rmSync(rivalFile);
    const twin = L.accept(r2.uuid);
    expect(twin.status, twin.stderr).toBe(0);
  });

  it("refuses to publish when the evidence changes while the recovery is settled", async () => {
    L = await createLineage();
    forwardAccepted(L, "B", "b1");
    const f2 = forwardAccepted(L, "C", "b2");
    expect(L.restore("b2").status).toBe(0);
    const r2 = L.transactions().at(-1)!;
    const changed = JSON.stringify({ schema: 1, uuid: r2.uuid, nativeHash: r2.target.sha256, codexStart: true, history: true, note: "changed" });
    const refused = L.accept(r2.uuid, undefined, { match: txPath(f2.uuid), nth: 1, when: "mutate", write: { path: join(L.dir, `acceptance-${r2.uuid}.json`), content: changed } });
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain("Acceptance state changed during settlement");
    expect(L.transaction(r2.uuid)).not.toHaveProperty("acceptance");
    expect(L.transaction(f2.uuid).phase).toBe("restored");
    const retry = L.accept(r2.uuid);
    expect(retry.status, retry.stderr).toBe(0);
    expect(L.transaction(r2.uuid)).toMatchObject({ phase: "restored", sequence: 3 });
  });

  it("rejects a second unresolved transaction before the owned transaction passes guard or before-start", async () => {
    L = await createLineage();
    forwardAccepted(L, "B", "b1");
    expect(L.update("C", "b2").status).toBe(0);
    const f2 = L.transactions().at(-1)!;
    for (const args of [["guard", L.root, L.ids.C, f2.uuid], ["before-start", L.root, f2.uuid]]) {
      const twin = L.state(...args);
      expect(twin.status, args[0]).toBe(78);
      expect(twin.stderr, args[0]).not.toContain(PENDING);
    }
    const other = structuredClone(f2);
    other.uuid = "33333333-3333-4333-8333-333333333333"; other.order = f2.order + 10; other.phase = "stopped";
    writeFileSync(join(L.root, "codex-state/transactions", `${other.uuid}.json`), JSON.stringify(other), { mode: 0o600 });
    for (const args of [["guard", L.root, L.ids.C, f2.uuid], ["before-start", L.root, f2.uuid]]) {
      const refused = L.state(...args);
      expect(refused.status, args[0]).toBe(78);
      expect(refused.stderr, args[0]).toContain(PENDING);
    }
  });

  it("closes the same window for a never-started code recovery whose home inode is unchanged", async () => {
    L = await createLineage({ failSwitchToB: true });
    const failed = L.update("B", "b1");
    expect(failed.status).toBe(70);
    expect(failed.stderr).toContain("recorded source was restored and restarted");
    const [original, recovery] = L.transactions() as [Tx, Tx];
    expect(original).toMatchObject({ mode: "forward", phase: "snapshot-verified" });
    expect(recovery).toMatchObject({ mode: "code-recovery", phase: "awaiting-acceptance" });
    const broken = L.accept(recovery.uuid, undefined, { match: txPath(recovery.uuid), nth: 1, when: "before" });
    expect(broken.status).toBe(78);
    expect(L.transaction(recovery.uuid)).not.toHaveProperty("acceptance");
    expect(L.reference(original.uuid).restored).toBe(true);
    expect(L.transaction(original.uuid).phase).toBe("restored");
    const before = { calls: L.callLog(), current: L.current(), files: files() };
    const forwardAgain = L.update("C", "b2");
    expect(forwardAgain.status).not.toBe(0);
    expect(forwardAgain.stderr).toContain("Recover or accept the previous Codex state transaction first");
    const again = L.restore("b1");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain(PENDING);
    expect(L.callLog()).toBe(before.calls);
    expect(L.current()).toBe(before.current);
    expect(files()).toEqual(before.files);
    const retry = L.accept(recovery.uuid);
    expect(retry.status, retry.stderr).toBe(0);
    const done = L.transaction(recovery.uuid);
    expect(done.acceptance.binding.home.ino).toBe(original.binding.home.ino);
    expect(L.transaction(original.uuid).phase).toBe("restored");
    const next = forwardAccepted(L, "C", "b2");
    expect(next.sequence).toBe(2);
  });
});
