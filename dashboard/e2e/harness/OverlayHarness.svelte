<script lang="ts">
  // LaunchDialog / SettingsDrawer mounts for the short-viewport specs
  // (T9 / T10): production components, opened unconditionally.
  // PersonaDetailDialog (issue #232 MF-3, a11y spec) is opened from a
  // real trigger <button> instead, so the focus-restore-on-close
  // assertion has a genuine "focus before open" to return to.
  import LaunchDialog from "../../src/lib/LaunchDialog.svelte";
  import Modal from "../../src/lib/Modal.svelte";
  import PersonaDetailDialog from "../../src/lib/PersonaDetailDialog.svelte";
  import SettingsDrawer from "../../src/lib/SettingsDrawer.svelte";
  import { launchHosts, stubConnection } from "./fixtures";

  let {
    overlay,
  }: {
    overlay:
      | "dialog"
      | "drawer"
      | "persona"
      | "modal-empty"
      | "dialog-triggered"
      | "drawer-triggered";
  } = $props();

  const connection = stubConnection();
  let personaOpen = $state(false);
  // issue #277 a11y spec: LaunchDialog/SettingsDrawer opened from a real
  // trigger <button>, same reasoning as `persona` above -- the
  // focus-restore-on-close assertion needs a genuine "focus before open"
  // to return to. The existing unconditional `dialog`/`drawer` overlays
  // stay as-is (short.spec.ts's viewport-clipping specs need them open
  // immediately, with no trigger).
  let dialogOpen = $state(false);
  let drawerOpen = $state(false);
  // issue #232 MF-3 round-2 must-fix (MF-R2-2): a Modal instance whose
  // content has NO focusable element at all — no production caller does
  // this today (PersonaDetailDialog's close button always renders), but
  // Modal.svelte is a general-purpose primitive and ふじ's Chromium probe
  // measured the zero-focusable case directly against it.
  let modalEmptyOpen = $state(false);
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
  {:else if overlay === "modal-empty"}
    <button
      type="button"
      id="modal-empty-trigger"
      onclick={() => (modalEmptyOpen = true)}
    >
      open empty modal
    </button>
    {#if modalEmptyOpen}
      <Modal
        ariaLabel="empty modal"
        onClose={() => (modalEmptyOpen = false)}
      >
        {#snippet children()}
          <p>no focusable content</p>
        {/snippet}
      </Modal>
    {/if}
  {:else if overlay === "dialog-triggered"}
    <button
      type="button"
      id="dialog-trigger"
      onclick={() => (dialogOpen = true)}
    >
      open launch dialog
    </button>
    {#if dialogOpen}
      <LaunchDialog
        hosts={launchHosts()}
        {connection}
        sessions={null}
        onClose={() => (dialogOpen = false)}
      />
    {/if}
  {:else if overlay === "drawer-triggered"}
    <button
      type="button"
      id="drawer-trigger"
      onclick={() => (drawerOpen = true)}
    >
      open settings drawer
    </button>
    {#if drawerOpen}
      <SettingsDrawer
        onClose={() => (drawerOpen = false)}
        onLogout={() => {}}
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
