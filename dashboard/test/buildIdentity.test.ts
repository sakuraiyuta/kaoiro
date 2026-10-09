import { describe, expect, it } from "vitest";
import {
  formatBuildIdentity,
  formatRunnerHostLabel,
  normalizeDisplayBuildIdentity,
} from "../src/lib/buildIdentity";

describe("formatBuildIdentity (issue #288)", () => {
  it("displays the complete tagged version and literal branch", () => {
    expect(formatBuildIdentity("client", { version: "2026.10.09.2", channel: "dev",
      revision: "a".repeat(40), branch: "develop", dirty: false })).toBe("v2026.10.09.2 / develop / aaaaaaa");
    expect(formatRunnerHostLabel({host_id:"host", build_version:"2026.10.09.2", build_channel:"dev",
      build_revision:"a".repeat(40), build_branch:"develop"})).toBe("host — v2026.10.09.2 / develop / aaaaaaa");
  });
  it("does not prefix sentinels with v or include machine-only fields", () => {
    expect(formatBuildIdentity("runner", {version:"untagged",channel:"dev",revision:"b".repeat(40),
      branch:"topic/quote'\"",dirty:true})).toBe("untagged / topic/quote'\" / bbbbbbb");
  });
  it("uses the seven-character short hash in the operator label", () => {
    expect(
      formatBuildIdentity("client", {
        version: "2026.9.0",
        channel: "release",
        revision: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe("v2026.9.0 / unknown / 0123456");
  });

  it("keeps an unknown revision explicit", () => {
    expect(
      formatBuildIdentity("server", {
        version: "unknown",
        channel: "dev",
        revision: "unknown",
      }),
    ).toBe("unknown / unknown / unknown");
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
    ).toBe("lab-pc-1 — v2026.9.0 / unknown / 0123456");
  });

  it("legacy host without complete build identity keeps the host label", () => {
    expect(formatRunnerHostLabel({ host_id: "legacy-host" })).toBe(
      "legacy-host",
    );
  });
});
