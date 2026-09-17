import { describe, expect, it } from "vitest";
import { ceilingExceeded, type SwitchCeiling } from "../src/permission_switch.js";

// ADR-0057 F4c Stage B0 (issue #359): the wrapper's fail-closed final gate.
describe("ceilingExceeded", () => {
  const ceiling: SwitchCeiling = {
    sandbox: "workspace-write",
    approval: "local",
    network_access: false,
  };

  it("allows a cell at or below the ceiling on every axis", () => {
    expect(
      ceilingExceeded(
        { sandbox: "read-only", network_access: false, approval: "on-request" },
        ceiling,
      ),
    ).toBeNull();
    expect(
      ceilingExceeded(
        { sandbox: "workspace-write", network_access: false, approval: "local" },
        ceiling,
      ),
    ).toBeNull();
  });

  it("flags an approval wider than the ceiling", () => {
    const detail = ceilingExceeded(
      { sandbox: "workspace-write", network_access: false, approval: "never" },
      ceiling,
    );
    expect(detail).toContain("approval=never");
  });

  it("flags a sandbox wider than the ceiling", () => {
    const detail = ceilingExceeded(
      { sandbox: "danger-full-access", network_access: false, approval: "local" },
      ceiling,
    );
    expect(detail).toContain("sandbox=danger-full-access");
  });

  it("flags network_access=true against a false ceiling", () => {
    const detail = ceilingExceeded(
      { sandbox: "workspace-write", network_access: true, approval: "local" },
      ceiling,
    );
    expect(detail).toContain("network_access=true");
  });

  it("ignores an absent approval axis (sandbox/network-only request)", () => {
    expect(
      ceilingExceeded(
        { sandbox: "workspace-write", network_access: false },
        ceiling,
      ),
    ).toBeNull();
  });

  it("treats an approval value outside the closed order as a violation (fail-closed)", () => {
    const detail = ceilingExceeded(
      {
        sandbox: "workspace-write",
        network_access: false,
        approval: "on-failure" as SwitchCeiling["approval"],
      },
      ceiling,
    );
    expect(detail).toContain("approval=on-failure");
  });
});
