<script lang="ts">
  // AgentDetail scenario mount for the viewport-regression specs (31-10).
  // `closed` flips when AgentDetail calls onClose — the specs use the
  // marker to prove the handle attention badge performs the same
  // "一覧へ戻す" as button.blindspot (T8, ADR-0052 F3).
  import AgentDetail from "../../src/lib/AgentDetail.svelte";
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
  const envelope = detailEnvelope(scenario);
  const logs = detailLogs();
  const manifest = detailManifest(scenario);
  const connection = stubConnection();
  let closed = $state(false);
</script>

{#if closed}
  <main class="harness-main">
    <p data-testid="closed-marker">グリッドへ戻りました</p>
  </main>
{:else}
  <main class="harness-main">
    <AgentDetail
      {envelope}
      {logs}
      {agents}
      {connection}
      {manifest}
      activeTaskCount={scenario.taskRing ? 1 : 0}
      onClose={() => (closed = true)}
    />
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
