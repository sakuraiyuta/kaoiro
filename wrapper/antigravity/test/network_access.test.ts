import { describe, expect, it } from "vitest";
import { effectiveNetworkAccess as codexEffectiveNetworkAccess } from "../../codex/src/network_access.js";
import { effectiveNetworkAccess } from "../src/network_access.js";

describe("effectiveNetworkAccess", () => {
  it("Codexと全sandbox/toggle組合せで同値", () => {
    for (const sandbox of ["danger-full-access", "read-only", "workspace-write"] as const) {
      for (const configuredNetworkAccess of [false, true]) {
        expect(effectiveNetworkAccess(sandbox, configuredNetworkAccess)).toBe(
          codexEffectiveNetworkAccess(sandbox, configuredNetworkAccess),
        );
      }
    }
  });
});
