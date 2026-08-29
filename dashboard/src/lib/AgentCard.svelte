<script lang="ts">
  import { untrack } from "svelte";
  import { expressionFor, isFatigued, spriteStateFor, spriteUrlFor } from "./expression";
  import PersonaFace from "./PersonaFace.svelte";
  import { StatusQueue } from "./statusDisplay.svelte";
  import TaskRing from "./TaskRing.svelte";
  import {
    engineFrom,
    pendingPermissionFrom,
    pendingQuestionFrom,
    RUNNING_STATES,
    STOP_SAFE_STATES,
  } from "./protocol";
  import type { Envelope, PersonaManifest } from "./protocol";
  import { settings } from "./settings.svelte";

  let {
    envelope,
    manifest = null,
    directoryOnly = false,
    activeTaskCount = 0,
    spawnError = null,
    onSelect,
    onInterrupt,
    onStop,
    onRestore,
    onDelete,
    onOpenPersonaDetail,
  }: {
    envelope: Envelope;
    manifest?: PersonaManifest | null;
    /** True when this tile is rendered from an AgentDirectory entry that has
     *  no live AgentStates counterpart (server restarted after this agent was
     *  last seen — ADR-0030). Enables the restore button unconditionally
     *  (server-side SessionPointer check decides success) and shows an
     *  "offline" label overlay so the operator can tell it apart from a
     *  merely disconnected live entry. */
    directoryOnly?: boolean;
    /** Count of subagent/workflow tasks currently active under this agent
     *  (ADR-0019/0047/0048, issue #180). Drives the 頭上リング (overhead
     *  ring) animation only when > 0 — the value itself is not displayed
     *  (numeric display was explicitly out of scope for this issue).
     *  Always 0 for a viewer session (App.svelte's task snapshot/live feed
     *  are operator-only, ADR-0021), so the ring never renders there. */
    activeTaskCount?: number;
    /** Latest restore/spawn failure reason for this agent — sticky icon in
     *  the tile corner until the agent comes online again or is restored
     *  successfully (ADR-0030 D8). Null clears it. */
    spawnError?: string | null;
    // exactOptionalPropertyTypes: undefined must be in the type since
    // App.svelte conditionally passes undefined when there is no connection
    // (or when a directory-only tile has no detail view to open).
    /** Receives the tile's centre so the detail can expand from it (#36);
     *  pass undefined to disable the click-to-detail affordance. */
    onSelect?: ((origin?: { x: number; y: number }) => void) | undefined;
    /** ESC equivalent (#51); pass undefined to hide the button. */
    onInterrupt?: (() => Promise<void>) | undefined;
    /** Terminate the wrapper (#22); pass undefined to hide the button. */
    onStop?: (() => Promise<void>) | undefined;
    /** Restore a disconnected agent (#22, ADR-0014); pass undefined to hide
     *  the button (e.g. no connection / viewer). */
    onRestore?: (() => Promise<void>) | undefined;
    /** Remove a disconnected agent (#14); pass undefined to hide the
     *  button (e.g. no connection / viewer). */
    onDelete?: (() => Promise<void>) | undefined;
    /** Opens the persona pack detail modal (issue #232) for this agent's
     *  persona; pass undefined to disable the image's click affordance
     *  (e.g. no resolved persona id). */
    onOpenPersonaDetail?: ((personaId: string) => void) | undefined;
  } = $props();

  // issue #232 MF-2 round-2 must-fix (MF-R2-1): the expand origin must be
  // the CARD's centre regardless of which button the click landed on —
  // `.open` no longer covers the whole card (the image sits outside it in
  // `.card-media`), so `event.currentTarget`'s own rect would give a
  // smaller/offset box depending on which sibling fired the click.
  // `cardEl` (the <article> itself) is the one stable reference both
  // `selectFrom` call sites below share.
  let cardEl: HTMLElement | undefined = $state();

  // Hand the detail the tile's viewport centre so it grows from this tile.
  function selectFrom(event: MouseEvent): void {
    const rect = (cardEl ?? (event.currentTarget as HTMLElement)).getBoundingClientRect();
    onSelect?.({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }

  // issue #232 MF-2 (ふじ round-1 must-fix): the persona image's click
  // opens the persona pack detail modal, as a SIBLING <button> to `.open`
  // rather than nested inside it or reached by dispatching on click
  // coordinates from `.open`'s own handler (the earlier pointer-only
  // design — a keyboard user tabbing into `.open` and pressing
  // Enter/Space had no way to land on the persona action; ふじ measured
  // onSelect fired, onOpenPersonaDetail never did). `.card-media` (below)
  // is the new position:relative wrapper carrying `.lamp`/`.error-icon`/
  // etc.'s absolute positioning, unchanged in effect from when `.open`
  // carried it.
  const personaId = $derived(envelope.persona?.id);

  // issue #232 MF-2 round-2 must-fix (MF-R2-1, ふじ probe): making
  // `.persona-open` `disabled` whenever there is no persona action (no
  // onOpenPersonaDetail — e.g. a viewer session, App.svelte's isOperator
  // gate — or no resolved persona id) made the image's click a dead end.
  // Before the sibling split, that same click fell through to
  // `selectFrom` (the whole card was one `.open` button). Route it back
  // there instead of disabling the click affordance outright —
  // `directoryOnly` is the one condition that must still suppress it
  // (an offline tile has no detail view to open at all, persona or
  // otherwise).
  function handlePersonaOpenClick(event: MouseEvent): void {
    if (personaId && onOpenPersonaDetail) {
      onOpenPersonaDetail(personaId);
      return;
    }
    selectFrom(event);
  }

  // Displayed state lags the live state for min readability + crossfade (#43);
  // the needs-attention badge below still tracks the live state for immediacy.
  const display = new StatusQueue(untrack(() => envelope.state));
  $effect(() => {
    display.push(envelope.state);
  });
  $effect(() => () => display.dispose());
  // While the permission dialog is open (#82), pin the lamp/label to
  // waiting_permission. The card mirrors AgentDetail so the grid and the
  // detail never disagree on the sticky display.
  $effect(() => {
    if (pendingPermissionFrom(envelope)) display.hold("waiting_permission");
    else if (pendingQuestionFrom(envelope)) display.hold("waiting_question");
    else display.unhold();
  });

  const expression = $derived(expressionFor(display.shown));
  const name = $derived(envelope.display_name ?? envelope.agent_id);
  const fatigued = $derived(isFatigued(envelope));
  const spriteUrl = $derived(
    spriteUrlFor(
      manifest,
      envelope.persona?.sprite_set,
      spriteStateFor(display.shown, fatigued),
    ),
  );
  // Needs-attention badge (ADR-0012 F6): approval/error draw the eye on the
  // grid; the actual allow/deny happens in the detail view.
  const attention = $derived(
    envelope.state === "waiting_permission" ||
      envelope.state === "waiting_question" ||
      envelope.state === "error",
  );

  // --- engine·model·effort / ctx·5h·7day stats (issue #193) ---
  // agent_id itself (the existing `.id` element below) predates #193 and is
  // NOT part of this block or its settings toggle — it is a top-level
  // envelope field the server sends to viewers too, so it cannot be gated
  // by ext-presence, and this issue never asked it to be (director
  // clarification, round 2: the issue text calling for an "agent_id row"
  // was written before noticing the row already existed).
  // Everything else here is sourced from ext.*, which the server never
  // delivers to viewers (ADR-0021) — so "render only when the field is
  // present" alone already satisfies the operator-only requirement without
  // a separate role check. Kept local (not shared with AgentDetail.svelte,
  // which has its own richer capability-gated version): #193 scopes
  // AgentDetail as out of bounds, and this card only needs a plain
  // "show if present" read, not AgentDetail's switch-state / capability
  // tri-state machinery.

  /** Normalise a rate-limit utilization (0-1 fraction, or already a
   *  percentage) to an integer 0..100. */
  function pctNorm(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const pct = value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /** Clamp an already-percentage value (0-100) — ctx's used_percentage. */
  function pctClamp(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  /** Work-budget use can legitimately exceed 100%, unlike a raw-window
   * percentage. Keep that signal visible instead of clamping it away. */
  function pctUnbounded(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : null;
  }

  function numOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  }

  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }

  /** A finite epoch ms, or null for anything that would render as an
   *  Invalid Date (out of JS's representable range despite being a finite
   *  number — ふじ round-2 S2). Centralised here so every consumer (the
   *  resetComplete check, fmtHHMM, fmtMD, the timer's deadline scan) is
   *  covered without re-checking `new Date(...).getTime()` at each site. */
  function resetAtMs(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(new Date(ms).getTime()) ? ms : null;
  }

  /** Non-empty (post-trim) string, or null — ふじ round-2 S2: ccModel /
   *  ccEffort must reject "" the same way protocol.ts's engineFrom does,
   *  and additionally reject whitespace-only values so a blank-but-present
   *  field cannot render as an empty slot in the combined meta line. */
  function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }

  /** HH:MM, 24h, zero-padded — the 5h bar's reset display (e.g. "05:24"). */
  function fmtHHMM(atMs: number): string {
    const d = new Date(atMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  }

  /** M/D, no zero-padding — the 7day bar's reset display (e.g. "8/7"). */
  function fmtMD(atMs: number): string {
    const d = new Date(atMs);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  const agentEngine = $derived(engineFrom(envelope));
  const ccModel = $derived(nonEmptyString(envelope.ext?.model));
  const ccEffort = $derived.by(() => {
    const raw = envelope.ext?.effective;
    if (typeof raw !== "object" || raw === null) return null;
    return nonEmptyString((raw as Record<string, unknown>).effort);
  });
  // Combined engine/model/effort line (issue #193 sketch: one row). Missing
  // fields drop out of the join; the whole line hides only once ALL three
  // are absent, so a partial ext payload still shows what it has.
  const metaLine = $derived(
    [agentEngine, ccModel, ccEffort].filter((v) => v !== null).join(" / "),
  );

  const ccContext = $derived(
    envelope.ext?.context as Record<string, unknown> | undefined,
  );
  const ctxPct = $derived(pctClamp(ccContext?.used_percentage));
  const ctxUsed = $derived(numOrNull(ccContext?.used_tokens));
  const ctxMax = $derived(numOrNull(ccContext?.max_tokens));
  const ccContextBudget = $derived(
    envelope.ext?.context_budget as Record<string, unknown> | undefined,
  );
  const ctxBudgetTokens = $derived(
    (() => {
      const value = numOrNull(ccContextBudget?.work_budget_tokens);
      return value !== null && value > 0 ? value : null;
    })(),
  );
  const ctxBudgetPct = $derived(
    pctUnbounded(ccContextBudget?.work_budget_percentage),
  );
  const ccRateLimits = $derived(
    envelope.ext?.rate_limits as Record<string, unknown> | undefined,
  );

  interface RateBar {
    pct: number | null;
    reset: string | null;
    status: string | undefined;
    resetComplete: boolean;
  }

  /** rate_limits is a last-turn snapshot (does not update while idle) — once
   *  its resets_at has passed, its utilization/status describe a dead
   *  window and must not read as live usage (issue #193). Equality stays
   *  live, matching AgentDetail's identical rule. Returns null both when the
   *  window is absent AND when it carries nothing displayable (no pct, no
   *  reset, not reset-complete) — the row hides rather than showing a bare
   *  "?", which would only clutter this compact card. */
  function buildRateBar(
    raw: unknown,
    fmtReset: (atMs: number) => string,
    now: number,
  ): RateBar | null {
    if (typeof raw !== "object" || raw === null) return null;
    const win = raw as Record<string, unknown>;
    const resetsAt = resetAtMs(win.resets_at);
    const resetComplete = resetsAt !== null && resetsAt < now;
    const pct = resetComplete ? 0 : pctNorm(win.utilization);
    const reset = !resetComplete && resetsAt !== null ? fmtReset(resetsAt) : null;
    if (pct === null && reset === null && !resetComplete) return null;
    return {
      pct,
      reset,
      status: resetComplete
        ? "allowed"
        : typeof win.status === "string"
          ? win.status
          : undefined,
      resetComplete,
    };
  }

  function rateBarLabel(bar: RateBar): string {
    if (bar.resetComplete) return "リセット済み";
    const parts: string[] = [];
    if (bar.pct !== null) parts.push(`${bar.pct}%`);
    if (bar.reset !== null) parts.push(bar.reset);
    return parts.length > 0 ? parts.join(" ・ ") : "?";
  }

  // Browser/Node timers clamp a delay above signed int32 to 1ms.
  const MAX_TIMER_DELAY_MS = 2_147_483_647;

  // A snapshot's resets_at can pass while this card sits untouched in the
  // grid (no new envelope to re-derive from) — wake once at that boundary so
  // a stale window falls to "リセット済み" without waiting on next activity.
  // ふじ round-2 S1: gated on the toggle (a grid can hold many cards, and
  // #184 already paid down a dashboard input-lag regression from a similar
  // per-tile-timer cost — a hidden card must not keep one alive) and scoped
  // to only the two windows actually rendered, so an unrendered window
  // (`seven_day_opus`, `overage`, ...) cannot arm a timer for a bar nobody
  // sees. Reading `settings.agentCardStatsEnabled` here makes toggling it
  // off a reactive dependency: Svelte re-runs this effect, invoking the
  // PREVIOUS run's cleanup (clearing any live timer) before the guard below
  // exits early with no new one.
  let statsClock = $state(Date.now());
  $effect(() => {
    if (!settings.agentCardStatsEnabled) return;
    const limits = ccRateLimits;
    statsClock;
    const now = Date.now();
    let next: number | null = null;
    for (const key of ["five_hour", "seven_day"] as const) {
      const win = limits?.[key];
      if (typeof win !== "object" || win === null) continue;
      const at = resetAtMs((win as Record<string, unknown>).resets_at);
      if (at !== null && at >= now && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    const timer = window.setTimeout(
      () => {
        statsClock = Date.now();
      },
      Math.min(Math.max(0, next - now) + 1, MAX_TIMER_DELAY_MS),
    );
    return () => window.clearTimeout(timer);
  });

  const fiveHourBar = $derived.by(() => {
    statsClock;
    return buildRateBar(ccRateLimits?.five_hour, fmtHHMM, Date.now());
  });
  const sevenDayBar = $derived.by(() => {
    statsClock;
    return buildRateBar(ccRateLimits?.seven_day, fmtMD, Date.now());
  });
  const hasStats = $derived(
    settings.agentCardStatsEnabled &&
      (metaLine !== "" ||
        ctxPct !== null ||
        fiveHourBar !== null ||
        sevenDayBar !== null),
  );

  // Interrupt button visible only when the agent is executing (#51 C2). Live
  // state, not the display-lagged one — immediacy matters for an ESC button.
  // RUNNING_STATES is shared with AgentDetail via protocol.ts so the lobby
  // tile and the detail view never drift on what counts as "executing".
  const canInterrupt = $derived(
    onInterrupt !== undefined && RUNNING_STATES.has(envelope.state),
  );

  let interrupting = $state(false);

  async function handleInterrupt(event: MouseEvent): Promise<void> {
    // Don't open the detail when the operator clicks ESC on the lobby tile.
    event.stopPropagation();
    if (interrupting || !onInterrupt) return;
    interrupting = true;
    try {
      await onInterrupt();
    } catch (err) {
      // Surface only on the console: the detail view carries the real
      // feedback channel; this button trades visibility for one-click reach.
      console.warn("interrupt failed:", err);
    } finally {
      interrupting = false;
    }
  }

  // Terminate button for any connected agent (#22): ends the wrapper process
  // (distinct from interrupt, which only stops the current turn). Hidden once
  // disconnected — there is nothing left to terminate (delete handles those).
  const canStop = $derived(
    onStop !== undefined && envelope.state !== "disconnected",
  );

  let stopping = $state(false);

  async function handleStop(event: MouseEvent): Promise<void> {
    // Don't open the detail when the operator clicks terminate on the tile.
    event.stopPropagation();
    if (stopping || !onStop) return;
    // Warn before terminating an agent that is mid-work (#22); idle / your
    // turn / done are safe and skip the confirm.
    if (!STOP_SAFE_STATES.has(envelope.state)) {
      // Use the LIVE state for the label so it matches the gate above; the
      // card's `expression` is display-lagged (StatusQueue) and could name a
      // stale state in the warning.
      const liveLabel = expressionFor(envelope.state).label;
      const ok = window.confirm(
        `「${name}」は${liveLabel}です。終了すると進行中の作業は失われる可能性があります。終了しますか?`,
      );
      if (!ok) return;
    }
    stopping = true;
    try {
      await onStop();
    } catch (err) {
      console.warn("stop failed:", err);
    } finally {
      stopping = false;
    }
  }

  // Restore button for a disconnected agent (#22, ADR-0014). Re-spawns the
  // same agent_id; the server fills cwd + session_id from its SessionPointer,
  // so this never gates on client-side session_id — a wrapper that dropped
  // before emitting session_change (hot reload, early crash) still gets the
  // button, and any missing-pointer failure surfaces via spawnError
  // (ADR-0030 D8). Bottom-left, where the (now-hidden) terminate chip sat.
  const canRestore = $derived(
    onRestore !== undefined && envelope.state === "disconnected",
  );

  let restoring = $state(false);

  async function handleRestore(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (restoring || !onRestore) return;
    restoring = true;
    try {
      await onRestore();
    } catch (err) {
      console.warn("restore failed:", err);
    } finally {
      restoring = false;
    }
  }

  // Delete button only for a disconnected agent (#14); mutually exclusive
  // with the interrupt button (running vs disconnected never overlap).
  const canDelete = $derived(
    onDelete !== undefined && envelope.state === "disconnected",
  );

  let deleting = $state(false);

  async function handleDelete(event: MouseEvent): Promise<void> {
    // Don't open the detail when the operator clicks delete on the tile.
    event.stopPropagation();
    if (deleting || !onDelete) return;
    const ok = window.confirm(
      `オフラインのエージェント「${name}」を完全に削除します。` +
        `保存された persona / session ポインタ / permission_mode も破棄され、` +
        `以後この agent_id は復元できなくなります。よろしいですか?`,
    );
    if (!ok) return;
    deleting = true;
    try {
      await onDelete();
    } catch (err) {
      console.warn("delete failed:", err);
    } finally {
      deleting = false;
    }
  }
</script>

<article
  class="card"
  data-state={expression.variant}
  class:directory-only={directoryOnly}
  bind:this={cardEl}
>
  <!-- issue #232 MF-2: position:relative wrapper for `.lamp`/
       `.offline-label`/`.error-icon`/`.badge` — carries the same
       absolute-positioning basis `.open` used to, now that `.open` no
       longer wraps the image. -->
  <div class="card-media">
    <span class="lamp" title={expression.label}></span>
    {#if directoryOnly}
      <span class="offline-label" aria-label="オフライン">offline</span>
    {/if}
    {#if spawnError}
      <span class="error-icon" title="復元失敗: {spawnError}" aria-label="復元失敗">⚠</span>
    {/if}
    {#if attention}
      <span class="badge" data-state={expression.variant}>要対応</span>
    {/if}
    <div class="sprite-slot">
      <!-- issue #232 MF-2: own <button>, sibling to `.open` below — a
           keyboard user can now Tab to this action directly instead of
           it being unreachable except by mouse. disabled when there is
           nothing to open (directoryOnly / no resolved persona id / no
           handler), mirroring AgentDetail's `.portrait-open`. -->
      <button
        type="button"
        class="persona-open"
        onclick={directoryOnly ? undefined : handlePersonaOpenClick}
        disabled={directoryOnly}
        aria-label={personaId && onOpenPersonaDetail
          ? `${name} のペルソナ詳細を表示`
          : `${name} の詳細を開く`}
      >
        {#key display.shown}
          <PersonaFace
            sprite={spriteUrl}
            variant={expression.variant}
            label={expression.label}
            fatigued={fatigued}
            size="card"
            imgAltLabelled={true}
            faceLabelled={true}
          />
        {/key}
      </button>
      {#if activeTaskCount > 0}
        <!-- 頭上リング (issue #180, ADR-0019/0047/0048)。実装は
             TaskRing.svelte(AgentDetail と共有、issue #180 follow-up
             2026-08-10)。{#key} の外に置き、state 遷移(dissolve
             remount)の影響を受けず単独で回り続ける。 -->
        <TaskRing faceOrbit={!spriteUrl} count={activeTaskCount} />
      {/if}
    </div>
  </div>
  <button
    type="button"
    class="open"
    onclick={directoryOnly ? undefined : selectFrom}
    aria-label={directoryOnly
      ? `${name} (オフライン)`
      : `${name} の詳細を開く`}
    disabled={directoryOnly}
  >
    <h2>{name}</h2>
    {#key display.shown}
      <p class="state">{expression.label}</p>
    {/key}
    <p class="id">{envelope.agent_id}</p>
    {#if hasStats}
      <div class="stats">
        {#if metaLine !== ""}
          <p class="meta-line">{metaLine}</p>
        {/if}
        {#if ctxPct !== null}
          <div class="stat-row">
            <span class="stat-label">生窓</span>
            <div class="meter">
              <div class="meter-fill" style:width="{ctxPct}%"></div>
            </div>
            <span class="meter-val">
              {ctxPct}%
              {#if ctxUsed !== null && ctxMax !== null}
                ({fmtTokens(ctxUsed)}/{fmtTokens(ctxMax)})
              {/if}
            </span>
          </div>
        {/if}
        {#if ctxPct !== null && ctxUsed !== null && ctxBudgetPct !== null && ctxBudgetTokens !== null}
          <div class="stat-row">
            <span class="stat-label">作業予算</span>
            <div class="meter">
              <div
                class="meter-fill"
                style:width="{Math.min(ctxBudgetPct, 100)}%"
              ></div>
            </div>
            <span class="meter-val">
              {ctxBudgetPct}%
              ({fmtTokens(ctxUsed)}/{fmtTokens(ctxBudgetTokens)})
            </span>
          </div>
        {/if}
        {#if fiveHourBar !== null}
          <div class="stat-row">
            <span class="stat-label">5h</span>
            <div class="meter" data-status={fiveHourBar.status}>
              <div class="meter-fill" style:width="{fiveHourBar.pct ?? 0}%"></div>
            </div>
            <span class="meter-val">{rateBarLabel(fiveHourBar)}</span>
          </div>
        {/if}
        {#if sevenDayBar !== null}
          <div class="stat-row">
            <span class="stat-label">7day</span>
            <div class="meter" data-status={sevenDayBar.status}>
              <div class="meter-fill" style:width="{sevenDayBar.pct ?? 0}%"></div>
            </div>
            <span class="meter-val">{rateBarLabel(sevenDayBar)}</span>
          </div>
        {/if}
      </div>
    {/if}
  </button>
  {#if canStop}
    <button
      type="button"
      class="terminate"
      onclick={handleStop}
      disabled={stopping}
      title="エージェント(wrapper)を終了する"
      aria-label="{name} を終了"
    >
      <span class="terminate-label">{stopping ? "終了中…" : "終了"}</span>
    </button>
  {:else if canRestore}
    <button
      type="button"
      class="restore"
      onclick={handleRestore}
      disabled={restoring}
      title="セッションを再開してエージェントを復帰させる"
      aria-label="{name} を復帰"
    >
      <span class="restore-label">{restoring ? "復帰中…" : "復帰"}</span>
    </button>
  {/if}
  {#if canInterrupt}
    <button
      type="button"
      class="stop"
      onclick={handleInterrupt}
      disabled={interrupting}
      title="現在のターンを中断 (ESC 相当)"
      aria-label="{name} のターンを中断"
    >
      <span class="stop-icon" aria-hidden="true">■</span>
      <span class="stop-label">{interrupting ? "中断中…" : "中断"}</span>
    </button>
  {:else if canDelete}
    <button
      type="button"
      class="remove"
      onclick={handleDelete}
      disabled={deleting}
      title="オフラインエージェントを台帳ごと削除"
      aria-label="{name} を削除"
    >
      <span class="remove-icon" aria-hidden="true">✕</span>
      <span class="remove-label">{deleting ? "削除中…" : "削除"}</span>
    </button>
  {/if}
</article>

<style>
  .card {
    --tone: var(--c-idle);
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 1.4rem 1rem 1.1rem;
    text-align: center;
    background:
      radial-gradient(
        circle at 50% 0%,
        color-mix(in srgb, var(--tone) 9%, transparent),
        transparent 70%
      ),
      var(--bg-card);
  }

  .card[data-state="sending"] { --tone: var(--c-sending); }
  .card[data-state="thinking"] { --tone: var(--c-thinking); }
  .card[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .card[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .card[data-state="waiting_question"] {
    --tone: var(--c-waiting_question);
  }
  .card[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .card[data-state="done"] { --tone: var(--c-done); }
  .card[data-state="error"] { --tone: var(--c-error); }
  .card[data-state="disconnected"] { --tone: var(--c-disconnected); }

  /* Directory-only tile (ADR-0030): the operator has an identity ledger
     entry for this agent but AgentStates has none. Fade the whole card so
     it reads as "known but not live" alongside neighbouring live tiles. */
  .card.directory-only {
    opacity: 0.7;
  }

  /* "offline" label overlay for directory-only tiles (ADR-0030 D5), sitting
     top-left opposite the lamp so both stay legible over the sprite. */
  .offline-label {
    position: absolute;
    top: 0.6rem;
    left: 0.7rem;
    padding: 0.05rem 0.35rem;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    color: var(--fg-dim);
    background: color-mix(in srgb, var(--bg) 60%, transparent);
    border: 1px solid var(--line);
    border-radius: 0.2rem;
  }

  /* Restore failure hint (ADR-0030 D8) — sticky next to the lamp until the
     agent comes online again or a subsequent restore succeeds. */
  .error-icon {
    position: absolute;
    top: 0.6rem;
    right: 1.6rem;
    color: var(--c-error);
    font-size: 1.1rem;
    line-height: 1;
    cursor: help;
  }

  /* Wraps the sprite/face so the 頭上リング (issue #180) can be
     absolutely positioned around whichever is shown, and so the ring
     survives the {#key display.shown} remount below instead of
     restarting its rotation on every state change. inline-block
     shrink-wraps to the child's own size (8rem sprite / 5.4rem face), so
     the ring's `inset` offset (below) matches either case without a
     fixed size here; `.card`'s own text-align: center centers it
     horizontally (issue #232 MF-2: moved out of `.open`, which no longer
     wraps this), replacing the margin:auto the children used to carry
     directly. */
  .sprite-slot {
    position: relative;
    display: inline-block;
    margin-bottom: 1rem;
  }

  /* issue #232 MF-2: the click target for the persona detail modal, a
     plain reset so it does not visibly alter `.sprite-slot`'s existing
     size/position — sized entirely by its PersonaFace child, same as
     when the image sat unwrapped. Mirrors AgentDetail's
     `.portrait-open`. */
  .persona-open {
    display: block;
    margin: 0;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    cursor: pointer;
  }

  .persona-open:disabled {
    cursor: default;
  }

  /* issue #232 MF-2: position:relative wrapper for `.lamp`/
     `.offline-label`/`.error-icon`/`.badge`, taking over the role `.open`
     used to carry now that `.open` no longer wraps the image — same
     block-level, full-width footprint at the same position in `.card`'s
     flow, so their absolute coordinates are unchanged. */
  .card-media {
    position: relative;
    width: 100%;
  }

  /* Sprite/CSS-face fallback rendering itself lives in PersonaFace.svelte
     (issue #245, size="card") — this file only sizes the wrapper slot.
     `dissolve` stays here: `.state` below still uses it independently
     of the sprite/face. */

  /* Dissolve-in on state change (#43): the previous state label fades up
     from transparent. prefers-reduced-motion shortens this to ~instant
     via the global rule in app.css. */
  @keyframes dissolve {
    from { opacity: 0; }
  }

  /* --- text ----------------------------------------------------------- */

  h2 {
    margin: 0;
    font-size: var(--fs-h2);
    font-weight: 600;
    color: var(--fg);
  }

  .state {
    margin: 0.25rem 0 0;
    font-size: var(--fs-body-sm);
    font-weight: 600;
    color: var(--tone);
    animation: dissolve 0.35s ease-out;
  }

  .id {
    margin: 0.45rem 0 0;
    font-size: var(--fs-caption);
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  /* engine·model·effort / ctx·5h·7day (issue #193). Bottom
     margin reserves room for the terminate/interrupt/restore/delete chips,
     which are absolutely positioned in the card's bottom corners and would
     otherwise sit on top of the last bar. */
  .stats {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.5rem 0 1.7rem;
    text-align: left;
  }

  .meta-line {
    margin: 0;
    font-size: var(--fs-caption);
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  .stat-row {
    display: grid;
    grid-template-columns: 3.7rem 1fr auto;
    align-items: center;
    gap: 0.35rem;
  }

  .stat-label {
    font-size: var(--fs-micro);
    color: var(--fg-dim);
  }

  .stats .meter {
    width: 100%;
    height: 0.4rem;
    border-radius: 0.25rem;
    background: var(--bg);
    border: 1px solid var(--line);
    overflow: hidden;
  }

  .stats .meter-fill {
    height: 100%;
    background: var(--c-waiting_input);
  }

  .stats .meter[data-status="allowed_warning"] .meter-fill {
    background: var(--c-tool_running);
  }

  .stats .meter[data-status="rejected"] .meter-fill {
    background: var(--c-error);
  }

  .stats .meter-val {
    font-size: var(--fs-micro);
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Card has the interrupt button as a sibling of the open region, so make
     the wrapper a positioning context for it. */
  .card {
    position: relative;
  }

  /* Interrupt button (#51) on the lobby tile: small chip in the corner so it
     does not compete with the persona's identity, only shows up while the
     agent is running. Click handler stopPropagation prevents opening the
     detail view (the surrounding .open button). */
  .stop {
    position: absolute;
    bottom: 0.35rem;
    right: 0.35rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-tool_running);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-tool_running);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .stop:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-tool_running) 14%, var(--bg-card));
  }

  .stop:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .stop-icon {
    font-size: 0.7em; /* em-relative to parent button; do not tokenize */
    line-height: 1;
  }

  /* Terminate button (#22): bottom-LEFT chip so it never overlaps the
     interrupt / delete chip (bottom-right). A muted danger tone marks it
     destructive; shown for any connected agent. */
  .terminate {
    position: absolute;
    bottom: 0.35rem;
    left: 0.35rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-error);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .terminate:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 14%, var(--bg-card));
  }

  .terminate:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Restore button (#22): bottom-LEFT chip (same slot as terminate, which is
     hidden once disconnected). A waiting_input tone marks it as the
     constructive "bring it back" action, distinct from the danger delete. */
  .restore {
    position: absolute;
    bottom: 0.35rem;
    left: 0.35rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-waiting_input);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-waiting_input);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .restore:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-waiting_input) 14%, var(--bg-card));
  }

  .restore:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Delete button (#14): same corner chip as .stop but a muted danger tone,
     shown only for a disconnected agent (never overlaps the interrupt). */
  .remove {
    position: absolute;
    bottom: 0.35rem;
    right: 0.35rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.18rem 0.45rem;
    border: 1px solid var(--c-error);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .remove:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 14%, var(--bg-card));
  }

  .remove:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .remove-icon {
    font-size: 0.7em; /* em-relative to parent button; do not tokenize */
    line-height: 1;
  }

  /* --- clickable identity region (opens the detail view) -------------- */

  .open {
    display: block;
    position: relative;
    width: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    text-align: center;
    cursor: pointer;
  }

  .open:hover h2,
  .open:focus-visible h2 {
    color: var(--tone);
  }

  /* Directory-only tile has no detail view to open (ADR-0030): the button
     is left as-is for layout, but pointer/keyboard affordance is dropped so
     the tile does not advertise an interaction it cannot fulfil. */
  .open:disabled {
    cursor: default;
  }

  .open:disabled:hover h2,
  .open:disabled:focus-visible h2 {
    color: inherit;
  }

  /* Needs-attention badge: blinking chip on the card corner (ADR-0012). */
  .badge {
    position: absolute;
    top: 0;
    right: 0;
    padding: 0.12rem 0.4rem;
    border-radius: 0.3rem;
    font-size: var(--fs-micro);
    font-weight: 600;
    background: var(--c-waiting_permission);
    color: var(--bg);
    animation: blink 1.2s ease-in-out infinite;
  }

  .badge[data-state="error"] {
    background: var(--c-error);
  }

  /* State lamp (#16): same dot as the detail pane's, coloured by --tone.
     Top-left here since the needs-attention badge owns the top-right. */
  .lamp {
    position: absolute;
    top: 0.2rem;
    left: 0.2rem;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 6px var(--tone);
  }

  @keyframes blink {
    50% { opacity: 0.4; }
  }
</style>
