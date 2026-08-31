import { describe, expect, it } from "vitest";
import {
  formatBuildIdentity,
  formatRunnerHostLabel,
  normalizeDisplayBuildIdentity,
} from "../src/lib/buildIdentity";

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

  it("normalizes an impossible release identity to dev", () => {
    expect(
      normalizeDisplayBuildIdentity({
        version: "unknown",
        channel: "release",
        revision: "unknown",
        dirty: true,
      }),
    ).toEqual({
      version: "unknown",
      channel: "dev",
      revision: "unknown",
      dirty: true,
    });
  });

  it("host list label appends the runner identity after host_id", () => {
    expect(
      formatRunnerHostLabel({
        host_id: "lab-pc-1",
        build_version: "2026.9.0",
        build_channel: "dev",
        build_revision: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe("lab-pc-1 — kaoiro dev runner v2026.9.0 / 0123456");
  });

  it("legacy host without complete build identity keeps the host label", () => {
    expect(formatRunnerHostLabel({ host_id: "legacy-host" })).toBe(
      "legacy-host",
    );
  });
});
