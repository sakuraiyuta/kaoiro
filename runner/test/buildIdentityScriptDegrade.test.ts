// Isolated from buildIdentityScript.test.ts: mocks node:child_process, so
// it must not share a module registry with the real-subprocess tests
// there (vitest gives each test FILE its own module graph, but a shared
// file would apply the mock to every test in it).
//
// Pins the issue #228 round 2 MF-2 ruling (ふじ 差し戻し): if
// `git status --porcelain` fails AFTER a successful `git rev-parse HEAD`,
// the WHOLE identity must degrade to unknown/false — not just `dirty`
// while keeping the real revision. This is the actual bug round 1 shipped
// (`generate-build-info.mjs`'s `dirty = statusOutput !== null && ...`
// silently defaulted to `dirty: false` on a status failure, keeping the
// real revision) and cannot be reproduced with a real git repo (there is
// no ordinary way to make `git status` fail right after `git rev-parse`
// succeeds), hence the mock.
import { describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

describe("computeBuildIdentity degrade rule (issue #228 round 2 MF-2)", () => {
  it("git status --porcelain の失敗時、identity 全体が unknown/false へ degrade する", async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return "0123456789abcdef0123456789abcdef01234567\n";
      }
      if (cmd === "git" && args[0] === "status") {
        throw new Error("simulated git status failure");
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const { computeBuildIdentity } = await import("../../scripts/build-identity.mjs");
    const identity = computeBuildIdentity("/some/repo");

    // The bug this pins: a naive fix keeps the real revision and only
    // flips dirty to false ("分からないのに大丈夫だと言う"). The correct
    // behavior degrades revision too ("分からないと言う").
    expect(identity).toEqual({
      revision: "unknown",
      dirty: false,
      version: "unknown",
      channel: "dev",
      degraded: true,
      degradeReason: expect.stringContaining("status"),
    });
  });
});
