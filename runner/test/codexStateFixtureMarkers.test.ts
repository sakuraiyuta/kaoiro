import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateFixture, interruptStateWorker, type StateFixture } from "./codexStateFixture.js";
import { digestEntries } from "./codexStateRecoveryRecipes.js";

// The fixture's fault preload publishes cut-ready and running-helper for the
// test process to read. With slow-marker-write present, the preload creates a
// marker empty and fills it later; a marker published in place is then
// observable half-written (issue 913).

const forwardArgs = (h: StateFixture) => ["--install-dir", h.root, "--service", "kogane468-test", "--tarball", h.tarball(), "--codex-home", h.home, "--codex-backup-dir", join(h.dir, "backup")];

async function withFixtureCleanup(body: () => Promise<void>, close: () => Promise<void>) {
  let bodyFailed = false;
  let bodyError: unknown;
  let closeFailed = false;
  let closeError: unknown;
  try { await body(); } catch (error) { bodyFailed = true; bodyError = error; }
  try { await close(); } catch (error) { closeFailed = true; closeError = error; }
  if (bodyFailed && closeFailed) {
    throw new AggregateError([bodyError, closeError], "test body and fixture cleanup both failed");
  }
  if (bodyFailed) throw bodyError;
  if (closeFailed) throw closeError;
}

it("surfaces fixture cleanup failure after a passing body", async () => {
  const closeError = new Error("close failed");
  await expect(withFixtureCleanup(async () => {}, async () => { throw closeError; })).rejects.toBe(closeError);
});

it("retains body and fixture cleanup failures", async () => {
  const bodyError = new Error("body failed");
  const closeError = new Error("close failed");
  let caught: unknown;
  try {
    await withFixtureCleanup(async () => { throw bodyError; }, async () => { throw closeError; });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  const aggregate = caught as AggregateError;
  expect(aggregate.errors).toHaveLength(2);
  expect(aggregate.errors[0]).toBe(bodyError);
  expect(aggregate.errors[1]).toBe(closeError);
});

describe.skipIf(process.platform !== "linux")("fixture marker publication", { timeout: 60_000 }, () => {
  it.each([{ phase: "snapshot-verified", when: "after" }, { promote: true }])("never exposes a half-written cut-ready at %j", async fault => {
    const h = await createStateFixture();
    await withFixtureCleanup(async () => {
      // The next test covers close() reading a leftover marker; retain failures from both paths.
      h.trigger("slow-marker-write", "400");
      await interruptStateWorker(h, forwardArgs(h), fault);
    }, () => h.close());
  });

  it("close() never reads a half-written running-helper", async () => {
    const h = await createStateFixture();
    try {
      h.trigger("slow-marker-write", "2000");
      h.spawnHelper(["run"]);
      const deadline = Date.now() + 10_000;
      while (!readdirSync(h.dir).some(name => name.startsWith("running-helper"))) {
        if (Date.now() > deadline) throw new Error("run helper did not start publishing running-helper");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await h.close();
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("keeps leftover marker temp files out of the digest and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "marker-digest-"));
    try {
      for (const name of ["cut-ready.tmp-1", "running-helper.tmp-1", "mainpid.tmp-1", "kept"]) writeFileSync(join(dir, name), "x");
      expect([...digestEntries(dir).keys()].sort()).toEqual(["kept", "mainpid.tmp-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
