import { describe, expect, it } from "vitest";
import { effectiveNetworkAccess } from "../src/network_access.js";

// Phase-22 dogfood audit (藤): `config.network_access` is a raw toggle
// meaningful only for `workspace-write` (ADR-0033 F3 追補) — Codex
// only gates network behind the SDK's `networkAccessEnabled` option in that
// sandbox. `danger-full-access` always carries network (it is included in
// full access) and `read-only` never does, regardless of the toggle. This
// pure helper is the SSoT both CodexHost's effective-status snapshot and
// the CLI startup resolved-config log project through, so the two never
// diverge.
describe("effectiveNetworkAccess", () => {
  it("danger-full-access は toggle に関わらず true (network は sandbox に内包)", () => {
    expect(effectiveNetworkAccess("danger-full-access", false)).toBe(true);
    expect(effectiveNetworkAccess("danger-full-access", true)).toBe(true);
  });

  it("read-only は toggle に関わらず false (network 不可)", () => {
    expect(effectiveNetworkAccess("read-only", false)).toBe(false);
    expect(effectiveNetworkAccess("read-only", true)).toBe(false);
  });

  it("workspace-write は toggle をそのまま反映する (configured)", () => {
    expect(effectiveNetworkAccess("workspace-write", true)).toBe(true);
    expect(effectiveNetworkAccess("workspace-write", false)).toBe(false);
  });
});
