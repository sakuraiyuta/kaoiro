<script lang="ts">
  // LaunchDialog / SettingsDrawer mounts for the short-viewport specs
  // (T9 / T10): production components, opened unconditionally.
  // PersonaDetailDialog (issue #232 MF-3, a11y spec) is opened from a
  // real trigger <button> instead, so the focus-restore-on-close
  // assertion has a genuine "focus before open" to return to.
  import LaunchDialog from "../../src/lib/LaunchDialog.svelte";
  import Modal from "../../src/lib/Modal.svelte";
  import PersonaDetailDialog from "../../src/lib/PersonaDetailDialog.svelte";
  import SessionLifecycleDialog from "../../src/lib/SessionLifecycleDialog.svelte";
  import { parseSessionLifecycleReply } from "../../src/lib/protocol";
  import lifecycleFixture from "../../../protocol/fixtures/session-lifecycle-query.json";
  import type { WorkSettingsSnapshot } from "@kaoiro/protocol";
  import SettingsDrawer from "../../src/lib/SettingsDrawer.svelte";
  import StatusLineHistoryDialog from "../../src/lib/StatusLineHistoryDialog.svelte";
  import {
    hostileStatusLineHistory,
    launchHosts,
    settingsDrawerConnection,
    stubConnection,
  } from "./fixtures";

  let {
    overlay,
    workState = null,
    lifecycleError = false,
  }: {
    overlay:
      | "dialog"
      | "drawer"
      | "persona"
      | "modal-empty"
      | "dialog-triggered"
      | "drawer-triggered"
      | "status-line-history"
      | "session-lifecycle";
    workState?: "ready" | "unavailable" | null;
    lifecycleError?: boolean;
  } = $props();

  const connection = stubConnection();
  const workSettings: WorkSettingsSnapshot | null = workState === "ready"
    ? { version: "0", state: "ready", revision: 42, overrides: {},
        effective: { work_nominated_per_principal: 16, work_active_per_assignee: 16 },
        fallbacks: { work_nominated_per_principal: 16, work_active_per_assignee: 16 },
        sources: { work_nominated_per_principal: "default", work_active_per_assignee: "default" }, last_change: null }
    : workState === "unavailable"
      ? { version: "0", state: "unavailable", reason: "work_settings_corrupt", message: "fixture unavailable" }
      : null;
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
  // issue 482: the status line change log, opened from a real trigger like the
  // other dialogs. Only the history fetch is a fixture; the dialog and the
  // markdown renderer under it are the production ones.
  let statusLineOpen = $state(false);
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
  {:else if overlay === "status-line-history"}
    <button
      type="button"
      id="status-line-trigger"
      onclick={() => (statusLineOpen = true)}
    >
      open status line log
    </button>
    {#if statusLineOpen}
      <StatusLineHistoryDialog
        agentId="e2e.agent"
        label="e2e"
        refreshKey={null}
        fetchHistory={async () => hostileStatusLineHistory()}
        onClose={() => (statusLineOpen = false)}
      />
    {/if}
  {:else if overlay === "session-lifecycle"}
    <SessionLifecycleDialog agentId="fixture" label="fixture" agents={{}} directory={{}} refreshKey={0}
      onClose={() => {}} fetchEvents={async () => {
        if (lifecycleError) throw new Error("fixture error");
        return parseSessionLifecycleReply(lifecycleFixture.target);
      }} />
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
        connection={settingsDrawerConnection()}
        isOperator={workState !== null}
        {workSettings}
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
