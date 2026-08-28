<script lang="ts">
  // LaunchDialog / SettingsDrawer mounts for the short-viewport specs
  // (T9 / T10): production components, opened unconditionally.
  // PersonaDetailDialog (issue #232 MF-3, a11y spec) is opened from a
  // real trigger <button> instead, so the focus-restore-on-close
  // assertion has a genuine "focus before open" to return to.
  import LaunchDialog from "../../src/lib/LaunchDialog.svelte";
  import PersonaDetailDialog from "../../src/lib/PersonaDetailDialog.svelte";
  import SettingsDrawer from "../../src/lib/SettingsDrawer.svelte";
  import { launchHosts, stubConnection } from "./fixtures";

  let { overlay }: { overlay: "dialog" | "drawer" | "persona" } = $props();

  const connection = stubConnection();
  let personaOpen = $state(false);
</script>

<main class="harness-main">
  <p>overlay harness</p>
  {#if overlay === "dialog"}
    <LaunchDialog
      hosts={launchHosts()}
      {connection}
      sessions={null}
      onClose={() => {}}
    />
  {:else if overlay === "persona"}
    <button
      type="button"
      id="persona-trigger"
      onclick={() => (personaOpen = true)}
    >
      open persona modal
    </button>
    {#if personaOpen}
      <PersonaDetailDialog
        personaId="fuji"
        onClose={() => (personaOpen = false)}
      />
    {/if}
  {:else}
    <SettingsDrawer onClose={() => {}} onLogout={() => {}} />
  {/if}
</main>

<style>
  .harness-main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1.6rem 2rem 3rem;
  }
</style>
