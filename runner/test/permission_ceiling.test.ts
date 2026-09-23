import { describe, expect, it } from "vitest";
import { resolveAntigravityCeiling } from "../src/permission_ceiling.js";

// ADR-0057 F4c Stage B0 (issue #359). resolveAntigravityCeiling always returns
// a safe ceiling and flags a config conflict for the spawn-time fail-closed
// reject.
describe("resolveAntigravityCeiling", () => {
  const launch = {
    sandbox: "workspace-write" as const,
    approval: "on-request" as const,
    networkAccess: false,
  };

  it("defaults approval to permissive_max(launch, local) and sandbox/network to launch", () => {
    const { ceiling, conflict } = resolveAntigravityCeiling(launch, undefined);
    expect(conflict).toBeNull();
    expect(ceiling).toEqual({
      max_sandbox: "workspace-write",
      max_approval: "local",
      max_network_access: false,
    });
  });

  it("keeps a launch approval already more permissive than local as its own default", () => {
    const { ceiling } = resolveAntigravityCeiling(
      { sandbox: "workspace-write", approval: "never", networkAccess: false },
      undefined,
    );
    expect(ceiling.max_approval).toBe("never");
  });

  it("honours an explicit ceiling at least as permissive as launch", () => {
    const { ceiling, conflict } = resolveAntigravityCeiling(launch, {
      max_sandbox: "danger-full-access",
      max_approval: "never",
      max_network_access: true,
    });
    expect(conflict).toBeNull();
    expect(ceiling).toEqual({
      max_sandbox: "danger-full-access",
      max_approval: "never",
      max_network_access: true,
    });
  });

  it("flags an approval ceiling narrower than launch as a conflict and falls back to the default", () => {
    const { ceiling, conflict, conflictAxes } = resolveAntigravityCeiling(
      { sandbox: "workspace-write", approval: "local", networkAccess: false },
      { max_approval: "on-request" },
    );
    expect(conflict).toContain("max_approval=on-request");
    // Defensive fallback: never relay a ceiling below the launch-derived default.
    expect(ceiling.max_approval).toBe("local");
    expect(conflictAxes).toEqual([
      { axis: "approval", current: "local", ceiling: "on-request" },
    ]);
  });

  it("flags a sandbox ceiling narrower than launch as a conflict", () => {
    const { conflict, conflictAxes } = resolveAntigravityCeiling(
      { sandbox: "danger-full-access", approval: "on-request", networkAccess: false },
      { max_sandbox: "workspace-write" },
    );
    expect(conflict).toContain("max_sandbox=workspace-write");
    expect(conflictAxes).toEqual([
      {
        axis: "sandbox",
        current: "danger-full-access",
        ceiling: "workspace-write",
      },
    ]);
  });

  it("flags max_network_access=false against a launch network_access=true", () => {
    const { conflict, conflictAxes } = resolveAntigravityCeiling(
      { sandbox: "workspace-write", approval: "on-request", networkAccess: true },
      { max_network_access: false },
    );
    expect(conflict).toContain("max_network_access=false");
    expect(conflictAxes).toEqual([
      { axis: "network_access", current: true, ceiling: false },
    ]);
  });

  it("accepts an equal network_access ceiling and joins multiple conflicts", () => {
    const { conflict, conflictAxes } = resolveAntigravityCeiling(
      { sandbox: "danger-full-access", approval: "local", networkAccess: true },
      { max_sandbox: "read-only", max_approval: "untrusted", max_network_access: true },
    );
    expect(conflict).toContain("max_sandbox=read-only");
    expect(conflict).toContain("max_approval=untrusted");
    // network_access true<=true is not a conflict.
    expect(conflict).not.toContain("max_network_access");
    expect(conflictAxes).toEqual([
      { axis: "sandbox", current: "danger-full-access", ceiling: "read-only" },
      { axis: "approval", current: "local", ceiling: "untrusted" },
    ]);
  });

  it("returns an empty conflictAxes array when there is no conflict", () => {
    const { conflict, conflictAxes } = resolveAntigravityCeiling(launch, undefined);
    expect(conflict).toBeNull();
    expect(conflictAxes).toEqual([]);
  });
});
