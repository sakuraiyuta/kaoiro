import { describe, expect, it } from "vitest";
import { formatBuildIdentity } from "../src/lib/buildIdentity";

describe("formatBuildIdentity (issue #288)", () => {
  it("uses the seven-character short hash in the operator label", () => {
    expect(
      formatBuildIdentity("client", {
        version: "2026.9.0",
        channel: "release",
        revision: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe("kaoiro release client v2026.9.0 / 0123456");
  });

  it("keeps an unknown revision explicit", () => {
    expect(
      formatBuildIdentity("server", {
        version: "unknown",
        channel: "dev",
        revision: "unknown",
      }),
    ).toBe("kaoiro dev server vunknown / unknown");
  });
});
