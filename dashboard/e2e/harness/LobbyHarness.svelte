<script lang="ts">
  // Lobby scenario mount for the viewport-regression specs (31-10): the
  // SAME production AgentGridShell + AgentCard App.svelte uses, wrapped in
  // an unscoped <main> that mirrors App's shell (flex column via app.css
  // #app, main as the page scroll owner) so the sheet-open scroll lock and
  // handle clearance behave as in production.
  import AgentCard from "../../src/lib/AgentCard.svelte";
  import AgentGridShell from "../../src/lib/AgentGridShell.svelte";
  import type { PersonaManifest } from "../../src/lib/protocol";
  import type { StatusLineView } from "../../src/lib/statusLine";
  import {
    demoLobbyAgents,
    demoLobbyLogs,
    lobbyAgents,
    lobbyLogs,
  } from "./fixtures";

  let {
    operator,
    pending = false,
    taskRing = 0,
    manifest = null,
    demo = false,
    statusLine = { kind: "none" },
  }: {
    operator: boolean;
    pending?: boolean;
    taskRing?: number;
    manifest?: PersonaManifest | null;
    demo?: boolean;
    statusLine?: StatusLineView;
  } = $props();

  // issue 514: the agent whose change log the status line row asked for.
  let historyOpened = $state<string | null>(null);

  const agents = demo ? demoLobbyAgents(pending) : lobbyAgents(pending);
  const logs = demo ? demoLobbyLogs() : lobbyLogs();
  const sorted = Object.values(agents).sort((a, b) =>
    a.agent_id.localeCompare(b.agent_id),
  );
</script>

<main class="harness-main">
  <AgentGridShell
    {operator}
    {agents}
    directory={{}}
    {logs}
    {manifest}
    now={Date.now()}
    onSelectAgent={() => {}}
  >
    {#each sorted as envelope (envelope.agent_id)}
      <li>
        <AgentCard
          {envelope}
          {manifest}
          onSelect={() => {}}
          activeTaskCount={taskRing}
          {statusLine}
          onOpenStatusLineHistory={(id) => (historyOpened = id)}
        />
      </li>
    {/each}
  </AgentGridShell>
  <p id="history-opened" data-agent={historyOpened ?? ""}>{historyOpened ?? ""}</p>
</main>

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
