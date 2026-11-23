import "./isolation.setup";
// @vitest-environment jsdom
// LaunchDialog's notices under the host select: the pack ingest diagnostics,
// the Antigravity CLI version, and the absence of any build-identity warning
// whatever the runner's revision or dirty state. Mirrors
// launchDefaults.integration.test.ts's harness (stubbed KaoiroConnection,
// DOM-driven, no real socket).
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LaunchDialog from "../src/lib/LaunchDialog.svelte";
import type { HostInfo, KaoiroConnection } from "../src/lib/protocol";

// jsdom does not implement HTMLDialogElement.showModal/close (measured
// 2026-08-28, jsdom 29.1.1; same polyfill as modal.integration.test.ts).
// issue #277 moved LaunchDialog onto the shared Modal.svelte primitive.
if (
  typeof HTMLDialogElement !== "undefined" &&
  typeof HTMLDialogElement.prototype.showModal !== "function"
) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

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
  ingestWarnings: string[] | null = [],
): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(LaunchDialog, {
    target,
    props: {
      hosts,
      connection: makeConnection(),
      sessions: null,
      ingestWarnings,
      onClose: vi.fn(),
    },
  });
  mounted.push(component);
  await settle();
  return target;
}

describe("LaunchDialog host notices", () => {
  it("shows collision diagnostics and treats a missing field as unknown", async () => {
    const target = await renderLaunch([claudeHost()], ["shared: keep a (a.zip); exclude b (b.zip)"]);
    expect(target.textContent).toContain("shared: keep a (a.zip); exclude b (b.zip)");
    expect(target.textContent).toContain("再起動");
    const legacy = await renderLaunch([claudeHost()], null);
    expect(legacy.textContent).toContain("診断情報は未対応または未確認");
  });

  it("shows no build-identity notice whatever the runner's revision or dirty state", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const other = "1111111111111111111111111111111111111111";
    const variants: Partial<HostInfo>[] = [
      {},
      { build_revision: sha, build_dirty: false },
      { build_revision: other, build_dirty: false },
      { build_revision: sha, build_dirty: true },
      { build_revision: "unknown", build_dirty: false },
    ];
    for (const overrides of variants) {
      const target = await renderLaunch([claudeHost(overrides)]);
      expect(target.querySelector(".build-revision-warning")).toBeNull();
      expect(target.querySelectorAll('p[role="status"]')).toHaveLength(0);
      expect(target.textContent).not.toContain("⚠");
    }
  });

  it("選択中の Antigravity host は CLI version または未報告状態を表示する", async () => {
    const antigravityHost = (version?: string): HostInfo => ({
      ...claudeHost(),
      capabilities: ["antigravity"],
      engines: [{ id: "antigravity", models: [] }],
      ...(version === undefined ? {} : { antigravity_cli_version: version }),
    });
    const withVersion = await renderLaunch([antigravityHost("agy-cli 1.1.26")]);
    expect(
      withVersion.querySelector(".antigravity-cli-version")?.textContent,
    ).toContain("agy-cli 1.1.26");

    const withoutVersion = await renderLaunch([antigravityHost()]);
    expect(
      withoutVersion.querySelector(".antigravity-cli-version")?.textContent,
    ).toContain("not reported");
  });
});
