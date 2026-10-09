import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createLineage, forwardAccepted, restoreAccepted, type Lineage, type Tx } from "./codexLineageHarness.js";

const RECEIPT = "Malformed accepted binding receipt";
const VERSION = "Unsupported transaction binding receipt version";
const TARGET = "Latest accepted Codex lineage target mismatch";
const UNIT = "Latest accepted Codex lineage unit mismatch";
const LINEAGE = "Invalid accepted Codex recovery lineage";
const LEGACY = "Legacy Codex transaction requires operator recovery or retirement";

// Restore admission reads the restored home identity from the latest accepted
// transaction. Every case edits ONE condition of a synthetic installation and
// pairs it with an unedited twin that is admitted.
describe.skipIf(process.platform !== "linux")("accepted binding receipts at restore admission", { timeout: 300_000 }, () => {
  let L: Lineage, f1: Tx, f2: Tx, r2: Tx;
  beforeAll(async () => {
    L = await createLineage();
    f1 = forwardAccepted(L, "B", "b1");
    f2 = forwardAccepted(L, "C", "b2");
    r2 = restoreAccepted(L, "b2");
  }, 300_000);
  afterAll(async () => { await L.teardown(); });

  const probe = () => {
    mkdirSync(join(L.root, ".lock.update"), { recursive: true, mode: 0o700 });
    return L.state("prepare-restore", L.root, L.backupPath("b1"), L.home, "ao498-test", L.ids.B, String(process.pid));
  };
  const files = () => readdirSync(join(L.root, "codex-state/transactions")).filter((name) => name.endsWith(".json"));
  const edit = (uuid: string, change: (tx: Tx) => void) => { const tx = L.transaction(uuid); change(tx); L.writeTransaction(tx); };
  const legacy = (tx: Tx) => {
    delete tx.bindingReceiptVersion;
    if (tx.acceptance) tx.acceptance = { evidenceHash: tx.acceptance.evidenceHash, accepted: tx.acceptance.accepted };
  };
  const refuses = (message: string, mutate: () => void) => {
    L.saveState();
    const twin = probe();
    expect(twin.status, twin.stderr).toBe(0);
    expect(files()).toHaveLength(4);
    L.restoreState();
    mutate();
    const refused = probe();
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain(message);
    expect(files()).toHaveLength(3);
    expect(existsSync(join(L.root, ".lock.update/codex-owner.json"))).toBe(false);
    L.restoreState();
  };

  it("admits the older restore with the home identity from the latest accepted recovery", () => {
    L.saveState();
    const result = probe();
    expect(result.status, result.stderr).toBe(0);
    const prepared = L.transaction(result.stdout.trim());
    expect(prepared).toMatchObject({ mode: "restore", backupUUID: f1.uuid, bindingReceiptVersion: 1 });
    expect(prepared.binding.home.ino).toBe(statSync(L.home).ino);
    expect(prepared.binding.home.ino).toBe(r2.acceptance.binding.home.ino);
    expect(prepared.binding.home.ino).not.toBe(f1.binding.home.ino);
    L.restoreState();
  });
  it("publishes a complete version 1 receipt without the live process identity", () => {
    expect(r2).toMatchObject({ bindingReceiptVersion: 1, phase: "restored", sequence: 3 });
    expect(r2.acceptance).toMatchObject({ version: 1 });
    expect(Object.keys(r2.acceptance).sort()).toEqual(["accepted", "binding", "evidenceHash", "version"]);
    expect(r2.acceptance.binding).not.toHaveProperty("live");
    expect(r2.acceptance.binding.home.path).toBe(L.home);
    expect(f1.sequence).toBe(1);
    expect(f2.sequence).toBe(2);
    expect(L.transaction(f2.uuid)).toMatchObject({ phase: "restored", sequence: 2 });
    expect(L.transaction(f2.uuid).acceptance.version).toBe(1);
  });



  it("refuses a receipt without its accepted binding", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { delete tx.acceptance.binding; })));
  it("refuses a restore receipt whose observed home identity is not a number", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { tx.acceptance.binding.home.ino = "abc"; })));
  it("refuses a receipt carrying the live process identity", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { tx.acceptance.binding.live = { pid: 1, start: "1" }; })));
  it("refuses a receipt whose configuration differs from its own transaction", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { tx.acceptance.binding.config = `${tx.acceptance.binding.config}.other`; })));
  it("refuses an invalid acceptance sequence", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { tx.sequence = 0; })));
  it("refuses acceptance published on a non-terminal transaction", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { tx.phase = "start-attempted"; })));
  it("refuses a terminal recovery without a receipt", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { delete tx.acceptance; delete tx.sequence; })));
  it("refuses an acceptance record in the pre-receipt shape on a modern transaction", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { tx.acceptance = { evidenceHash: tx.acceptance.evidenceHash, accepted: tx.acceptance.accepted }; })));
  it("refuses a recovery recorded as completed instead of restored", () => refuses(RECEIPT, () => edit(r2.uuid, (tx) => { tx.phase = "completed"; })));
  it("refuses a modern recovery without a valid original reference", () => refuses("Malformed state record binding", () => edit(r2.uuid, (tx) => { tx.backupUUID = "not-a-uuid"; })));
  it("refuses a legacy transaction carrying modern acceptance fields", () => refuses(RECEIPT, () => edit(f2.uuid, (tx) => { delete tx.bindingReceiptVersion; })));
  it("refuses an unsupported receipt version", () => refuses(VERSION, () => edit(r2.uuid, (tx) => { tx.acceptance.version = 2; })));
  it("refuses an unknown transaction discriminator instead of treating it as legacy", () => refuses(VERSION, () => edit(r2.uuid, (tx) => { tx.bindingReceiptVersion = 2; })));
  it("refuses ambiguous acceptance sequences", () => refuses("Ambiguous accepted Codex lineage sequence", () => edit(f2.uuid, (tx) => { tx.sequence = 3; })));
  it("does not fall back to the older matching receipt when a newer accepted event does not match", () => refuses(TARGET, () => edit(f2.uuid, (tx) => { tx.sequence = 4; })));
  it("refuses a recovery that names a different original forward", () => refuses(LINEAGE, () => edit(r2.uuid, (tx) => { tx.backupUUID = f1.uuid; })));
  it("refuses a recovery whose original forward was never settled", () => refuses(LINEAGE, () => edit(f2.uuid, (tx) => { tx.phase = "completed"; })));
  it("refuses a recovery whose backup reference disagrees with the original", () => {
    L.saveState();
    const ref = L.reference(f2.uuid);
    ref.snapshot = `${ref.snapshot}.other`;
    L.writeReference(ref);
    const refused = probe();
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain(LINEAGE);
    L.restoreState();
  });
  it("refuses a recovery whose snapshot differs from its original's", () => refuses(LINEAGE, () => edit(r2.uuid, (tx) => { tx.snapshot = `${tx.snapshot}.other`; })));
  it("refuses a recovery whose target native hash is not its original's source", () => refuses(LINEAGE, () => {
    const flip = (hash: string) => hash.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    edit(f2.uuid, (tx) => { tx.source.sha256 = flip(tx.source.sha256); });
    const ref = L.reference(f2.uuid); ref.source.sha256 = flip(ref.source.sha256); L.writeReference(ref);
  }));
  it("refuses a recovery whose target release is not its original's source", () => refuses(LINEAGE, () => {
    edit(f2.uuid, (tx) => { tx.source.id = L.ids.A; });
    const ref = L.reference(f2.uuid); ref.source.id = L.ids.A; L.writeReference(ref);
  }));
  it("refuses a recovery whose source release is outside its original's lineage", () => refuses(LINEAGE, () => {
    edit(f2.uuid, (tx) => { tx.target.id = L.ids.A; });
    const ref = L.reference(f2.uuid); ref.target.id = L.ids.A; L.writeReference(ref);
  }));
  it("refuses a recovery prepared before its original", () => refuses(LINEAGE, () => edit(f2.uuid, (tx) => { tx.order = 99; })));
  it("refuses a recovery whose original forward is legacy", () => refuses(LINEAGE, () => edit(f2.uuid, legacy)));
  it("refuses a recovery whose original is not a forward transaction", () => refuses(LINEAGE, () => edit(f2.uuid, (tx) => { tx.mode = "code-recovery"; tx.backupUUID = f1.uuid; })));
  it("refuses a legacy accepted event without a sequence", () => refuses(RECEIPT, () => edit(f2.uuid, (tx) => { legacy(tx); delete tx.sequence; })));
  it("ignores accepted events recorded for another home", () => {
    L.saveState();
    const other = L.transaction(r2.uuid);
    other.uuid = "11111111-1111-4111-8111-111111111111"; other.order = 10; other.sequence = 10;
    other.binding.home.path = `${L.home}-other`;
    other.acceptance.binding.home.path = `${L.home}-other`;
    other.acceptance.binding.home.ino += 777;
    writeFileSync(join(L.root, "codex-state/transactions", `${other.uuid}.json`), JSON.stringify(other), { mode: 0o600 });
    const result = probe();
    expect(result.status, result.stderr).toBe(0);
    expect(L.transaction(result.stdout.trim()).binding.home.ino).toBe(statSync(L.home).ino);
    L.restoreState();
  });
  it("refuses a latest accepted recovery with a different unit", () => refuses(UNIT, () => edit(r2.uuid, (tx) => { tx.binding.unit = "other.service"; tx.acceptance.binding.unit = "other.service"; })));
  it("refuses a latest accepted recovery that is legacy", () => refuses(LEGACY, () => edit(r2.uuid, legacy)));
  it("refuses a selected reference that is legacy", () => refuses(LEGACY, () => edit(f1.uuid, legacy)));

  const proof = (uuid: string) => {
    const file = join(L.dir, `retire-${uuid}.json`);
    writeFileSync(file, JSON.stringify({ schema: 1, uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
    return file;
  };
  it("retires a restored forward only through its accepted recovery", () => {
    L.saveState();
    rmSync(join(L.root, "codex-state/transactions", `${r2.uuid}.json`));
    const refused = L.state("retire", L.root, f2.uuid, proof(f2.uuid));
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain(LINEAGE);
    expect(L.transaction(f2.uuid).phase).toBe("restored");
    expect(L.reference(f2.uuid).retired).toBe(false);
    L.restoreState();
    // An accepted recovery is present but its reference was never settled.
    const ref = L.reference(f2.uuid); ref.restored = false; L.writeReference(ref);
    const unsettled = L.state("retire", L.root, f2.uuid, proof(f2.uuid));
    expect(unsettled.status).toBe(78);
    expect(unsettled.stderr).toContain(LINEAGE);
    expect(L.transaction(f2.uuid).phase).toBe("restored");
    L.restoreState();
    const retired = L.state("retire", L.root, f2.uuid, proof(f2.uuid));
    expect(retired.status, retired.stderr).toBe(0);
    expect(L.transaction(f2.uuid)).toMatchObject({ phase: "retired", sequence: 2 });
    L.restoreState();
  });
});

it.skipIf(process.platform !== "linux")("exposes only a completed forward acceptance as a production completion fact", async () => {
  const L = await createLineage();
  try {
    const module = new URL("../deploy/kaoiro-runner-codex-state.mjs", import.meta.url);
    const invoke = (uuid:string,revision:string) => execFileSync(process.execPath,["--input-type=module","-e",
      `const {acceptedForwardTransaction}=await import(${JSON.stringify(module.href)});console.log(JSON.stringify(acceptedForwardTransaction(...process.argv.slice(1))))`,L.root,uuid,revision],{encoding:"utf8",stdio:"pipe"});
    const forward = forwardAccepted(L,"B","completion-forward");
    expect(JSON.parse(invoke(forward.uuid,L.ids.B))).toEqual({transaction_id:forward.uuid,
      evidence_sha256:forward.acceptance.evidenceHash,accepted_at:forward.acceptance.accepted});
    expect(()=>invoke(forward.uuid,L.ids.C)).toThrow();
    const restored = restoreAccepted(L,"completion-forward");
    expect(()=>invoke(restored.uuid,L.ids.A)).toThrow();
    expect(()=>invoke(forward.uuid,L.ids.B)).toThrow();
  } finally { await L.teardown(); }
}, 60_000);

describe.skipIf(process.platform !== "linux")("a retired forward as the latest accepted event", { timeout: 300_000 }, () => {
  let L: Lineage, f3: Tx;
  beforeAll(async () => {
    L = await createLineage();
    forwardAccepted(L, "B", "b1");
    forwardAccepted(L, "C", "b2");
    restoreAccepted(L, "b2");
    f3 = forwardAccepted(L, "B", "b3");
    const proof = join(L.dir, "retire-f3.json");
    writeFileSync(proof, JSON.stringify({ schema: 1, uuid: f3.uuid, gate6: true, productionCodexStart: true, productionHistory: true, abandonRollback: true }), { mode: 0o600 });
    const retired = L.state("retire", L.root, f3.uuid, proof);
    if (retired.status !== 0) throw new Error(retired.stderr);
    f3 = L.transaction(f3.uuid);
  }, 300_000);
  afterAll(async () => { await L.teardown(); });

  const probe = () => {
    mkdirSync(join(L.root, ".lock.update"), { recursive: true, mode: 0o700 });
    return L.state("prepare-restore", L.root, L.backupPath("b1"), L.home, "ao498-test", L.ids.B, String(process.pid));
  };
  const files = () => readdirSync(join(L.root, "codex-state/transactions")).filter((name) => name.endsWith(".json"));
  const edit = (change: (tx: Tx) => void) => { const tx = L.transaction(f3.uuid); change(tx); L.writeTransaction(tx); };
  const refuses = (message: string, mutate: () => void) => {
    L.saveState();
    const twin = probe();
    expect(twin.status, twin.stderr).toBe(0);
    expect(files()).toHaveLength(5);
    L.restoreState();
    mutate();
    const refused = probe();
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain(message);
    expect(files()).toHaveLength(4);
    L.restoreState();
  };

  it("keeps the receipt of a retired forward and admits the older restore through it", () => {
    expect(f3.phase).toBe("retired");
    expect(f3.acceptance.version).toBe(1);
    L.saveState();
    const result = probe();
    expect(result.status, result.stderr).toBe(0);
    expect(L.transaction(result.stdout.trim()).binding.home.ino).toBe(f3.acceptance.binding.home.ino);
    L.restoreState();
  });
  it("refuses when only the latest forward's target release differs", () => refuses(TARGET, () => edit((tx) => { tx.target.id = L.ids.C; })));
  it("refuses when only the latest forward's target native hash differs", () => refuses(TARGET, () => edit((tx) => { tx.target.sha256 = tx.target.sha256.replace(/^./, (c: string) => (c === "0" ? "1" : "0")); })));
  it("refuses when only the latest forward's unit differs", () => refuses(UNIT, () => edit((tx) => { tx.binding.unit = "other.service"; tx.acceptance.binding.unit = "other.service"; })));
  it("refuses when only the latest forward's observed home inode is not the actual home", () => refuses("Service/home configuration changed after binding", () => edit((tx) => { tx.binding.home.ino += 1000; tx.acceptance.binding.home.ino += 1000; })));
});
