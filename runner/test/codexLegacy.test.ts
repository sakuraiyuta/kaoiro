import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLineage, forwardAccepted, restoreAccepted, type Lineage, type Tx } from "./codexLineageHarness.js";

const LEGACY = "Legacy Codex transaction requires operator recovery or retirement";
const RECEIPT = "Malformed accepted binding receipt";

// A record written before the accepted binding receipt: no discriminator and
// an acceptance without version or binding.
const legacy = (tx: Tx) => {
  delete tx.bindingReceiptVersion;
  if (tx.acceptance) tx.acceptance = { evidenceHash: tx.acceptance.evidenceHash, accepted: tx.acceptance.accepted };
};

describe.skipIf(process.platform !== "linux")("legacy transactions fail closed", { timeout: 300_000 }, () => {
  let L: Lineage;
  afterEach(async () => { await L.teardown(); });

  const edit = (uuid: string, change: (tx: Tx) => void) => { const tx = L.transaction(uuid); change(tx); L.writeTransaction(tx); };
  const files = () => readdirSync(join(L.root, "codex-state/transactions")).filter((name) => name.endsWith(".json")).sort();
  const retireProof = (uuid: string, extra: Record<string, unknown> = {}) => {
    const proof = join(L.dir, `retire-${uuid}.json`);
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true, ...extra }), { mode: 0o600 });
    return proof;
  };
  const untouched = (run: () => { status: number | null; stderr: string }, message: string) => {
    const before = { calls: L.callLog(), current: L.current(), files: files() };
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(L.callLog()).toBe(before.calls);
    expect(L.current()).toBe(before.current);
    expect(files()).toEqual(before.files);
  };

  it("refuses to restore an accepted legacy reference before stopping", async () => {
    L = await createLineage();
    const f1 = forwardAccepted(L, "B", "b1");
    edit(f1.uuid, legacy);
    untouched(() => L.restore("b1"), LEGACY);
  });

  it("refuses a state-aware forward while an accepted legacy reference is retained", async () => {
    L = await createLineage();
    const f1 = forwardAccepted(L, "B", "b1");
    edit(f1.uuid, legacy);
    untouched(() => L.update("C", "b2"), LEGACY);
  });

  it("refuses to accept or recover an unfinished legacy transaction", async () => {
    L = await createLineage();
    expect(L.update("B", "b1").status).toBe(0);
    const unfinished = L.transactions().at(-1)!;
    expect(unfinished.phase).toBe("awaiting-acceptance");
    const actions = [["snapshot", L.root, unfinished.uuid], ["before-start", L.root, unfinished.uuid], ["started", L.root, unfinished.uuid], ["restore", L.root, unfinished.uuid], ["prepare-recovery", L.root, unfinished.uuid, String(process.pid)], ["guard", L.root, L.ids.B, unfinished.uuid]];
    // The modern twin may fail for other reasons, but never as legacy.
    for (const args of actions) expect(L.state(...args).stderr, args[0]).not.toContain(LEGACY);
    edit(unfinished.uuid, legacy);
    for (const args of actions) {
      const result = L.state(...args);
      expect(result.status, args[0]).toBe(78);
      expect(result.stderr, args[0]).toContain(LEGACY);
    }
    const accepted = L.accept(unfinished.uuid);
    expect(accepted.status).toBe(78);
    expect(accepted.stderr).toContain(LEGACY);
    expect(L.transaction(unfinished.uuid)).not.toHaveProperty("acceptance");
    untouched(() => L.restore("b1"), LEGACY);
  });

  it("allows an independent modern snapshot once every legacy reference is retired", async () => {
    L = await createLineage();
    const f1 = forwardAccepted(L, "B", "b1");
    edit(f1.uuid, legacy);
    const retired = L.state("retire", L.root, f1.uuid, retireProof(f1.uuid));
    expect(retired.status, retired.stderr).toBe(0);
    expect(L.transaction(f1.uuid)).toMatchObject({ phase: "retired" });
    expect(L.transaction(f1.uuid)).not.toHaveProperty("bindingReceiptVersion");
    const f2 = forwardAccepted(L, "C", "b2");
    expect(f2.bindingReceiptVersion).toBe(1);
    const r2 = restoreAccepted(L, "b2");
    expect(r2.acceptance.binding.home.ino).toBe(statSync(L.home).ino);
    expect(L.current()).toBe(L.ids.B);
  });

  it("keeps the evidence and snapshot gates on explicit legacy retirement", async () => {
    L = await createLineage();
    const f1 = forwardAccepted(L, "B", "b1");
    edit(f1.uuid, legacy);
    const missing = L.state("retire", L.root, f1.uuid, retireProof(f1.uuid, { abandonRollback: false }));
    expect(missing.status).toBe(78);
    expect(missing.stderr).toContain("Explicit accepted migration and rollback-retirement evidence is required");
    expect(L.reference(f1.uuid).retired).toBe(false);
    writeFileSync(join(L.backupPath("b1"), "state/sessions/old.jsonl"), "CORRUPTION");
    const corrupt = L.state("retire", L.root, f1.uuid, retireProof(f1.uuid));
    expect(corrupt.status).toBe(78);
    expect(corrupt.stderr).toContain("Snapshot payload mismatch");
    expect(L.reference(f1.uuid).retired).toBe(false);
    expect(L.transaction(f1.uuid).phase).toBe("completed");
  });

  it("treats a modern transaction with the pre-receipt acceptance shape as malformed everywhere", async () => {
    L = await createLineage();
    const f1 = forwardAccepted(L, "B", "b1");
    edit(f1.uuid, (tx) => { tx.acceptance = { evidenceHash: tx.acceptance.evidenceHash, accepted: tx.acceptance.accepted }; });
    for (const args of [["protected", L.root], ["guard", L.root, L.ids.A, ""], ["retire", L.root, f1.uuid, retireProof(f1.uuid)]]) {
      const result = L.state(...args);
      expect(result.status, args[0]).toBe(78);
      expect(result.stderr, args[0]).toContain(RECEIPT);
    }
    untouched(() => L.update("C", "b2"), RECEIPT);
    untouched(() => L.restore("b1"), RECEIPT);
    expect(L.transaction(f1.uuid).phase).toBe("completed");
  });
});

