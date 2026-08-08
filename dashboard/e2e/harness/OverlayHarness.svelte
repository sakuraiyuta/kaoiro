<script lang="ts">
  // LaunchDialog / SettingsDrawer mounts for the short-viewport specs
  // (T9 / T10): production components, opened unconditionally.
  import LaunchDialog from "../../src/lib/LaunchDialog.svelte";
  import SettingsDrawer from "../../src/lib/SettingsDrawer.svelte";
  import { launchHosts, stubConnection } from "./fixtures";

  let { overlay }: { overlay: "dialog" | "drawer" } = $props();

  const connection = stubConnection();
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
