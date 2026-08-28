<script lang="ts">
  // Client-side settings drawer (#85): notification sound on/off + volume.
  // Slides in from the right; every change writes straight to localStorage
  // via updateSettings() (no separate save step, the value set is small).
  import { settings, updateSettings } from "./settings.svelte";

  let {
    onClose,
    onLogout = undefined,
  }: {
    onClose: () => void;
    /** Logout relay (phase-31 31-7): on smartphone the header hides its
     *  logout button, so the drawer carries the affordance. Rendered at
     *  every size (DOM stays common — ADR-0052 F6); omitted = no row. */
    onLogout?: () => void | Promise<void>;
  } = $props();
</script>

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="閉じる"
  onclick={onClose}
  onkeydown={(e) => e.key === "Escape" && onClose()}
></div>
<div class="drawer" role="dialog" aria-modal="true" aria-label="設定">
  <div class="drawer-header">
    <h2>設定</h2>
    <button type="button" class="close" onclick={onClose} aria-label="閉じる">
      ×
    </button>
  </div>

  <label class="row">
    <input
      type="checkbox"
      checked={settings.notificationSoundEnabled}
      onchange={(e) =>
        updateSettings({
          notificationSoundEnabled: e.currentTarget.checked,
        })}
    />
    通知音
  </label>

  <label>
    音量
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={settings.notificationSoundVolume}
      disabled={!settings.notificationSoundEnabled}
      oninput={(e) =>
        updateSettings({
          notificationSoundVolume: Number(e.currentTarget.value),
        })}
    />
    <span class="value"
      >{Math.round(settings.notificationSoundVolume * 100)}%</span
    >
  </label>

  <label class="row">
    <input
      type="checkbox"
      checked={settings.agentCardStatsEnabled}
      onchange={(e) =>
        updateSettings({
          agentCardStatsEnabled: e.currentTarget.checked,
        })}
    />
    カードに engine・model・effort と ctx・5h・7day を表示
  </label>

  <label class="row">
    <input
      type="checkbox"
      checked={settings.hideNonMessageLogEntries}
      onchange={(e) =>
        updateSettings({
          hideNonMessageLogEntries: e.currentTarget.checked,
        })}
    />
    エージェント詳細のログでツール呼び出しなどを非表示
  </label>

  {#if onLogout}
    <button
      type="button"
      class="logout"
      onclick={() => void onLogout?.()}
    >
      ログアウト
    </button>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
    /* Global dialog/drawer layer (app.css z-index scale): above the bottom
       sheet (30-32). */
    z-index: 40;
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    height: 100%;
    width: min(20rem, 90vw);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    /* Fixed overlay: safe-area insets floor the existing edge padding
       (responsive-layout.md セーフエリア). */
    padding: max(1.6rem, env(safe-area-inset-top))
      max(1.6rem, env(safe-area-inset-right))
      max(1.6rem, env(safe-area-inset-bottom)) 1.6rem;
    background: var(--bg-card);
    border-left: 1px solid var(--line);
    z-index: 41;
    animation: slide-in 0.2s ease-out;
  }

  /* short: the drawer becomes its own vertical scroll owner so low
     viewports never clip its rows (ADR-0052 F8). */
  @media (max-height: 500px) {
    .drawer {
      max-block-size: 100dvh;
      overflow-y: auto;
    }
  }

  @keyframes slide-in {
    from {
      transform: translateX(100%);
    }
  }

  .drawer-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-h2);
    color: var(--fg);
  }

  .close {
    padding: 0.2rem 0.5rem;
    font-size: var(--fs-body);
    line-height: 1;
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .close:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  label.row {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }

  label.row input[type="checkbox"] {
    width: auto;
  }

  input[type="range"] {
    width: 100%;
  }

  input[type="range"]:disabled {
    opacity: 0.5;
  }

  .value {
    align-self: flex-end;
    color: var(--fg-dim);
  }

  /* Same look as the header logout button it stands in for (App.svelte). */
  .logout {
    margin-top: auto;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.35rem 0.6rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .logout:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }
</style>
