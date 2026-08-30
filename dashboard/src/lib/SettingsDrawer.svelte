<script lang="ts">
  // Client-side settings drawer (#85): notification sound on/off + volume.
  // Slides in from the right; every change writes straight to localStorage
  // via updateSettings() (no separate save step, the value set is small).
  import { settings, updateSettings } from "./settings.svelte";
  import type {
    ConversationSummary,
    KaoiroConnection,
    UserSummary,
  } from "./protocol";
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
    /** issue #276 / #207: when present, the drawer also shows the
     *  operator-facing conversation list and user list/rename UI. Absent
     *  when the caller has no live connection yet, OR when the session
     *  is not operator-capable (App.svelte only passes a connection
     *  through here for `isOperator` sessions) — every other row
     *  (local-only settings) works without it. */
    connection?: KaoiroConnection | undefined;
  } = $props();

  // issue #276: fetched once per drawer open (no live push — mirrors
  // getLaunchDefaults' pure read-time query shape).
  let conversations = $state<ConversationSummary[] | null>(null);
  let conversationsError = $state<string | null>(null);

  // issue #207: same pure read-time query shape as conversations, just
  // above.
  let users = $state<UserSummary[] | null>(null);
  let usersError = $state<string | null>(null);

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
  // fresher data.
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

  // issue #207: a SEPARATE sequence counter from `refreshSeq` above, not
  // a shared one — the two fetches are independent RPCs (list_users vs
  // list_conversations), so clicking the conversations refresh button
  // must not invalidate an in-flight users fetch, and vice versa.
  let usersRefreshSeq = 0;

  function refreshUsers(): void {
    if (!connection) return;
    const seq = ++usersRefreshSeq;
    connection
      .listUsers()
      .then((list) => {
        if (seq === usersRefreshSeq) {
          users = list;
          usersError = null;
        }
      })
      .catch((err: unknown) => {
        if (seq === usersRefreshSeq) {
          usersError = err instanceof Error ? err.message : "error";
        }
      });
  }

  // issue #276 review follow-up (ふじ round2 B2): a `connection` prop
  // going from truthy to undefined (operator status revoked mid-session)
  // does NOT re-enter the `if (connection)` branch above, so it never
  // bumps refreshSeq itself — the earlier claim that "a connection
  // change re-runs the effect and bumps the sequence" only held for
  // truthy -> truthy transitions. Without this cleanup, an in-flight
  // reply from the PRE-loss connection can still land while `connection`
  // is undefined (invisible, since the section is hidden by `{#if
  // connection}`) and silently populate `conversations`/
  // `conversationsError` — then flash as stale data the instant
  // `connection` becomes truthy again, before the fresh reconnect fetch
  // resolves. The same gap applies to component destroy (no cleanup ran
  // there either). Bumping refreshSeq unconditionally on every effect
  // teardown — re-run AND unmount alike — closes both: whatever was
  // in flight when this run started is invalidated the moment it ends.
  // issue #277 (こはく引き継ぎ advisory, issue #276 round4 ふじ判定):
  // distinct from `refreshSeq` on purpose. refreshSeq bumps on EVERY
  // listConversations() call (mount / refresh button / post-close
  // re-fetch), not just a connection-identity change — reusing it to
  // guard handleConfirmClose's continuation would also invalidate a
  // close still in flight merely because the operator clicked refresh,
  // which is not the race this guards against. connectionGeneration
  // bumps ONLY in the effect cleanup below (a genuine connection-identity
  // change: reconnect, role-flap, or unmount).
  let connectionGeneration = 0;

  $effect(() => {
    if (connection) {
      refreshConversations();
      refreshUsers();
    }
    return () => {
      refreshSeq += 1;
      usersRefreshSeq += 1;
      connectionGeneration += 1;
      // issue #276 review follow-up (こはく advisory, round4): the seq
      // bump above invalidates an in-flight REPLY, but leaves whatever
      // is already RENDERED alone. A connection-identity change (e.g.
      // App.svelte's isOperator flapping false->true across a rejoin)
      // would otherwise keep showing the previous generation's list
      // until the new fetch resolves. Reset here too, so a generation
      // change shows the loading state instead. Scoped to this cleanup
      // (fires only on effect re-run / unmount) — the refresh button and
      // the post-close re-fetch call refreshConversations() directly and
      // are unaffected, preserving their existing "keep the old list
      // visible while refreshing" behaviour.
      conversations = null;
      conversationsError = null;
      // issue #207: same reasoning as the conversations reset just
      // above, applied to the users list (a separate fetch, same
      // generation).
      users = null;
      usersError = null;
      // issue #207: mirrors the confirm-close-modal reset below — a
      // connection-identity change while an inline rename is open (or a
      // rename is in flight) must not leave renamingUserId/renameError
      // pointing at the previous generation's row.
      renamingUserId = null;
      renameError = null;
      renaming = false;
      // issue #277 (advisory carried over from issue #276 round4, ふじ
      // 判定/こはく同意): the reset above missed the confirm-modal's OWN
      // state. Without this, a connection-identity change while the
      // confirm dialog is open (or a close is in flight) left
      // confirmCloseTarget/closeError/closing pointing at the PREVIOUS
      // generation's row — the modal would flash back into view with a
      // stale target once the connection came back, or a close result
      // from the old generation could land on the new one (see
      // handleConfirmClose's own generation guard below for that half).
      // Resetting here closes the modal outright on any generation
      // change, matching how the conversations list itself resets to a
      // loading state rather than silently carrying stale content across
      // generations.
      confirmCloseTarget = null;
      closeError = null;
      closing = false;
    };
  });

  // issue #276 manual close: confirm via the shared Modal primitive
  // (#232's focus-trap fix applies here too — director instruction to
  // reuse it rather than window.confirm()).
  //
  // Holds the whole row (not just the cid) so the confirm dialog can
  // show which conversation is targeted (こはく review follow-up, B1
  // residual): when the same pair has more than one open conversation,
  // the cid alone in generic confirm text left the operator unable to
  // tell them apart. Captured at click time from the rendered row, not
  // re-looked-up from `conversations` later — a refresh in flight while
  // the dialog is open must not change what the dialog displays.
  let confirmCloseTarget = $state<ConversationSummary | null>(null);
  let closeError = $state<string | null>(null);
  let closing = $state(false);

  async function handleConfirmClose(): Promise<void> {
    if (!connection || !confirmCloseTarget) return;
    // issue #277 (advisory carried over from issue #276 round4, ふじ
    // 判定/こはく同意): captured before the await, checked after —
    // if a connection-identity change happens WHILE closeConversation()
    // is in flight, the effect cleanup above has already reset
    // confirmCloseTarget/closeError/closing to their fresh-generation
    // defaults (and likely started a brand-new confirm interaction). This
    // continuation must not then write a stale generation's result back
    // over that: a rejection/success from generation N landing after
    // generation N+1 has already started must be a no-op here, the same
    // way refreshConversations()'s own seq guard drops a stale reply.
    const generation = connectionGeneration;
    closing = true;
    closeError = null;
    try {
      await connection.closeConversation(confirmCloseTarget.conversationId);
      if (generation === connectionGeneration) {
        confirmCloseTarget = null;
      }
    } catch (err) {
      if (generation === connectionGeneration) {
        closeError = err instanceof Error ? err.message : "error";
      }
    } finally {
      if (generation === connectionGeneration) {
        closing = false;
        // Re-fetch either way (closeConversation's own doc contract, ふじ
        // review follow-up): a rejection can mean someone else already
        // closed it (conversation_closed) or TTL beat us to it — the row
        // would otherwise sit stale at status=open forever. closeError
        // stays visible; this only refreshes the list behind it.
        refreshConversations();
      }
    }
  }

  // issue #207: inline rename, one row editable at a time. No confirm
  // dialog (unlike closeConversation) — a rename has no fan-out to
  // notify and is trivially reversible by renaming again, so the
  // close-conversation section's destructive-action pattern would be
  // disproportionate here. Unlike the confirm-close modal (a native
  // <dialog> that structurally blocks interacting with any other row
  // while open), this inline form has NO such barrier, so
  // renamingUserId/renameError/renaming (single, component-wide state —
  // not scoped per row) need their own explicit guards below: the
  // "名前を変更" button disables while a save is in flight (closes the
  // entry point — cannot switch rows mid-save), and submitRename's
  // continuation additionally re-checks `renamingUserId === userId`
  // (closes the exit point — cannot write a stale row's result over
  // whatever the operator has since opened, even if some future change
  // reintroduces a way to switch mid-flight).
  let renamingUserId = $state<string | null>(null);
  let renameDraft = $state("");
  let renameError = $state<string | null>(null);
  let renaming = $state(false);

  function startRename(user: UserSummary): void {
    renamingUserId = user.id;
    renameDraft = user.displayName;
    renameError = null;
  }

  function cancelRename(): void {
    renamingUserId = null;
    renameError = null;
  }

  async function submitRename(): Promise<void> {
    if (!connection || renamingUserId === null) return;
    // Same generation-guard shape as handleConfirmClose just above: a
    // connection-identity change while this call is in flight has
    // already reset renamingUserId/renameError to the fresh
    // generation's defaults (see the effect cleanup), so a late
    // resolve/reject from generation N must not write over generation
    // N+1's state.
    const generation = connectionGeneration;
    const userId = renamingUserId;
    const name = renameDraft;
    renaming = true;
    renameError = null;
    try {
      await connection.renameUser(userId, name);
      // `renamingUserId === userId` (on top of the generation check):
      // the "名前を変更" button disables while `renaming` is true, so
      // this should be unreachable in practice — kept as a second,
      // independent guard so a future change that reintroduces a way to
      // switch rows mid-save cannot silently close/misattribute a
      // DIFFERENT row's edit state.
      if (generation === connectionGeneration && renamingUserId === userId) {
        renamingUserId = null;
      }
    } catch (err) {
      if (generation === connectionGeneration && renamingUserId === userId) {
        renameError = err instanceof Error ? err.message : "error";
      }
    } finally {
      if (generation === connectionGeneration) {
        renaming = false;
        // Re-fetch either way, same contract as closeConversation
        // (issue #207 design decision): a rejection can still mean the
        // name changed underneath us via another session, so the row
        // must not sit stale at the pre-attempt name forever.
        refreshUsers();
      }
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

<Modal ariaLabel="設定" {onClose} contentClass="settings-drawer-content">
  {#snippet children()}
  <div class="drawer-header">
    <h2>設定</h2>
    <!-- svelte-ignore a11y_autofocus -- inside a native <dialog> opened
         via showModal() (Modal.svelte), autofocus is the spec-sanctioned
         initial-focus mechanism (issue #232 MF-3), not page-load
         autofocus (issue #277). -->
    <button
      type="button"
      class="close"
      onclick={onClose}
      aria-label="閉じる"
      autofocus
    >
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
                  onclick={() => (confirmCloseTarget = conv)}
                >
                  閉じる
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- issue #207: distinct classes throughout (not reused from the
         conversations section above), even though the CSS declarations
         are shared via combined selectors below -- a section-scoped
         reuse of e.g. .conv-list would make `.conv-list li` ambiguous
         between the two sections wherever both have rows. -->
    <section class="users">
      <div class="conversations-header">
        <h3>ユーザー一覧</h3>
        <button
          type="button"
          class="refresh"
          onclick={refreshUsers}
          aria-label="ユーザー一覧を更新"
        >
          更新
        </button>
      </div>
      {#if usersError}
        <p class="user-status">取得に失敗しました({usersError})</p>
      {:else if users === null}
        <p class="user-status">読み込み中…</p>
      {:else if users.length === 0}
        <p class="user-status">登録されているユーザーはいません</p>
      {:else}
        <ul class="user-list">
          {#each users as u (u.id)}
            <li>
              {#if renamingUserId === u.id}
                <div class="user-rename-row">
                  <input
                    type="text"
                    bind:value={renameDraft}
                    disabled={renaming}
                    aria-label="{u.id} の表示名"
                  />
                  <button
                    type="button"
                    onclick={submitRename}
                    disabled={renaming}
                  >
                    {renaming ? "保存中…" : "保存"}
                  </button>
                  <button
                    type="button"
                    onclick={cancelRename}
                    disabled={renaming}
                  >
                    キャンセル
                  </button>
                </div>
                {#if renameError}
                  <p class="user-status">失敗しました({renameError})</p>
                {/if}
              {:else}
                <span class="user-name">{u.displayName}</span>
                <span class="user-id" title={u.id}>id:{u.id.slice(0, 8)}</span>
                <span class="user-meta">{u.kind} / {u.role}</span>
                <button
                  type="button"
                  class="user-action"
                  onclick={() => startRename(u)}
                  disabled={renaming}
                >
                  名前を変更
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if connection && confirmCloseTarget}
    <Modal
      ariaLabel="会話を閉じる確認"
      onClose={() => {
        confirmCloseTarget = null;
        closeError = null;
      }}
    >
      {#snippet children()}
        <!-- Re-narrowed here on purpose: the outer {#if} guards <Modal>'s
             render, but this snippet compiles to its own function and
             svelte-check does not carry that narrowing across the
             boundary (confirmed 2026-08-30 — "possibly null" otherwise). -->
        {#if confirmCloseTarget}
          <p>この会話を閉じますか?参加エージェントに通知されます。</p>
          <p class="confirm-target">
            <span class="conv-participants"
              >{confirmCloseTarget.participants.join(" ⇔ ")}</span
            >
            <span class="conv-cid" title={confirmCloseTarget.conversationId}
              >cid:{confirmCloseTarget.conversationId.slice(0, 8)}</span
            >
          </p>
        {/if}
        {#if closeError}
          <p class="conv-status">失敗しました({closeError})</p>
        {/if}
        <div class="confirm-actions">
          <!-- svelte-ignore a11y_autofocus -- inside a native <dialog>
               opened via showModal() (Modal.svelte), autofocus is the
               spec-sanctioned initial-focus mechanism (issue #232 MF-3).
               issue #277: measured that Chromium's own fallback (no
               autofocus descendant) already lands here via DOM order --
               made explicit rather than relying on that implicitly, same
               reasoning as every other Modal.svelte caller's autofocus
               choice (a safe, non-destructive default). -->
          <button
            type="button"
            class="cancel"
            onclick={() => {
              confirmCloseTarget = null;
              closeError = null;
            }}
            disabled={closing}
            autofocus
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
  {/snippet}
</Modal>

<style>
  /* issue #277: modal chrome (backdrop, native <dialog>, focus handling)
     now lives in Modal.svelte -- this positions/sizes ONLY the content
     box it renders into `.modal-content` (needs :global(), same
     reasoning as PersonaDetailDialog.svelte / LaunchDialog.svelte: this
     class is only ever handed to Modal as a prop, never rendered by this
     component itself).

     Modal.svelte's <dialog> assumes a CENTERED box (full-viewport flex
     container, `align-items:center;justify-content:center`) -- this
     drawer keeps its own right-edge slide-in shape instead by giving
     `.settings-drawer-content` `position:fixed`, which takes it OUT of
     that flex layout entirely (director decision, issue #277: a CSS
     escape hatch confined to this caller, in preference to extending
     Modal.svelte itself while it has only one shape-variant caller --
     "rule of two": revisit a `placement` prop on Modal.svelte if a
     SECOND drawer-shaped caller appears).

     Load-bearing constraint this relies on: the <dialog> element itself
     stays a full-viewport, otherwise-EMPTY flex box (its own child,
     `.modal-content`, no longer occupies flex space once fixed). Any
     click landing outside this fixed content box therefore lands ON the
     <dialog> element directly, which Modal.svelte's own
     `handleBackdropClick` (`event.target === dialogEl`) already treats
     as an outside click -- this still routes to `onClose` correctly
     WITHOUT `.settings-drawer-content` needing to know anything about
     it. Do not add padding/margin/transform to `<dialog>` itself for any
     future reason without re-checking this invariant. */
  :global(.settings-drawer-content) {
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
    /* !important: measured (2026-08-30, this session) that Modal.svelte's
       OWN scoped `.modal-content { padding: 1.6rem }` rule otherwise wins
       -- Svelte's scoping hash raises its selector specificity above this
       plain :global() class selector, so a same-property override here
       is silently discarded without it. Confirmed via computed-style
       probe against a real render (getComputedStyle) before landing this,
       not assumed from CSS-cascade theory. */
    padding: max(1.6rem, env(safe-area-inset-top))
      max(1.6rem, env(safe-area-inset-right))
      max(1.6rem, env(safe-area-inset-bottom)) 1.6rem !important;
    animation: slide-in 0.2s ease-out;
    /* Same specificity fight as padding above: Modal.svelte's own
       `.modal-content` sets `border: 1px solid var(--line);
       border-radius: 0.6rem` for its default centered-card look. The
       drawer is flush against the viewport's top/right/bottom edges
       (position:fixed above), where a full border + rounded corners
       would read as a rendering glitch (corners appearing to float past
       the edge) rather than the original left-edge-only, square-cornered
       panel look -- preserved here, not a new choice. `background` is
       the SAME value Modal.svelte already applies by default; restated
       for clarity, not because the cascade requires it. */
    border: none !important;
    border-left: 1px solid var(--line) !important;
    border-radius: 0 !important;
    background: var(--bg-card);
  }

  /* short: the drawer becomes its own vertical scroll owner so low
     viewports never clip its rows (ADR-0052 F8). */
  @media (max-height: 500px) {
    :global(.settings-drawer-content) {
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

  /* issue #207: .user-status/.user-list/etc. share these declarations
     via combined selectors -- distinct class names (see the markup
     comment above the users section) so tests/queries never have to
     disambiguate which section a match came from, but no duplicated
     CSS. */
  .conv-status,
  .user-status {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .conv-list,
  .user-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-block-size: 12rem;
    overflow-y: auto;
  }

  .conv-list li,
  .user-list li {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: var(--fs-body-sm);
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
  }

  .conv-participants,
  .user-name {
    color: var(--fg);
  }

  .conv-cid,
  .user-id {
    color: var(--fg-dim);
    font-family: monospace;
    font-size: 0.85em;
  }

  .conv-meta,
  .user-meta {
    color: var(--fg-dim);
  }

  .conv-close,
  .user-action {
    align-self: flex-end;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }

  .conv-close:hover,
  .user-action:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  /* issue #207: .conv-close is never disabled (its own row's confirm
     modal blocks interaction structurally, see the style comment near
     the top of this file); .user-action now can be (see the
     renaming-guard comment above submitRename in the script). */
  .user-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* issue #207: inline rename row (name field + save/cancel), reuses
     .conv-list's li for outer spacing. */
  .user-rename-row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .user-rename-row input {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-body-sm);
  }

  .user-rename-row button {
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }

  .user-rename-row button:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .user-rename-row button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* issue #276 review follow-up (B1 residual): identifies the confirm
     dialog's target conversation, same look as a .conv-list row. */
  .confirm-target {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    margin: 0.5rem 0 0;
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
