<script lang="ts">
  // AgentDetail scenario mount for the viewport-regression specs (31-10).
  // `closed` flips when AgentDetail calls onClose — the specs use the
  // marker to prove the handle attention badge performs the same
  // "一覧へ戻す" as button.blindspot (T8, ADR-0052 F3).
  import AgentDetail from "../../src/lib/AgentDetail.svelte";
  import { conversationEntryKey } from "../../src/lib/conversationTimeline";
  import {
    detailAgents,
    detailEnvelope,
    detailLogs,
    detailManifest,
    stubConnection,
    type DetailScenario,
  } from "./fixtures";

  let { scenario }: { scenario: DetailScenario } = $props();

  const agents = detailAgents(scenario);
  const manifest = detailManifest(scenario);
  const connection = stubConnection();
  let closed = $state(false);

  // issue #237/#260: ResponseTimeline クリック(#122)を3通りの経路で再現する。
  // 1. scrollTargetDelayMs 未指定(immediate) — マウント時点で
  //    scrollToEntryKey が既に確定している経路。
  // 2. scrollTargetDelayMs 指定 — 既に開いている同一 agent の detail で
  //    あとから別行をクリックする経路(scrollToEntryKey だけが遅れて
  //    変化する、switching=false)。
  // 3. agentSwitchTargetIndex 指定 — 既に開いている detail から**別の
  //    agent** の timeline 行をクリックする経路。App.svelte の
  //    onSelectAgent が envelope と scrollToEntryKey を同一 tick で
  //    同時に書き換える(switching=true + target 確定が同時)実運用の
  //    最頻経路をそのまま再現する。
  // `logCount` 指定時は #184 の render window(LOG_WINDOW_SIZE=200)を
  // 超える件数の合成ログを生成し、ensureIndexVisible による window
  // 拡張込みの経路を実 DOM (実レイアウト・実 CSS scroll anchoring)で
  // 検証できるようにする — window 拡張が絡む経路は jsdom では再現できない
  // (timelineScroll.spec.ts 冒頭コメント参照)。
  function makeLogs(agentId: string, count: number) {
    // 各 agent で ts を variant させ、each-block key (env.ts + ":" +
    // (env.seq ?? ...)) が別 agent のログと衝突しないようにする(実運用
    // では別 agent のログが同一 ts を持つことはない)。
    const base = agentId === "host.ao" ? 0 : 1;
    return Array.from({ length: count }, (_, i) => ({
      version: "0" as const,
      agent_id: agentId,
      ts: `2026-08-0${9 + base}T09:30:00Z`,
      seq: i + 1,
      type: "log" as const,
      state: "thinking",
      payload: { kind: "assistant", text: `fixture reply ${i + 1}` },
    }));
  }

  let envelope = $state(detailEnvelope(scenario));
  let logs = $state(
    scenario.logCount !== undefined
      ? makeLogs("host.ao", scenario.logCount)
      : detailLogs(),
  );

  const immediateTargetKey =
    scenario.scrollTargetIndex !== undefined &&
    scenario.scrollTargetDelayMs === undefined
      ? conversationEntryKey(logs[scenario.scrollTargetIndex])
      : null;
  let scrollToEntryKey = $state<string | null>(immediateTargetKey);
  // #260: A timeline click sets the target before App conditionally mounts
  // AgentDetail. Keep that ordering in the harness; initial Svelte rendering
  // alone would not run the component's intro transition.
  let detailMounted = $state(scenario.mountDetailAfterMs === undefined);
  if (scenario.mountDetailAfterMs !== undefined) {
    setTimeout(() => {
      detailMounted = true;
    }, scenario.mountDetailAfterMs);
  }
  if (scenario.scrollTargetIndex !== undefined && scenario.scrollTargetDelayMs !== undefined) {
    const targetIndex = scenario.scrollTargetIndex;
    setTimeout(() => {
      scrollToEntryKey = conversationEntryKey(logs[targetIndex]);
    }, scenario.scrollTargetDelayMs);
  }
  if (scenario.agentSwitchTargetIndex !== undefined) {
    const targetIndex = scenario.agentSwitchTargetIndex;
    setTimeout(() => {
      const nextLogs = makeLogs("host.b2", scenario.logCount ?? 30);
      const nextKey = conversationEntryKey(nextLogs[targetIndex]);
      // App.svelte の onSelectAgent と同じく、envelope(agent 切替)と
      // scrollToEntryKey を同一 tick(同じ同期コールバック内)で更新する。
      logs = nextLogs;
      envelope = {
        version: "0",
        agent_id: "host.b2",
        persona: { id: "b2", name: "b2", sprite_set: "b2" },
        ts: "2026-08-09T10:00:00Z",
        type: "state_change",
        state: "idle",
      };
      scrollToEntryKey = nextKey;
    }, 500);
  }
</script>

{#if closed}
  <main class="harness-main">
    <p data-testid="closed-marker">グリッドへ戻りました</p>
  </main>
{:else}
  <main class="harness-main">
    {#if detailMounted}
      <AgentDetail
        {envelope}
        {logs}
        {agents}
        {connection}
        {manifest}
        origin={scenario.expandFromOrigin ? { x: 120, y: 120 } : null}
        {scrollToEntryKey}
        activeTaskCount={scenario.taskRing ?? 0}
        wrapperBuildInfo={scenario.wrapperBuildInfo
          ? {
              build_version: "2026.9.0",
              build_channel: "dev",
              build_revision: "0123456789abcdef0123456789abcdef01234567",
              build_dirty: false,
            }
          : null}
        onClose={() => (closed = true)}
      />
    {:else}
      <p data-testid="detail-pending-mount">detail を開いています…</p>
    {/if}
  </main>
{/if}

<style>
  /* Mirror of App.svelte's main shell (scoped there, so restated here). */
  .harness-main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1.6rem max(2rem, env(safe-area-inset-right)) 3rem
      max(2rem, env(safe-area-inset-left));
  }

  /* Mirror App.svelte's short compression so short-band specs measure the
     same vertical budget as production. */
  @media (max-height: 500px) {
    .harness-main {
      padding-top: 0.5rem;
      padding-bottom: 2.6rem;
    }
  }
</style>
