import "../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { drive, ids, reach, stateOf } from "./codexStateRecoveryRecipes.js";

const executed: string[] = [];
describe.skipIf(process.platform !== "linux")("N3 recovery property: restore and terminal phases", { timeout: 90_000 }, () => {
  it.each(ids(2))("drives %s on a freshly reached state", async id => {
    const c = await reach(stateOf(id));
    try { await drive(id, c); executed.push(id); } finally { await c.h.close(); }
  });
  it("executed exactly the declared progress branches", () => {
    expect([...executed].sort()).toEqual(ids(2).sort());
  });
});