// Old barrier files are never read. These fixtures use the exact schema,
// file name and permissions the previous acceptance command wrote.
describe.skipIf(process.platform !== "linux")("stale migration barrier files carry no authority", { timeout: 300_000 }, () => {
  let L: Lineage;
  afterEach(async () => { await L.teardown(); });

  const barrierDir = () => join(L.root, "codex-state/barriers");
  const writeBarrier = (binding: Record<string, unknown> & { home: { path: string } }, native: Tx, uuid: string, acceptance: Tx) => {
    mkdirSync(barrierDir(), { recursive: true, mode: 0o700 });
    const file = join(barrierDir(), `${createHash("sha256").update(binding.home.path).digest("hex")}.json`);
    writeFileSync(file, `${JSON.stringify({ schema: 1, binding: { ...binding, live: { pid: 1, start: "1" } }, native, uuid, acceptance }, null, 2)}\n`, { mode: 0o600 });
    return file;
  };
  const oldAcceptance = (tx: Tx) => ({ evidenceHash: tx.acceptance.evidenceHash, accepted: tx.acceptance.accepted });
  const snapshotOf = (path: string) => ({ bytes: readFileSync(path, "utf8"), ino: lstatSync(path).ino, mode: lstatSync(path).mode });
  const chain = () => {
    forwardAccepted(L, "B", "b1");
    forwardAccepted(L, "C", "b2");
    return restoreAccepted(L, "b2");
  };

  it("does not let a well-formed barrier with a different home inode bias a consecutive restore", async () => {
    L = await createLineage();
    const r2 = chain();
    const binding = { ...r2.acceptance.binding, home: { ...r2.acceptance.binding.home, ino: r2.acceptance.binding.home.ino + 999 } };
    const file = writeBarrier(binding, r2.target, r2.uuid, oldAcceptance(r2));
    const before = snapshotOf(file);
    const restored = L.restore("b1");
    expect(restored.status, restored.stderr).toBe(0);
    expect(L.current()).toBe(L.ids.A);
    expect(snapshotOf(file)).toEqual(before);
  });

  it("does not let a well-formed barrier naming a replaced home admit the restore", async () => {
    L = await createLineage();
    const r2 = chain();
    renameSync(L.home, `${L.home}.original`);
    mkdirSync(L.home, { mode: 0o700 });
    const replaced = lstatSync(L.home);
    const binding = { ...r2.acceptance.binding, home: { ...r2.acceptance.binding.home, dev: replaced.dev, ino: replaced.ino } };
    const file = writeBarrier(binding, r2.target, r2.uuid, oldAcceptance(r2));
    const before = { stale: snapshotOf(file), calls: L.callLog(), files: readdirSync(join(L.root, "codex-state/transactions")).length };
    const refused = L.restore("b1");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Service/home configuration changed after binding");
    expect(L.callLog()).toBe(before.calls);
    expect(L.current()).toBe(L.ids.B);
    expect(readdirSync(join(L.root, "codex-state/transactions"))).toHaveLength(before.files);
    expect(snapshotOf(file)).toEqual(before.stale);
    rmSync(L.home, { recursive: true });
    renameSync(`${L.home}.original`, L.home);
    const twin = L.restore("b1");
    expect(twin.status, twin.stderr).toBe(0);
  });

  // Run the same managed sequence with and without a stale barrier whose
  // native and configuration hashes both disagree with reality.
  const sequence = async (stale: boolean) => {
    L = await createLineage();
    const f1 = forwardAccepted(L, "B", "b1");
    let file: string | undefined, before: ReturnType<typeof snapshotOf> | undefined;
    if (stale) {
      const binding = { ...f1.acceptance.binding, sourceHash: "0".repeat(64) };
      file = writeBarrier(binding, { ...f1.target, sha256: "f".repeat(64) }, f1.uuid, oldAcceptance(f1));
      before = snapshotOf(file);
    }
    const forwardResult = L.update("C", "b2");
    const f2 = L.transactions().at(-1)!;
    const accepted = forwardResult.status === 0 ? L.accept(f2.uuid) : undefined;
    const retired = L.state("retire", L.root, f1.uuid, (() => {
      const proof = join(L.dir, "retire-f1.json");
      writeFileSync(proof, JSON.stringify({ schema: 1, uuid: f1.uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
      return proof;
    })());
    if (file && before) expect(snapshotOf(file)).toEqual(before);
    return { forward: forwardResult.status, accepted: accepted?.status, retired: retired.status, phases: L.transactions().map((tx) => tx.phase), sequences: L.transactions().map((tx) => tx.sequence) };
  };
  it("behaves like the no-barrier twin for prepare, acceptance and retirement", async () => {
    const twin = await sequence(false);
    await L.teardown();
    expect(twin).toEqual({ forward: 0, accepted: 0, retired: 0, phases: ["retired", "completed"], sequences: [1, 2] });
    const stale = await sequence(true);
    expect(stale).toEqual(twin);
  });

  it("ignores damaged and dangling barrier entries without touching them", async () => {
    L = await createLineage();
    forwardAccepted(L, "B", "b1");
    mkdirSync(barrierDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(barrierDir(), "junk.json"), "not json", { mode: 0o600 });
    writeFileSync(join(barrierDir(), `${"a".repeat(64)}.json.damaged-00000000-0000-0000-0000-000000000000`), "damaged", { mode: 0o600 });
    symlinkSync(join(L.dir, "missing-barrier"), join(barrierDir(), "dangling.json"));
    const listing = () => readdirSync(barrierDir()).sort().map((name) => `${name}:${lstatSync(join(barrierDir(), name)).isSymbolicLink() ? readlinkSync(join(barrierDir(), name)) : readFileSync(join(barrierDir(), name), "utf8")}`);
    const before = listing();
    forwardAccepted(L, "C", "b2");
    restoreAccepted(L, "b2");
    expect(listing()).toEqual(before);
  });
});
