<script lang="ts">
  // Client-side settings drawer (#85): notification sound on/off + volume.
  // Slides in from the right; every change writes straight to localStorage
  // via updateSettings() (no separate save step, the value set is small).
  import { settings, updateSettings } from "./settings.svelte";
  import type { ConversationSummary, KaoiroConnection } from "./protocol";
  import Modal from "./Modal.svelte";

  let {
    onClose,
    onLogout = undefined,
    connection = undefined,
  }: {
    onClose: () => void;
    /** Logout relay (phase-31 31-7): on smartphone the header hides its
     *  logout button, so the drawer carries the affordance. Rendered at
     *  every size (DOM stays common — ADR-0052 F6); omitted = no row. */
    onLogout?: () => void | Promise<void>;
    /** issue #276 (admin-only first cut): when present, the drawer also
     *  shows an operator-facing conversation list. Absent when the
     *  caller has no live connection yet — every other row (local-only
     *  settings) works without it. */
    connection?: KaoiroConnection | undefined;
  } = $props();

  // issue #276: fetched once per drawer open (no live push — mirrors
  // getLaunchDefaults' pure read-time query shape).
  let conversations = $state<ConversationSummary[] | null>(null);
  let conversationsError = $state<string | null>(null);

  // Every listConversations() call in this component — the initial
  // mount fetch, the refresh button, and the post-close re-fetch —
  // shares this ONE sequence counter, bumped per call and checked
  // before applying either the resolved list or the caught error. Only
  // the reply matching the CURRENT (most recent) call is applied.
  //
  // A single shared guard, not one per call site, is what actually
  // closes the race: an earlier round-trip review claimed
  // refreshConversations() alone had this guard, but the mount effect
  // fired its own independent, unguarded call — so a slow initial-load
  // reply landing after a faster manual refresh could still overwrite
  // fresher data. This also subsumes the effect-cleanup `cancelled`
  // pattern (coding-languages.md「Async continuations own nothing after
  // a suspension point」): a connection change re-runs the effect,
  // which calls this again and bumps the sequence, so the OLD
  // connection's in-flight reply is a stale seq and gets ignored the
  // same way any other stale reply does (ふじ review follow-up, issue
  // #276).
  let refreshSeq = 0;

  function refreshConversations(): void {
    if (!connection) return;
    const seq = ++refreshSeq;
    connection
      .listConversations()
      .then((list) => {
        if (seq === refreshSeq) {
          conversations = list;
          conversationsError = null;
        }
      })
      .catch((err: unknown) => {
        if (seq === refreshSeq) {
          conversationsError = err instanceof Error ? err.message : "error";
        }
      });
  }

  $effect(() => {
    if (connection) refreshConversations();
  });

  // issue #276 manual close: confirm via the shared Modal primitive
  // (#232's focus-trap fix applies here too — director instruction to
  // reuse it rather than window.confirm()).
  let confirmCloseCid = $state<string | null>(null);
  let closeError = $state<string | null>(null);
  let closing = $state(false);

  async function handleConfirmClose(): Promise<void> {
    if (!connection || !confirmCloseCid) return;
    closing = true;
    closeError = null;
    try {
      await connection.closeConversation(confirmCloseCid);
      confirmCloseCid = null;
    } catch (err) {
      closeError = err instanceof Error ? err.message : "error";
    } finally {
      closing = false;
      // Re-fetch either way (closeConversation's own doc contract, ふじ
      // review follow-up): a rejection can mean someone else already
      // closed it (conversation_closed) or TTL beat us to it — the row
      // would otherwise sit stale at status=open forever. closeError
      // stays visible; this only refreshes the list behind it.
      refreshConversations();
    }
  }

  // MM/DD HH:MM in the browser's locale (issue #276 review follow-up —
  // a row previously showed no start time at all). Mirrors
  // AgentDetail.svelte's formatTime/fmtReset pattern: invalid or
  // missing timestamps render as "" rather than "Invalid Date".
  function formatStartedAt(iso: string | null): string {
    if (iso === null) return "";
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "";
    return at.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
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

  {#if connection}
    <section class="conversations">
      <div class="conversations-header">
        <h3>会話一覧</h3>
        <button
          type="button"
          class="refresh"
          onclick={refreshConversations}
          aria-label="会話一覧を更新"
        >
          更新
        </button>
      </div>
      {#if conversationsError}
        <p class="conv-status">取得に失敗しました({conversationsError})</p>
      {:else if conversations === null}
        <p class="conv-status">読み込み中…</p>
      {:else if conversations.length === 0}
        <p class="conv-status">開いている会話はありません</p>
      {:else}
        <ul class="conv-list">
          {#each conversations as conv (conv.conversationId)}
            <li>
              <span class="conv-participants"
                >{conv.participants.join(" ⇔ ")}</span
              >
              <span class="conv-cid" title={conv.conversationId}
                >cid:{conv.conversationId.slice(0, 8)}</span
              >
              <span class="conv-meta">
                {conv.turns} turns / {conv.status}
                {#if formatStartedAt(conv.startedAt)}
                  / {formatStartedAt(conv.startedAt)}
                {/if}
              </span>
              {#if conv.status === "open"}
                <button
                  type="button"
                  class="conv-close"
                  onclick={() => (confirmCloseCid = conv.conversationId)}
                >
                  閉じる
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if connection && confirmCloseCid}
    <Modal
      ariaLabel="会話を閉じる確認"
      onClose={() => {
        confirmCloseCid = null;
        closeError = null;
      }}
    >
      {#snippet children()}
        <p>この会話を閉じますか?参加エージェントに通知されます。</p>
        {#if closeError}
          <p class="conv-status">失敗しました({closeError})</p>
        {/if}
        <div class="confirm-actions">
          <button
            type="button"
            onclick={() => {
              confirmCloseCid = null;
              closeError = null;
            }}
            disabled={closing}
          >
            キャンセル
          </button>
          <button
            type="button"
            class="danger"
            onclick={handleConfirmClose}
            disabled={closing}
          >
            {closing ? "閉じています…" : "閉じる"}
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

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

  /* issue #276: operator-facing conversation list. */
  .conversations-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0 0 0.4rem;
  }

  .conversations-header h3 {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .refresh {
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }

  .refresh:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .conv-status {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .conv-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-block-size: 12rem;
    overflow-y: auto;
  }

  .conv-list li {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: var(--fs-body-sm);
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
  }

  .conv-participants {
    color: var(--fg);
  }

  .conv-cid {
    color: var(--fg-dim);
    font-family: monospace;
    font-size: 0.85em;
  }

  .conv-meta {
    color: var(--fg-dim);
  }

  .conv-close {
    align-self: flex-end;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }

  .conv-close:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .confirm-actions button {
    font-size: var(--fs-body-sm);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.35rem 0.8rem;
    cursor: pointer;
    color: var(--fg-dim);
  }

  .confirm-actions button:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .confirm-actions button.danger {
    color: var(--danger, #c62828);
    border-color: var(--danger, #c62828);
  }

  .confirm-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
