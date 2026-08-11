// @vitest-environment jsdom
// issue #228: LaunchDialog's build-revision mismatch warning. Component
// coverage is needed here (not just the pure-function unit level) because
// the warning is a $derived.by over `host` (resolved from `hostId` +
// `hosts`) and `serverBuildRevision`, both of which only exist once the
// component is mounted. Mirrors launchDefaults.integration.test.ts's
// harness (stubbed KaoiroConnection, DOM-driven, no real socket).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import type { HostInfo, KaoiroConnection } from "../src/lib/protocol";

const mounted: object[] = [];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  await tick();
}

function makeConnection(): KaoiroConnection {
  return {
    spawn: vi.fn(async () => ({ agentId: "host-a.new" })),
    enumerateSessions: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    refreshEngineCatalog: vi.fn(async () => ({
      host_id: "host-a",
      engine: "claude-code",
      request_id: "r",
      ok: true,
    })),
    getLaunchDefaults: vi.fn(async () => ({})),
  } as unknown as KaoiroConnection;
}

function claudeHost(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    host_id: "host-a",
    personas: [{ id: "fuji", name: "藤", sprite_set: "fuji" }],
    cwd_allowlist: ["/workspace"],
    capabilities: ["claude-code"],
    engines: [{ id: "claude-code", models: [] }],
    ...overrides,
  };
}

async function renderLaunch(
  hosts: HostInfo[],
  serverBuildRevision: string | null,
): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(LaunchDialog, {
    target,
    props: {
      hosts,
      connection: makeConnection(),
      sessions: null,
      serverBuildRevision,
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await settle();
  return target;
}

function warningText(target: Element): string | null {
  return target.querySelector(".build-revision-warning")?.textContent?.trim() ?? null;
}

describe("LaunchDialog build revision warning (issue #228)", () => {
  it("revision が server と一致すれば警告なし", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const target = await renderLaunch(
      [claudeHost({ build_revision: sha, build_dirty: false })],
      sha,
    );
    expect(warningText(target)).toBeNull();
  });

  it("revision が server と不一致なら警告する", async () => {
    const target = await renderLaunch(
      [
        claudeHost({
          build_revision: "1111111111111111111111111111111111111111",
          build_dirty: false,
        }),
      ],
      "2222222222222222222222222222222222222222",
    );
    const text = warningText(target);
    expect(text).not.toBeNull();
    expect(text).toContain("一致しません");
  });

  it("runner の build_revision が unknown なら警告する", async () => {
    const target = await renderLaunch(
      [claudeHost({ build_revision: "unknown", build_dirty: false })],
      "2222222222222222222222222222222222222222",
    );
    const text = warningText(target);
    expect(text).not.toBeNull();
    expect(text).toContain("unknown");
  });

  it("server の build_revision が unknown なら警告する", async () => {
    const target = await renderLaunch(
      [
        claudeHost({
          build_revision: "1111111111111111111111111111111111111111",
          build_dirty: false,
        }),
      ],
      "unknown",
    );
    const text = warningText(target);
    expect(text).not.toBeNull();
    expect(text).toContain("server");
  });

  // issue #228 round 2 MF-4 (ふじ 差し戻し): round 1 silently showed
  // nothing for "no runner signal at all" — indistinguishable from a
  // confirmed match. Round 2 surfaces this as its own message.
  it("pre-#228 runner (build_revision 無し) はその旨を警告する", async () => {
    const target = await renderLaunch(
      [claudeHost()],
      "2222222222222222222222222222222222222222",
    );
    const text = warningText(target);
    expect(text).not.toBeNull();
    expect(text).toContain("報告していません");
  });

  // issue #228 round 2 MF-4: round 1 treated a null serverBuildRevision
  // (pre-#228 server OR a failed /api/health fetch) the same as "nothing
  // to compare" and stayed silent. Round 2 surfaces this too — an
  // operator must be able to tell "confirmed matching" apart from
  // "no server signal at all".
  it("serverBuildRevision が null (pre-#228 server / fetch 失敗) ならその旨を警告する", async () => {
    const target = await renderLaunch(
      [
        claudeHost({
          build_revision: "1111111111111111111111111111111111111111",
          build_dirty: false,
        }),
      ],
      null,
    );
    const text = warningText(target);
    expect(text).not.toBeNull();
    expect(text).toContain("取得できません");
  });

  // issue #228 round 2 MF-4: dirty was computed but never surfaced by
  // round 1's derived function at all — a match on a dirty checkout looked
  // identical to a match on a clean one.
  it("revision が一致していても host が dirty なら警告する", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const target = await renderLaunch(
      [claudeHost({ build_revision: sha, build_dirty: true })],
      sha,
    );
    const text = warningText(target);
    expect(text).not.toBeNull();
    expect(text).toContain("dirty");
  });
});
