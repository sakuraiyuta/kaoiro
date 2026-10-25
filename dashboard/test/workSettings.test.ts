import "./isolation.setup";
import { describe, expect, it } from "vitest";
import { parseWorkSettings } from "../src/lib/workSettings";

const values = { work_nominated_per_principal: 16, work_active_per_assignee: 0 };
const ready = {
  version: "0", state: "ready", revision: 0,
  effective: values, fallbacks: values, overrides: {},
  sources: { work_nominated_per_principal: "default", work_active_per_assignee: "config" },
  last_change: null, changes: [],
};

describe("work settings wire validation", () => {
  it("accepts zero and finite snapshots and copies only unavailable diagnosis fields", () => {
    expect(parseWorkSettings(ready)).toEqual(ready);
    const unavailable = { version: "0", state: "unavailable", reason: "work_settings_corrupt", message: "Repair saved settings." };
    expect(parseWorkSettings({ ...unavailable, effective: values, changes: ["untrusted"] })).toEqual(unavailable);
  });

  it.each([
    null, [], {}, { ...ready, state: "future" },
    { ...ready, revision: -1 }, { ...ready, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...ready, effective: { ...values, work_active_per_assignee: -1 } },
    { ...ready, effective: { ...values, work_active_per_assignee: 1.5 } },
    { ...ready, effective: { ...values, work_active_per_assignee: 2147483648 } },
    { ...ready, fallbacks: {} }, { ...ready, overrides: { future: 0 } },
    { ...ready, sources: { ...ready.sources, work_active_per_assignee: "future" } },
    { ...ready, last_change: {} }, { ...ready, changes: [{}] },
    { state: "unavailable", reason: "future", message: "unknown" },
    { state: "unavailable", reason: "work_settings_unknown", message: "x".repeat(1025) },
  ])("rejects malformed settings %# before they reach the UI", value => {
    expect(parseWorkSettings(value)).toBeNull();
  });
});
