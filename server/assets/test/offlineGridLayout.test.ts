// @vitest-environment jsdom
//
// 実機検収 1 (2026-07-23 マスター指示): A1 refactor で live-grid の
// `.agents { display: grid; ... }` rule が AgentGridShell.svelte の
// component-scoped styles へ移設された結果、App.svelte 側の offline
// section (`<ul class="agents">`) から grid スタイルが失われて tile
// が幅いっぱいに横長化する regression を出した。
//
// jsdom は grid の computed style を安定して返さないので、
// regression の再発を防ぐ最小な決定論 pin として App.svelte と
// AgentGridShell.svelte の source を静的に走査し、offline 側と live
// 側の双方に `display: grid` の auto-fill rule が残存することを
// assert する。片方だけ消えても検知される。

import { describe, expect, it } from "vitest";
import appSvelteSource from "../src/App.svelte?raw";
import agentGridShellSource from "../src/lib/AgentGridShell.svelte?raw";

function block(source: string, selector: string): string | null {
  // nested 無し前提の単純 CSS rule のみ検知。マッチしなければ null。
  const start = source.indexOf(selector);
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  if (open === -1) return null;
  const close = source.indexOf("}", open);
  if (close === -1) return null;
  return source.slice(open + 1, close);
}

describe("実機検収 1 regression pin: offline section grid CSS", () => {
  it("App.svelte の .offline .agents は auto-fill grid rule を持つ", () => {
    const rule = block(appSvelteSource, ".offline .agents");
    expect(rule, "`.offline .agents` rule missing").not.toBeNull();
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/grid-template-columns:\s*repeat\(auto-fill/);
  });

  it("AgentGridShell.svelte の .agents (live grid) も同じ auto-fill grid rule を持つ", () => {
    const rule = block(agentGridShellSource, ".agents ");
    expect(rule, "`.agents` rule missing in AgentGridShell").not.toBeNull();
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/grid-template-columns:\s*repeat\(auto-fill/);
  });

  it("オフラインありでは、ライブ領域を残余高へ縮めて各ペインを内部スクロールにする", () => {
    expect(appSvelteSource).toMatch(/class:with-offline=\{isOperator && offlineEntries\.length > 0\}/);

    const dashboard = block(appSvelteSource, ".dashboard.with-offline");
    expect(dashboard).toMatch(/display:\s*flex/);
    expect(dashboard).toMatch(/flex-direction:\s*column/);

    const live = block(appSvelteSource, ".dashboard.with-offline .live-dashboard");
    expect(live).toMatch(/flex:\s*1 1 0/);
    expect(live).toMatch(/overflow:\s*hidden/);

    const offlineList = block(
      appSvelteSource,
      ".dashboard.with-offline .offline\[open\] .agents",
    );
    expect(offlineList).toMatch(/overflow-y:\s*auto/);

    expect(agentGridShellSource).toMatch(/class:fit-viewport=\{fitViewport\}/);
    expect(agentGridShellSource).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
    const liveList = block(agentGridShellSource, ".fit-viewport .agents");
    expect(liveList).toMatch(/overflow-y:\s*auto/);
    expect(agentGridShellSource).toMatch(/\.fit-viewport :global\(\.timeline\)/);
  });
});
