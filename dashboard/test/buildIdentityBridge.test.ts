import { describe, expect, it } from "vitest";
import { parseHosts, parseWrapperBuildInfo } from "../src/lib/protocol";

describe("modern build identity wire projection", () => {
  const identity = {
    build_revision: "a".repeat(40),
    build_dirty: false,
    build_version: "2026.10.09.2",
    build_channel: "dev" as const,
    build_branch: "develop",
  };

  it("retains the complete identity from hosts and wrapper reports", () => {
    const [host] = parseHosts({ home: { personas: [], cwd_allowlist: [], ...identity } });
    expect(host?.build_branch).toBe("develop");
    expect(host?.build_version).toBe(identity.build_version);
    expect(parseWrapperBuildInfo(identity)).toEqual(identity);
  });

  it("does not present a modern version without complete provenance", () => {
    for (const removed of ["build_branch", "build_revision", "build_dirty"] as const) {
      const partial: Record<string, unknown> = { ...identity };
      delete partial[removed];
      const [host] = parseHosts({ home: { personas: [], cwd_allowlist: [], ...partial } });
      expect(host?.build_version).toBeUndefined();
      expect(host?.build_branch).toBeUndefined();
      expect(parseWrapperBuildInfo(partial)).toBeNull();
    }
  });

  it("continues reading a branchless legacy identity", () => {
    const { build_branch: _, ...legacy } = { ...identity, build_version: "2026.9.0" };
    expect(parseWrapperBuildInfo(legacy)).toEqual(legacy);
  });
});
