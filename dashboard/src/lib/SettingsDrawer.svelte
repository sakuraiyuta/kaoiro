<script lang="ts">
  // Client-side settings drawer (#85): notification sound on/off + volume.
  // Slides in from the right; every change writes straight to localStorage
  // via updateSettings() (no separate save step, the value set is small).
  import { settings, updateSettings } from "./settings.svelte";

  let { onClose }: { onClose: () => void } = $props();
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
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
    z-index: 1;
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
    padding: 1.6rem;
    background: var(--bg-card);
    border-left: 1px solid var(--line);
    z-index: 2;
    animation: slide-in 0.2s ease-out;
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
</style>
