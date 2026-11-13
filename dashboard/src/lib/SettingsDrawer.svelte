<script lang="ts">
  import WorkCapacitySettings from "./WorkCapacitySettings.svelte";
  import type { WorkSettingsSnapshot } from "@kaoiro/protocol";
  // Client-side settings drawer (#85): notification sound on/off + volume.
  // Slides in from the right; every change writes straight to localStorage
  // via updateSettings() (no separate save step, the value set is small).
  import { settings, updateSettings } from "./settings.svelte";
  import {
    isConversationAlreadyClosedError,
    visibleConversationSummaries,
  } from "./conversationList";
  import { agentDisplayName } from "./personaName";
  import { MAX_RALLY_TURNS } from "./protocol";
  import type {
    ConversationSummary,
    DirectoryEntry,
    Envelope,
    KaoiroConnection,
    QuagmireSettings,
    UserSummary,
  } from "./protocol";
  import type { StatusLineSettings } from "./statusLine";
  import { msg } from "./i18n/index.svelte";
  import LanguageSelect from "./LanguageSelect.svelte";
  import Modal from "./Modal.svelte";

  import { executeBulkCleanup } from "./bulkCleanup";

  let {
    onClose,
    onLogout = undefined,
    onOpenSessionLifecycle = undefined,
    connection = undefined,
    quagmireSettings = null,
    workSettings = null,
    isOperator = false,
    onWorkSettings = () => {},
    statusLineSettings = null,
    agents = {},
    directory = {},
    appConnectionGeneration = 0,
    agentSnapshotComplete = false,
    bulkResetRunning = false,
    tryBeginBulkReset = () => null,
    endBulkReset = (_token: number) => {},
    onBulkResetSummary = () => {},
  }: {
    onClose: () => void;
    workSettings?: WorkSettingsSnapshot | null;
    isOperator?: boolean;
    onWorkSettings?: (snapshot: WorkSettingsSnapshot) => void;
    onOpenSessionLifecycle?: ((agentId: string) => void) | undefined;
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
    agents?: Record<string, Envelope>;
    directory?: Record<string, DirectoryEntry>;
    /** Reactive App join epoch; Phoenix may rejoin through the same client
     *  object, so connection identity alone is not a generation check. */
    appConnectionGeneration?: number;
    agentSnapshotComplete?: boolean;
    bulkResetRunning?: boolean;
    tryBeginBulkReset?: () => number | null;
    endBulkReset?: (token: number) => void;
    onBulkResetSummary?: (message: string) => void;
    /** Rally threshold in force (issue #307), or null before the first
     *  push. Owned by App.svelte so a change made elsewhere is reflected
     *  here without the drawer holding its own copy. */
    quagmireSettings?: QuagmireSettings | null;
    /** Change-log retention in force (issue 482), or null before the first
     *  push. Owned by App.svelte for the same reason as quagmireSettings. */
    statusLineSettings?: StatusLineSettings | null;
  } = $props();

  type TabId = "display" | "notifications" | "operations" | "administration";
  const TAB_ORDER: readonly TabId[] = [
    "display",
    "notifications",
    "operations",
    "administration",
  ];
  // A tab exists only while one of its items passes its own gate, so the
  // tab bar and the panels read the same flags: Operations holds the
  // isOperator item (work capacity) and the connection items, Administration
  // holds connection items only.
  const tabVisible = $derived<Record<TabId, boolean>>({
    display: true,
    notifications: true,
    operations: isOperator || !!connection,
    administration: !!connection,
  });
  const visibleTabs = $derived(TAB_ORDER.filter((id) => tabVisible[id]));
  let selectedTab = $state<TabId>("display");
  const activeTab = $derived(
    visibleTabs.includes(selectedTab) ? selectedTab : visibleTabs[0],
  );
  // Write the fallback back so a tab that comes back later (reconnect) does
  // not pull the selection away from where the operator now is.
  $effect(() => {
    if (selectedTab !== activeTab) selectedTab = activeTab;
  });

  function tabLabel(id: TabId): string {
    const t = msg().settingsDrawer;
    switch (id) {
      case "display":
        return t.tabDisplay;
      case "notifications":
        return t.tabNotifications;
      case "operations":
        return t.tabOperations;
      case "administration":
        return t.tabAdministration;
    }
  }

  function onTabKeydown(event: KeyboardEvent): void {
    const index = visibleTabs.indexOf(activeTab);
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % visibleTabs.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + visibleTabs.length) % visibleTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visibleTabs.length - 1;
    else return;
    event.preventDefault();
    selectedTab = visibleTabs[next];
    const buttons = event.currentTarget as HTMLElement;
    buttons.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  let retentionError = $state<string | null>(null);
  let lifecycleAgentId = $state("");

  function openSessionLifecycle(event: SubmitEvent): void {
    event.preventDefault();
    const id = lifecycleAgentId.trim();
    if (id === "" || !connection || !onOpenSessionLifecycle) return;
    onOpenSessionLifecycle(id);
  }

  function sourceText(source: "stored" | "env" | "default"): string {
    const t = msg().settingsDrawer;
    return source === "stored" ? t.sourceStored : source === "env" ? t.sourceEnv : t.sourceDefault;
  }

  const retentionSourceLabel = $derived(
    statusLineSettings === null
      ? msg().settingsDrawer.sourceFetching
      : sourceText(statusLineSettings.source),
  );

  // The browser lets any number through; the server rejects out-of-range
  // rather than clamping, so clamp first and tell the operator nothing odd.
  function commitRetention(raw: string): void {
    if (!connection || statusLineSettings === null) return;
    const parsed = Math.trunc(Number(raw));
    if (!Number.isFinite(parsed)) return;
    const value = Math.min(statusLineSettings.max, Math.max(statusLineSettings.min, parsed));
    retentionError = null;
    connection.setStatusLineRetention(value).catch((err: unknown) => {
      retentionError = err instanceof Error ? err.message : "error";
    });
  }

  let quagmireError = $state<string | null>(null);

  // Seed for the undo path only — what an unchecked "∞" sends when no
  // numeric threshold has been seen this session. The value IN FORCE is
  // always the one the server reports, never this.
  let lastNumericRallyTurns = $state(16);

  $effect(() => {
    const turns = quagmireSettings?.rallyTurns;
    if (typeof turns === "number") lastNumericRallyTurns = turns;
  });

  const rallyOff = $derived(quagmireSettings?.rallyTurns === null);

  const rallySourceLabel = $derived(
    quagmireSettings === null
      ? msg().settingsDrawer.sourceFetching
      : sourceText(quagmireSettings.source),
  );

  function commitRallyTurns(value: number | null): void {
    if (!connection) return;
    quagmireError = null;
    connection.setQuagmireSettings(value).catch((err: unknown) => {
      quagmireError = err instanceof Error ? err.message : "error";
    });
  }

  // The number input accepts anything the browser lets through, so clamp
  // before sending: the server rejects out-of-range rather than clamping,
  // and a rejection here would only tell the operator they guessed wrong.
  function commitTypedRallyTurns(raw: string): void {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) return;
    commitRallyTurns(Math.min(Math.max(parsed, 1), MAX_RALLY_TURNS));
  }

  // issue #276: fetched once per drawer open (no live push — mirrors
  // getLaunchDefaults' pure read-time query shape).
  let conversations = $state<ConversationSummary[] | null>(null);
  let conversationsError = $state<string | null>(null);
  let conversationsIncomplete = $state(false);
  let bulkResetPreparing = $state(false);
  let bulkResetError = $state<string | null>(null);
  let bulkResetExecuting = $state(false);
  let bulkResetTargets = $state<{
    connection: KaoiroConnection;
    appGeneration: number;
    lockToken: number;
    conversationIds: string[];
    agentIds: string[];
  } | null>(null);
  let bulkResetLockToken: number | null = null;
  let bulkResetPreparationGeneration = 0;

  // View state only; keep it out of the settings store so each drawer open hides closed rows again.
  let showClosedConversations = $state(false);
  const visibleConversations = $derived(
    visibleConversationSummaries(conversations ?? [], showClosedConversations),
  );
  const hiddenClosedCount = $derived(
    (conversations?.length ?? 0) - visibleConversations.length,
  );

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
    const appGeneration = appConnectionGeneration;
    connection
      .listConversations()
      .then((list) => {
        if (
          seq === refreshSeq &&
          appGeneration === appConnectionGeneration
        ) {
          conversations = list;
          conversationsError = null;
          conversationsIncomplete = list.incomplete;
        }
      })
      .catch((err: unknown) => {
        if (
          seq === refreshSeq &&
          appGeneration === appConnectionGeneration
        ) {
          conversationsError = err instanceof Error ? err.message : "error";
        }
      });
  }

  function bulkRunIsCurrent(
    target: NonNullable<typeof bulkResetTargets>,
  ): boolean {
    return (
      connection === target.connection &&
      appConnectionGeneration === target.appGeneration
    );
  }

  function releaseBulkResetLock(token: number): void {
    if (bulkResetLockToken !== token) return;
    bulkResetLockToken = null;
    endBulkReset(token);
  }

  async function prepareBulkReset(): Promise<void> {
    if (
      !connection ||
      !agentSnapshotComplete ||
      bulkResetRunning ||
      bulkResetPreparing
    ) {
      return;
    }

    const lockToken = tryBeginBulkReset();
    if (lockToken === null) return;
    bulkResetLockToken = lockToken;

    const capturedConnection = connection;
    const appGeneration = appConnectionGeneration;
    const preparationGeneration = ++bulkResetPreparationGeneration;
    const agentIds = Object.entries(agents)
      .filter(([, envelope]) => envelope.state !== "disconnected")
      .map(([id]) => id)
      .sort();
    let keepLockForConfirmation = false;
    bulkResetPreparing = true;
    bulkResetError = null;

    try {
      const conversations = await capturedConnection.listConversations();
      if (
        preparationGeneration !== bulkResetPreparationGeneration ||
        connection !== capturedConnection ||
        appConnectionGeneration !== appGeneration
      ) {
        return;
      }
      if (conversations.incomplete) {
        bulkResetError = msg().settingsDrawer.bulkListIncomplete;
        return;
      }
      if (!agentSnapshotComplete) {
        bulkResetError = msg().settingsDrawer.bulkAgentsMissing;
        return;
      }
      bulkResetTargets = {
        connection: capturedConnection,
        appGeneration,
        lockToken,
        conversationIds: conversations
          .filter((item) => item.status === "open")
          .map((item) => item.conversationId),
        agentIds,
      };
      keepLockForConfirmation = true;
    } catch (err) {
      if (
        connection === capturedConnection &&
        appConnectionGeneration === appGeneration
      ) {
        bulkResetError =
          err instanceof Error ? err.message : msg().settingsDrawer.conversationsRefreshFailed;
      }
    } finally {
      if (preparationGeneration === bulkResetPreparationGeneration) {
        bulkResetPreparing = false;
      }
      if (!keepLockForConfirmation) releaseBulkResetLock(lockToken);
    }
  }

  function cancelBulkReset(): void {
    if (bulkResetExecuting) return;
    bulkResetTargets = null;
    bulkResetError = null;
    if (bulkResetLockToken !== null) {
      releaseBulkResetLock(bulkResetLockToken);
    }
  }

  $effect(() => {
    if (
      bulkResetTargets &&
      bulkResetTargets.appGeneration !== appConnectionGeneration
    ) {
      cancelBulkReset();
    }
  });

  async function confirmBulkReset(): Promise<void> {
    const target = bulkResetTargets;
    if (!target || !bulkRunIsCurrent(target) || !agentSnapshotComplete) {
      cancelBulkReset();
      return;
    }

    const current = (): boolean =>
      bulkRunIsCurrent(target) && agentSnapshotComplete;
    bulkResetError = null;
    bulkResetExecuting = true;

    try {
      const summary = await executeBulkCleanup(
        target.connection, target.conversationIds, target.agentIds, current, () => agents,
      );
      if (summary !== null) onBulkResetSummary(msg().settingsDrawer.bulkSummary(summary));
    } finally {
      bulkResetExecuting = false;
      bulkResetTargets = null;
      releaseBulkResetLock(target.lockToken);
    }
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
      connectionGeneration += 1;
      bulkResetPreparationGeneration += 1;
      if (
        !bulkResetExecuting &&
        (bulkResetPreparing || bulkResetTargets)
      ) {
        bulkResetPreparing = false;
        bulkResetTargets = null;
        bulkResetError = null;
        if (bulkResetLockToken !== null) {
          releaseBulkResetLock(bulkResetLockToken);
        }
      }
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
      conversationsIncomplete = false;
      // issue #207 round 4 (こはく判定, ふじ round3 計測を受けて撤回):
      // unlike conversations above, this reset does NOT pair with a
      // cleanup-side usersRefreshSeq bump — that line was removed as
      // redundant. A reply from BEFORE this generation is still
      // rejected by refreshUsers()'s own per-call `++usersRefreshSeq`
      // on whichever fetch actually runs next; this reset alone still
      // has to cover a reply that lands and briefly sets `users` WHILE
      // connection is falsy (invisible, since the section is hidden) —
      // the very next effect re-run (including the one that reconnects
      // and starts the fresh fetch) runs this SAME cleanup again
      // first, clearing that leaked write before the new fetch's
      // result could ever render alongside it. `usersError` closes the
      // same way for a stale REJECT landing during the same window.
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
        if (isConversationAlreadyClosedError(err)) {
          confirmCloseTarget = null;
          closeError = null;
        } else {
          closeError = err instanceof Error ? err.message : "error";
        }
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

<Modal ariaLabel={msg().settingsDrawer.title} {onClose} contentClass="settings-drawer-content">
  {#snippet children()}
  <div class="drawer-header">
    <h2>{msg().settingsDrawer.title}</h2>
    <!-- svelte-ignore a11y_autofocus -- inside a native <dialog> opened
         via showModal() (Modal.svelte), autofocus is the spec-sanctioned
         initial-focus mechanism (issue #232 MF-3), not page-load
         autofocus (issue #277). -->
    <button
      type="button"
      class="close"
      onclick={onClose}
      aria-label={msg().common.close}
      autofocus
    >
      ×
    </button>
  </div>

  <!-- svelte-ignore a11y_interactive_supports_focus -- the handler only
       receives keydown bubbled from the focusable tabs inside; the tablist
       itself is not a tab stop. -->
  <div
    class="tabs"
    role="tablist"
    aria-label={msg().settingsDrawer.tabsAria}
    onkeydown={onTabKeydown}
  >
    {#each visibleTabs as id (id)}
      <button
        type="button"
        role="tab"
        id="settings-tab-{id}"
        class:active={activeTab === id}
        aria-selected={activeTab === id}
        aria-controls="settings-panel-{id}"
        tabindex={activeTab === id ? 0 : -1}
        onclick={() => (selectedTab = id)}
      >
        {tabLabel(id)}
      </button>
    {/each}
  </div>

  <div
    role="tabpanel"
    class="panel"
    id="settings-panel-display"
    aria-labelledby="settings-tab-display"
    hidden={activeTab !== "display"}
  >
    <LanguageSelect />

    <label class="row">
      <input
        type="checkbox"
        checked={settings.agentCardStatsEnabled}
        onchange={(e) =>
          updateSettings({
            agentCardStatsEnabled: e.currentTarget.checked,
          })}
      />
      {msg().settingsDrawer.statsToggle}
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
      {msg().settingsDrawer.hideNonMessage}
    </label>

    <label class="grid-sort">
      {msg().settingsDrawer.gridSort}
      <select
        value={settings.gridSort}
        onchange={(e) =>
          updateSettings({
            gridSort: e.currentTarget.value === "recent" ? "recent" : "name",
          })}
      >
        <option value="name">{msg().settingsDrawer.sortName}</option>
        <option value="recent">{msg().settingsDrawer.sortRecent}</option>
      </select>
    </label>
  </div>

  <div
    role="tabpanel"
    class="panel"
    id="settings-panel-notifications"
    aria-labelledby="settings-tab-notifications"
    hidden={activeTab !== "notifications"}
  >
    <label class="row">
      <input
        type="checkbox"
        checked={settings.notificationSoundEnabled}
        onchange={(e) =>
          updateSettings({
            notificationSoundEnabled: e.currentTarget.checked,
          })}
      />
      {msg().settingsDrawer.notificationSound}
    </label>

    <label>
      {msg().settingsDrawer.volume}
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
  </div>

  {#if tabVisible.operations}
    <div
      role="tabpanel"
      class="panel"
      id="settings-panel-operations"
      aria-labelledby="settings-tab-operations"
      hidden={activeTab !== "operations"}
    >
      {#if isOperator}
        <WorkCapacitySettings {connection} generation={appConnectionGeneration} snapshot={workSettings} onSnapshot={onWorkSettings} />
      {/if}

      {#if connection}
        {#if onOpenSessionLifecycle}
          <section class="session-lifecycle">
            <h3>{msg().settingsDrawer.sessionHistory}</h3>
            <form onsubmit={openSessionLifecycle}>
              <label for="lifecycle-agent-id">{msg().settingsDrawer.agentId}</label>
              <input id="lifecycle-agent-id" bind:value={lifecycleAgentId} list="lifecycle-agent-ids" placeholder="host-a.agent-1" />
              <datalist id="lifecycle-agent-ids">
                {#each [...new Set([...Object.keys(agents), ...Object.keys(directory)])].sort() as id}
                  <option value={id}></option>
                {/each}
              </datalist>
              <button type="submit" disabled={lifecycleAgentId.trim() === ""}>{msg().settingsDrawer.showHistory}</button>
            </form>
            <p>{msg().settingsDrawer.deletedAgentsHint}</p>
          </section>
        {/if}

        <section class="quagmire">
          <h3>{msg().settingsDrawer.quagmireTitle}</h3>
          <p class="hint">
            {msg().settingsDrawer.quagmireHint({ source: rallySourceLabel })}
          </p>

          <label class="row">
            <input
              type="checkbox"
              checked={rallyOff}
              onchange={(e) =>
                commitRallyTurns(
                  e.currentTarget.checked ? null : lastNumericRallyTurns,
                )}
            />
            {msg().settingsDrawer.neverDetect}
          </label>

          <label>
            {msg().settingsDrawer.threshold}
            <input
              type="range"
              min="4"
              max="64"
              step="1"
              value={quagmireSettings?.rallyTurns ?? lastNumericRallyTurns}
              disabled={rallyOff}
              onchange={(e) => commitRallyTurns(Number(e.currentTarget.value))}
            />
            <span class="value"
              >{rallyOff
                ? "∞"
                : msg().settingsDrawer.turnsCount({ n: quagmireSettings?.rallyTurns ?? lastNumericRallyTurns })}</span
            >
          </label>

          <label>
            {msg().settingsDrawer.directInput({ max: MAX_RALLY_TURNS })}
            <input
              type="number"
              min="1"
              max={MAX_RALLY_TURNS}
              value={quagmireSettings?.rallyTurns ?? lastNumericRallyTurns}
              disabled={rallyOff}
              onchange={(e) => commitTypedRallyTurns(e.currentTarget.value)}
            />
          </label>

          {#if quagmireError}
            <p class="error">{msg().settingsDrawer.thresholdError({ reason: quagmireError })}</p>
          {/if}
        </section>

        <section class="status-retention">
          <h3>{msg().settingsDrawer.retentionTitle}</h3>
          <p class="hint">
            {msg().settingsDrawer.retentionHint({ source: retentionSourceLabel })}
          </p>
          <label>
            {statusLineSettings
              ? msg().settingsDrawer.retentionLabelRange({ min: statusLineSettings.min, max: statusLineSettings.max })
              : msg().settingsDrawer.retentionLabel}
            <input
              type="number"
              min={statusLineSettings?.min ?? 1}
              max={statusLineSettings?.max ?? 100}
              value={statusLineSettings?.retention ?? ""}
              disabled={statusLineSettings === null}
              onchange={(e) => commitRetention(e.currentTarget.value)}
            />
          </label>
          {#if retentionError}
            <p class="error">{msg().settingsDrawer.retentionError({ reason: retentionError })}</p>
          {/if}
        </section>

        <section class="bulk-reset">
          <h3>{msg().settingsDrawer.bulkTitle}</h3>
          <p class="hint">{msg().settingsDrawer.bulkHint}</p>
          <button
            type="button"
            class="danger"
            onclick={prepareBulkReset}
            disabled={!agentSnapshotComplete || bulkResetRunning || bulkResetPreparing}
          >
            {bulkResetPreparing ? msg().settingsDrawer.bulkChecking : msg().settingsDrawer.bulkButton}
          </button>
          {#if bulkResetError}
            <p class="conv-status" role="status">{msg().settingsDrawer.bulkPrepareFailed({ reason: bulkResetError })}</p>
          {/if}
        </section>
      {/if}
    </div>
  {/if}

  {#if tabVisible.administration}
    <div
      role="tabpanel"
      class="panel"
      id="settings-panel-administration"
      aria-labelledby="settings-tab-administration"
      hidden={activeTab !== "administration"}
    >
      <section class="conversations">
        <div class="conversations-header">
          <h3>{msg().settingsDrawer.conversationsTitle}</h3>
          <button
            type="button"
            class="refresh"
            onclick={refreshConversations}
            aria-label={msg().settingsDrawer.refreshConversationsAria}
          >
            {msg().settingsDrawer.refresh}
          </button>
        </div>
        <div class="conversation-filters">
          <label class="conversation-toggle">
            <input type="checkbox" bind:checked={showClosedConversations} />
            {msg().settingsDrawer.showClosed}
          </label>
          {#if !showClosedConversations && hiddenClosedCount > 0}
            <span class="conv-status">{msg().settingsDrawer.hiddenClosed({ n: hiddenClosedCount })}</span>
          {/if}
        </div>
        {#if conversationsError}
          <p class="conv-status">{msg().settingsDrawer.fetchFailed({ reason: conversationsError })}</p>
        {:else}
          {#if conversationsIncomplete}
            <p class="conv-status">{msg().settingsDrawer.partialConversations}</p>
          {/if}
        {/if}
        {#if !conversationsError && conversations === null}
          <p class="conv-status">{msg().common.loading}</p>
        {:else if !conversationsError && conversations && visibleConversations.length === 0}
          <p class="conv-status">{msg().settingsDrawer.noOpenConversations}</p>
        {:else if !conversationsError && conversations}
          <ul class="conv-list">
            {#each visibleConversations as conv (conv.conversationId)}
              <li>
                <span class="conv-participants">
                  {#each conv.participants as agentId, index}
                    {#if index > 0}<span aria-hidden="true">{" ⇔ "}</span>{/if}
                    <span title={agentId}>{agentDisplayName(agentId, agents, directory)}</span>
                  {/each}
                </span>
                <span class="conv-cid" title={conv.conversationId}
                  >cid:{conv.conversationId.slice(0, 8)}</span
                >
                <span class="conv-meta">
                  {conv.turns} turns / {conv.status}
                  {#if formatStartedAt(conv.startedAt)}
                    / {formatStartedAt(conv.startedAt)}
                  {/if}
                </span>
                {#if conv.quagmire}
                  <span
                    class="conv-rally"
                    title="{conv.rallyTurns} messages across {conv.rallyConversations} conversations between these participants (issue #273)"
                    >rally {conv.rallyTurns}</span
                  >
                {/if}
                {#if conv.status === "open"}
                  <button
                    type="button"
                    class="conv-close"
                    onclick={() => (confirmCloseTarget = conv)}
                  >
                    {msg().settingsDrawer.closeConversation}
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
          <h3>{msg().settingsDrawer.usersTitle}</h3>
          <button
            type="button"
            class="refresh"
            onclick={refreshUsers}
            aria-label={msg().settingsDrawer.refreshUsersAria}
          >
            {msg().settingsDrawer.refresh}
          </button>
        </div>
        {#if usersError}
          <p class="user-status">{msg().settingsDrawer.fetchFailed({ reason: usersError })}</p>
        {:else if users === null}
          <p class="user-status">{msg().common.loading}</p>
        {:else if users.length === 0}
          <p class="user-status">{msg().settingsDrawer.noUsers}</p>
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
                      aria-label={msg().settingsDrawer.displayNameAria({ id: u.id })}
                    />
                    <button
                      type="button"
                      onclick={submitRename}
                      disabled={renaming}
                    >
                      {renaming ? msg().settingsDrawer.saving : msg().settingsDrawer.save}
                    </button>
                    <button
                      type="button"
                      onclick={cancelRename}
                      disabled={renaming}
                    >
                      {msg().settingsDrawer.cancel}
                    </button>
                  </div>
                  {#if renameError}
                    <p class="user-status">{msg().settingsDrawer.failed({ reason: renameError })}</p>
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
                    {msg().settingsDrawer.rename}
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}

  {#if connection && confirmCloseTarget}
    <Modal
      ariaLabel={msg().settingsDrawer.confirmCloseAria}
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
          <p>{msg().settingsDrawer.confirmClose}</p>
          <p class="confirm-target">
            <span class="conv-participants">
              {#each confirmCloseTarget.participants as agentId, index}
                {#if index > 0}<span aria-hidden="true">{" ⇔ "}</span>{/if}
                <span title={agentId}>{agentDisplayName(agentId, agents, directory)}</span>
              {/each}
            </span>
            <span class="conv-cid" title={confirmCloseTarget.conversationId}
              >cid:{confirmCloseTarget.conversationId.slice(0, 8)}</span
            >
          </p>
        {/if}
        {#if closeError}
          <p class="conv-status">{msg().settingsDrawer.failed({ reason: closeError })}</p>
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
            {msg().settingsDrawer.cancel}
          </button>
          <button
            type="button"
            class="danger"
            onclick={handleConfirmClose}
            disabled={closing}
          >
            {closing ? msg().settingsDrawer.closing : msg().settingsDrawer.closeConversation}
          </button>
        </div>
      {/snippet}
    </Modal>
  {/if}

  {#if connection && bulkResetTargets && bulkResetTargets.appGeneration === appConnectionGeneration}
    <Modal
      ariaLabel={msg().settingsDrawer.bulkConfirmAria}
      onClose={cancelBulkReset}
    >
      {#snippet children()}
        {#if bulkResetTargets}
          <p>
            {msg().settingsDrawer.bulkConfirm({
              conversations: bulkResetTargets.conversationIds.length,
              agents: bulkResetTargets.agentIds.length,
            })}
          </p>
          <div class="confirm-actions">
            <!-- svelte-ignore a11y_autofocus -- Modal opens a native
                 dialog with showModal(), where autofocus selects the
                 non-destructive cancel action. -->
            <button
              type="button"
              class="cancel"
              onclick={cancelBulkReset}
              disabled={bulkResetExecuting}
              autofocus
            >
              {msg().settingsDrawer.cancel}
            </button>
            <button
              type="button"
              class="danger"
              onclick={confirmBulkReset}
              disabled={bulkResetExecuting}
            >
              {bulkResetExecuting ? msg().settingsDrawer.processing : msg().settingsDrawer.execute}
            </button>
          </div>
        {/if}
      {/snippet}
    </Modal>
  {/if}

  {#if onLogout}
    <button
      type="button"
      class="logout"
      onclick={() => void onLogout?.()}
    >
      {msg().settingsDrawer.logout}
    </button>
  {/if}
  {/snippet}
</Modal>

<style>
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .tabs button {
    flex: 1 1 auto;
    padding: 0.35rem 0.5rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .tabs button.active {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* display:flex above would otherwise beat the UA rule for [hidden]. */
  .panel[hidden] {
    display: none;
  }

  .session-lifecycle form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; }
  .session-lifecycle form label { grid-column: 1 / -1; }
  .session-lifecycle input { min-width: 0; }
  .session-lifecycle p { margin: 0; font-size: var(--fs-body-sm); color: var(--fg-dim); }
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
    max-block-size: 100dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
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

  h3 { font-size: var(--fs-body-sm); color: var(--fg-dim); }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .grid-sort select { width: 100%; min-width: 0; }

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

  .conversation-filters {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }

  .conversation-toggle {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-body-sm);
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

  .bulk-reset {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .bulk-reset h3 {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .bulk-reset .hint {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .bulk-reset button {
    align-self: flex-start;
    padding: 0.35rem 0.8rem;
    font-size: var(--fs-body-sm);
    color: var(--c-error);
    background: transparent;
    border: 1px solid var(--c-error);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .bulk-reset button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* issue #207: .user-status/.user-list/etc. share these declarations
     via combined selectors -- distinct class names (see the markup
     comment above the users section) so tests/queries never have to
     disambiguate which section a match came from, but no duplicated
     CSS. */
  .conv-status,
  .user-status,
  .status-retention .hint,
  .quagmire .hint {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .status-retention .error,
  .quagmire .error {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--c-error);
  }

  .status-retention input[type="number"],
  .quagmire input[type="number"] {
    width: 6rem;
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

  .conv-rally {
    padding: 0 0.35em;
    border-radius: 0.25em;
    background: color-mix(in srgb, var(--c-tool_running) 22%, var(--bg-card));
    color: var(--c-tool_running);
    white-space: nowrap;
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
    color: var(--c-error);
    border-color: var(--c-error);
  }

  .confirm-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
