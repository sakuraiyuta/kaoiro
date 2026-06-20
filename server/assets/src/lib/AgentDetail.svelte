<script lang="ts">
  import { tick, untrack } from "svelte";
  import { expressionFor, spriteUrlFor } from "./expression";
  import { StatusQueue } from "./statusDisplay.svelte";
  import { renderMarkdown, renderMermaidIn } from "./markdown";
  import { logOf, permissionRequestOf, resultOf, RUNNING_STATES } from "./protocol";
  import type {
    Envelope,
    KaoiroConnection,
    PersonaManifest,
  } from "./protocol";

  let {
    envelope,
    logs = [],
    agents = {},
    connection = null,
    manifest = null,
    origin = null,
    onClose,
  }: {
    envelope: Envelope;
    logs?: Envelope[];
    agents?: Record<string, Envelope>;
    connection?: KaoiroConnection | null;
    manifest?: PersonaManifest | null;
    /** Viewport centre of the originating tile, for the expand anim (#36). */
    origin?: { x: number; y: number } | null;
    onClose: () => void;
  } = $props();

  // Expand the detail from the tile that opened it (#36): scale up from the
  // tile's viewport centre. Honours prefers-reduced-motion by skipping motion.
  function expandFrom(
    node: HTMLElement,
    params: { origin: { x: number; y: number } | null },
  ) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (params.origin) {
      const rect = node.getBoundingClientRect();
      node.style.transformOrigin = `${params.origin.x - rect.left}px ${
        params.origin.y - rect.top
      }px`;
    }
    return {
      duration: reduce ? 0 : 240,
      css: (t: number) => `opacity: ${t}; transform: scale(${0.6 + 0.4 * t});`,
    };
  }

  // Displayed state lags the live state for min readability + crossfade (#43).
  const display = new StatusQueue(untrack(() => envelope.state));
  $effect(() => {
    display.push(envelope.state);
  });
  $effect(() => () => display.dispose());

  const expression = $derived(expressionFor(display.shown));
  const name = $derived(envelope.persona?.name ?? envelope.agent_id);
  const spriteUrl = $derived(
    spriteUrlFor(manifest, envelope.persona?.sprite_set, display.shown),
  );
  const permission = $derived(permissionRequestOf(envelope));

  // Cumulative session cost (USD) carried in ext.cost (#8), or null when the
  // wrapper did not attach it.
  function costUsd(env: Envelope): number | null {
    const cost = env.ext?.cost;
    return typeof cost === "number" ? cost : null;
  }

  // --- Claude Code status meta (#16): model / context / rate limits -------
  // All carried in ext.* and rendered defensively, since the SDK's exact
  // scales (0-1 vs 0-100) and timestamp units are not guaranteed.

  /** Normalise a rate-limit utilization (a 0-1 fraction) to an integer
   *  0..100. Values >1 are assumed already-percent and passed through; the
   *  only ambiguous input is exactly 1, read as 100% (a maxed limit — the
   *  safe reading for a rate-limit meter). */
  function pctNorm(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const pct = value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /** Clamp an already-percentage value (0-100) to an integer 0..100. Used for
   *  context usage, whose SDK `percentage` is a 0-100 scale — a value of 1
   *  means 1%, not 100%, so it must NOT go through pctNorm's fraction path. */
  function pctClamp(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  /** Format an epoch reset time (seconds or milliseconds) as MM/DD HH:MM. */
  function fmtReset(value: unknown): string | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const at = new Date(value < 1e12 ? value * 1000 : value);
    if (Number.isNaN(at.getTime())) return null;
    return at.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const RATE_LABELS: Record<string, string> = {
    five_hour: "5h",
    seven_day: "7day",
    seven_day_opus: "7day Opus",
    seven_day_sonnet: "7day Sonnet",
    overage: "追加",
  };

  interface RateRow {
    key: string;
    label: string;
    pct: number | null;
    reset: string | null;
    status: string | undefined;
  }

  /** Build display rows from ext.rate_limits, in a stable window order. The
   *  weekly `seven_day` window is always emitted (with a null pct = "awaiting
   *  data" placeholder) so its absence reads as pending, not a missing
   *  feature; other windows appear only once the SDK surfaces them. */
  function buildRateRows(raw: unknown): RateRow[] {
    const limits =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, Record<string, unknown> | undefined>)
        : {};
    const rows: RateRow[] = [];
    for (const key of Object.keys(RATE_LABELS)) {
      const win = limits[key];
      if (typeof win !== "object" || win === null) {
        if (key === "seven_day") {
          rows.push({
            key,
            label: RATE_LABELS[key],
            pct: null,
            reset: null,
            status: undefined,
          });
        }
        continue;
      }
      rows.push({
        key,
        label: RATE_LABELS[key],
        pct: pctNorm(win.utilization),
        reset: fmtReset(win.resets_at),
        status: typeof win.status === "string" ? win.status : undefined,
      });
    }
    return rows;
  }

  const ccModel = $derived(
    typeof envelope.ext?.model === "string" ? envelope.ext.model : null,
  );
  const ccCwd = $derived(
    typeof envelope.ext?.cwd === "string" ? envelope.ext.cwd : null,
  );
  const ccContext = $derived(
    envelope.ext?.context as Record<string, unknown> | undefined,
  );
  const ctxPct = $derived(pctClamp(ccContext?.used_percentage));
  const ccRateRows = $derived(buildRateRows(envelope.ext?.rate_limits));
  // The always-present seven_day placeholder (pct null) must not, by itself,
  // open the panel for a non-Claude-Code agent — require real meta or a
  // rate window that actually has data.
  const hasCcStatus = $derived(
    ccModel !== null ||
      ccCwd !== null ||
      ctxPct !== null ||
      ccRateRows.some((r) => r.pct !== null),
  );

  // Wall-clock time of a log line from its envelope ts (#38). Invalid or
  // missing timestamps render as empty rather than "Invalid Date".
  function formatTime(ts: string): string {
    const at = new Date(ts);
    if (Number.isNaN(at.getTime())) return "";
    return at.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  // Blind-spot: other agents needing attention while this detail hides the
  // grid (ADR-0012 F8). Colour follows the most urgent: error first.
  const attention = $derived(
    Object.values(agents).filter(
      (e) =>
        e.agent_id !== envelope.agent_id &&
        (e.state === "error" || e.state === "waiting_permission"),
    ),
  );
  const attentionTone = $derived(
    attention.some((e) => e.state === "error")
      ? "error"
      : "waiting_permission",
  );

  let instruction = $state("");
  let actionError = $state("");
  // Mid-flight ESC (#51): set on click, cleared when the server replies
  // (ok/error/timeout). The agent's own state change is what stops the
  // turn — this flag only locks the button against double-clicks.
  let interrupting = $state(false);

  // RUNNING_STATES is shared with AgentCard via protocol.ts so both
  // surfaces gate the interrupt button on the same set.
  const canInterrupt = $derived(RUNNING_STATES.has(envelope.state));

  // Delete is offered only for a disconnected agent (#14); the interrupt
  // button is hidden then (disconnected is not a running state), so the
  // delete button takes its place in the same action slot below it.
  const canDelete = $derived(envelope.state === "disconnected");
  let deleting = $state(false);

  // Folded state of the permission dock (#…): when true it sits as a small
  // button in the conversation's top-right corner instead of covering the
  // transcript. permFullH carries the panel's natural height so the dock can
  // animate height between the open panel and the folded pill.
  let permMinimized = $state(false);
  let permFullH = $state(0);
  // Input-area height, so the open dock can float just above the composer
  // without overlapping it (the composer grows with the sending/error notes).
  let composerH = $state(0);
  // A fresh request (new request_id) always opens expanded, so a pending
  // decision is never hidden by a stale folded state from an earlier one.
  $effect(() => {
    void permission?.request_id;
    permMinimized = false;
  });
  // tool_use_id under the pointer, so its tool_use and tool_result both
  // highlight while hovered (#40).
  let hoveredTool = $state<string | null>(null);
  let logEl = $state<HTMLDivElement | null>(null);

  // Render any new mermaid diagrams (#42), then keep the transcript pinned to
  // the latest line (diagrams change the scroll height, so scroll after).
  $effect(() => {
    void logs.length;
    void tick().then(async () => {
      if (!logEl) return;
      try {
        await renderMermaidIn(logEl);
      } catch (error) {
        console.error("mermaid render failed", error);
      }
      // The component may have unmounted during the await; re-check logEl.
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  });

  // Clear a stale action error once the agent moves on.
  $effect(() => {
    void envelope.state;
    actionError = "";
  });

  async function run(action: () => Promise<void>): Promise<void> {
    actionError = "";
    try {
      await action();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  function sendInstruction(event: SubmitEvent): void {
    event.preventDefault();
    const text = instruction.trim();
    if (!connection || text === "") return;
    void run(async () => {
      await connection.sendInstruction(envelope.agent_id, text);
      instruction = "";
    });
  }

  // Multi-line input (#33): Enter inserts a newline; Ctrl/Cmd+Enter submits.
  function onInstructionKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  // Scroll to and flash the partner of a tool block (#40): from a tool_use to
  // its tool_result and vice versa, matched by tool_use_id.
  function jumpToTool(event: MouseEvent, id: string, fromKind: string): void {
    event.preventDefault();
    event.stopPropagation(); // don't toggle the <details> we live inside
    if (!logEl) return;
    const toKind = fromKind === "tool_use" ? "tool_result" : "tool_use";
    const target = logEl.querySelector<HTMLElement>(
      `[data-tuid="${CSS.escape(id)}"][data-kind="${toKind}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1000);
  }

  function decide(allow: boolean): void {
    if (!connection || !permission) return;
    void run(() =>
      connection.sendPermissionDecision(
        envelope.agent_id,
        permission.request_id,
        allow,
      ),
    );
  }

  // ESC-equivalent stop (#51): fire-and-forget to the wrapper. The button
  // is hidden when the agent is not running, so a stale click cannot happen
  // here; the wrapper still no-ops a stale interrupt on its end.
  function interrupt(): void {
    if (!connection || interrupting) return;
    void run(async () => {
      interrupting = true;
      try {
        await connection.sendInterrupt(envelope.agent_id);
      } finally {
        interrupting = false;
      }
    });
  }

  // Remove a disconnected agent (#14): destructive, so confirm first. On
  // success the server broadcasts agent_deleted; App drops it and this
  // detail falls back to the grid as its selected agent vanishes.
  function deleteAgent(): void {
    if (!connection || deleting) return;
    const ok = window.confirm(
      `切断済みエージェント「${name}」を一覧から削除します。よろしいですか?`,
    );
    if (!ok) return;
    void run(async () => {
      deleting = true;
      try {
        await connection.deleteAgent(envelope.agent_id);
      } finally {
        deleting = false;
      }
    });
  }

  // Purge past-session reply lines (#48): destructive and irreversible, so
  // confirm first. No-op without a known current session_id (the button is
  // disabled then); the server keeps only that session's lines.
  function clearHistory(): void {
    if (!connection || !envelope.session_id) return;
    const ok = window.confirm(
      "現在のセッション以外の返答ログを消去します。元に戻せません。よろしいですか?",
    );
    if (!ok) return;
    void run(() => connection.clearHistory(envelope.agent_id));
  }
</script>

<section class="detail" data-state={expression.variant} in:expandFrom={{ origin }}>
  <div class="bar">
    <button class="back" onclick={onClose}>グリッドへ戻る</button>
    {#if attention.length > 0}
      <button
        class="blindspot"
        data-tone={attentionTone}
        onclick={onClose}
        title="一覧へ戻って対応する"
      >
        他に {attention.length} 体が要対応(クリックで一覧へ)
      </button>
    {/if}
  </div>

  <div class="body">
    <aside class="status">
      <header class="head">
        <div class="portrait">
          {#key display.shown}
            {#if spriteUrl}
              <img class="sprite" src={spriteUrl} alt={expression.label} />
            {:else}
              <span class="face" aria-label={expression.label}></span>
            {/if}
          {/key}
          <span class="lamp" title={expression.label}></span>
        </div>
        <div class="meta">
          <h2>{name}</h2>
          {#key display.shown}
            <p class="state">{expression.label}</p>
          {/key}
          <p class="id">{envelope.agent_id}</p>
        </div>
      </header>

      {#if hasCcStatus}
        <!-- Claude Code status meta (#16): mirrors the local statusline's
             model / ctx / 5h / 7d segments for this agent. -->
        <dl class="cc">
          {#if ccModel}
            <div class="cc-row">
              <dt>model</dt>
              <dd class="cc-model">{ccModel}</dd>
            </div>
          {/if}
          {#if ccCwd}
            <div class="cc-row">
              <dt>cwd</dt>
              <dd class="cc-cwd" title={ccCwd}>{ccCwd}</dd>
            </div>
          {/if}
          {#if ctxPct !== null}
            <div class="cc-row">
              <dt>ctx</dt>
              <dd>
                <div class="meter">
                  <div class="meter-fill" style:width="{ctxPct}%"></div>
                </div>
                <span class="meter-val">{ctxPct}%</span>
              </dd>
            </div>
          {/if}
          {#each ccRateRows as r (r.key)}
            <div class="cc-row">
              <dt>{r.label}</dt>
              <dd>
                {#if r.key === "seven_day" && r.pct === null}
                  <span class="cc-pending">まだ情報がありません</span>
                {:else}
                  <div
                    class="meter"
                    data-status={r.status}
                    title={r.reset ? "リセット " + r.reset : undefined}
                  >
                    <div class="meter-fill" style:width="{r.pct ?? 0}%"></div>
                  </div>
                  <span class="meter-val"
                    >{r.pct === null ? "?" : r.pct + "%"}</span>
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      {/if}

      {#if connection}
        <!-- Destructive (#48): purge the server-side reply log of past
             sessions, keeping only the current one. Disabled until the
             current session_id is known (nothing to scope the purge to). -->
        <button
          type="button"
          class="clear-history"
          disabled={!envelope.session_id}
          title={envelope.session_id
            ? "現在のセッション以外の返答ログを消去します"
            : "現在のセッションが不明なため消去できません"}
          onclick={clearHistory}
        >
          過去セッションのログを消去
        </button>
      {/if}
    </aside>

    <div class="main" style:--composer-h={composerH ? composerH + "px" : null}>
      <div class="log" bind:this={logEl}>
        {#if logs.length === 0}
          <p class="empty">まだ返答はありません。</p>
        {/if}
        {#each logs as env, i (env.ts + ":" + (env.seq ?? i))}
          {@const log = logOf(env)}
          {@const res = resultOf(env)}
          {@const time = formatTime(env.ts)}
          {#if log?.kind === "user"}
            <!-- Untrusted: renderMarkdown sanitizes via DOMPurify (#30). -->
            <div class="msg user">
              {@html renderMarkdown(log.text ?? "")}
              <time class="ts" datetime={env.ts}>{time}</time>
            </div>
          {:else if log?.kind === "assistant"}
            <!-- Untrusted: renderMarkdown sanitizes via DOMPurify (#30). -->
            <div class="msg assistant">
              {@html renderMarkdown(log.text ?? "")}
              <time class="ts" datetime={env.ts}>{time}</time>
            </div>
          {:else if log?.kind === "tool_use"}
            {@const tuid = log.tool_use_id}
            <details
              class="tool"
              class:linked={hoveredTool !== null && hoveredTool === tuid}
              data-tuid={tuid ?? ""}
              data-kind="tool_use"
              onmouseenter={() => (hoveredTool = tuid ?? null)}
              onmouseleave={() => (hoveredTool = null)}
            >
              <summary
                >ツール呼び出し: {log.tool_name}
                {#if tuid}
                  <button
                    type="button"
                    class="tlink"
                    title="対応する結果へ"
                    onclick={(e) => jumpToTool(e, tuid, "tool_use")}
                    >🔗{tuid.slice(-4)}</button>
                {/if}
                <time class="ts" datetime={env.ts}>{time}</time></summary>
              <pre>{JSON.stringify(log.input ?? {}, null, 2)}{log.truncated
                  ? "\n…(入力が大きいため省略)"
                  : ""}</pre>
            </details>
          {:else if log?.kind === "tool_result"}
            {@const tuid = log.tool_use_id}
            <details
              class="tool"
              class:linked={hoveredTool !== null && hoveredTool === tuid}
              data-tuid={tuid ?? ""}
              data-kind="tool_result"
              onmouseenter={() => (hoveredTool = tuid ?? null)}
              onmouseleave={() => (hoveredTool = null)}
            >
              <summary
                >結果: {log.tool_name ?? "tool"}
                {#if tuid}
                  <button
                    type="button"
                    class="tlink"
                    title="対応する呼び出しへ"
                    onclick={(e) => jumpToTool(e, tuid, "tool_result")}
                    >🔗{tuid.slice(-4)}</button>
                {/if}
                <time class="ts" datetime={env.ts}>{time}</time></summary>
              <pre>{log.output ?? ""}{log.truncated ? "\n…(省略)" : ""}</pre>
            </details>
          {:else if res}
            {@const cost = costUsd(env)}
            <!-- The reply text already shows as the final assistant log; the
                 result only marks the turn boundary, not a duplicate (#29). -->
            <p class="turn-end" class:error={res.is_error}>
              {res.is_error ? "エラーで終了" : "応答完了"}
              {#if cost !== null}
                <span
                  class="cost"
                  title="API 標準単価での推定値。Claude サブスク利用時は実課金額ではありません(従量 API キー利用時のみ実コストに近い)。セッション開始からの累計。"
                  >累計 ~${cost.toFixed(4)}</span>
              {/if}
              <time class="ts" datetime={env.ts}>{time}</time>
            </p>
          {/if}
        {/each}
      </div>

      {#if connection}
        {#if canInterrupt}
          <!-- ESC equivalent (#51, ADR-0020). One-click, fire-and-forget;
               the agent's own state change is the visible confirmation. -->
          <button
            type="button"
            class="interrupt"
            onclick={interrupt}
            disabled={interrupting}
            title="現在のターンを中断 (ESC 相当)"
          >
            <span class="interrupt-icon" aria-hidden="true">■</span>
            {interrupting ? "中断中…" : "中断"}
          </button>
        {:else if canDelete}
          <!-- Delete a disconnected agent (#14): sits in the interrupt
               button's slot (the two never show at once). -->
          <button
            type="button"
            class="remove"
            onclick={deleteAgent}
            disabled={deleting}
            title="切断済みエージェントを一覧から削除"
          >
            <span class="remove-icon" aria-hidden="true">✕</span>
            {deleting ? "削除中…" : "削除"}
          </button>
        {/if}

        {#if permission}
          <!-- Permission dock (#46): the request can fold up into a button in
               the conversation's top-right corner so it stops covering the
               transcript, then unfold back. Fold/unfold is a 0.25s eased move. -->
          <div
            class="permission-dock"
            class:min={permMinimized}
            style:--full-h={permFullH ? permFullH + "px" : null}
          >
            <div
              class="permission-full"
              bind:offsetHeight={permFullH}
              inert={permMinimized}
            >
              <button
                class="permission-min"
                type="button"
                title="最小化"
                aria-label="許可ダイアログを最小化"
                onclick={() => (permMinimized = true)}></button>
              <p class="permission-tool">
                <code>{permission.tool_name}</code> の実行許可を求めています
              </p>
              {#if permission.input}
                <details>
                  <summary>input</summary>
                  <pre>{JSON.stringify(permission.input, null, 2)}</pre>
                </details>
              {:else if permission.truncated}
                <p class="permission-note">(input は大きすぎるため省略)</p>
              {/if}
              <div class="permission-actions">
                <button class="allow" onclick={() => decide(true)}>許可</button>
                <button class="deny" onclick={() => decide(false)}>拒否</button>
              </div>
            </div>
            <button
              class="permission-pill"
              type="button"
              title="許可ダイアログを開く"
              aria-label="許可ダイアログを開く"
              inert={!permMinimized}
              onclick={() => (permMinimized = false)}
            >
              <span class="permission-pill-lamp"></span>
              許可待ち
            </button>
          </div>
        {/if}

        <div class="composer" bind:offsetHeight={composerH}>
          <form class="instruct" onsubmit={sendInstruction}>
            <textarea
              class:sending={display.shown === "sending"}
              placeholder="指示を送る…(Ctrl+Enter で送信)"
              bind:value={instruction}
              onkeydown={onInstructionKeydown}
              rows="2"
              aria-label="instruction for {name}"
            ></textarea>
            <button type="submit" disabled={instruction.trim() === ""}>送信</button>
          </form>

          {#if display.shown === "sending"}
            <p class="sending-note">送信中… 応答待ち</p>
          {/if}

          {#if actionError}
            <p class="action-error">{actionError}</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</section>

<style>
  .detail {
    --tone: var(--c-idle);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 72rem;
    margin: 0 auto;
    /* Fill the viewport-height main column (App shell) so the log scrolls and
       the composer stays pinned at the bottom of the screen (#33). */
    height: 100%;
  }

  /* Two-column body (#37): status pinned left, conversation log right.
     min-height:0 lets the log scroll instead of stretching the page. */
  .body {
    display: flex;
    gap: 1.5rem;
    flex: 1;
    min-height: 0;
  }

  .status {
    flex: 0 0 20%;
    min-width: 9rem;
  }

  .clear-history {
    margin-top: 0.75rem;
    width: 100%;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--c-error);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .clear-history:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 12%, var(--bg-card));
  }

  .clear-history:disabled {
    border-color: var(--line);
    color: var(--fg-dim);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .main {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Wrapper exists only to measure the input area's height (--composer-h), so
     the floating permission dock can rest just above it (#46). */
  .composer {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  @media (max-width: 640px) {
    .detail {
      height: auto;
      min-height: calc(100vh - 4rem);
    }
    .body {
      flex-direction: column;
    }
    .status {
      flex: none;
    }
    .log {
      max-height: 60vh;
    }
  }

  .detail[data-state="sending"] { --tone: var(--c-sending); }
  .detail[data-state="thinking"] { --tone: var(--c-thinking); }
  .detail[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .detail[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .detail[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .detail[data-state="done"] { --tone: var(--c-done); }
  .detail[data-state="error"] { --tone: var(--c-error); }
  .detail[data-state="disconnected"] { --tone: var(--c-disconnected); }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .back {
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .blindspot {
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--c-waiting_permission);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    animation: blink 1.2s ease-in-out infinite;
  }

  .blindspot[data-tone="error"] {
    border-color: var(--c-error);
    color: var(--c-error);
  }

  @keyframes blink {
    50% { opacity: 0.45; }
  }

  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    text-align: center;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--line);
  }

  /* Persona portrait (#16): fills the pane width with a subtle top light,
     like the grid cards; a state-coloured lamp sits in the corner. */
  .portrait {
    position: relative;
    width: 100%;
    display: flex;
    justify-content: center;
    padding: 0.8rem;
    border-radius: 0.5rem;
    background:
      radial-gradient(
        circle at 50% 0%,
        color-mix(in srgb, var(--tone) 14%, transparent),
        transparent 70%
      ),
      var(--bg-card);
  }

  .sprite {
    width: 100%;
    height: auto;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    animation: dissolve 0.35s ease-out;
  }

  /* Dissolve-in on state change (#43): the previous face/label is replaced
     via {#key}, so the new one fades up from transparent. prefers-reduced-
     motion shortens this to ~instant via the global rule in app.css. */
  @keyframes dissolve {
    from { opacity: 0; }
  }

  [data-state="disconnected"] .sprite {
    filter: grayscale(1);
    opacity: 0.45;
  }

  .face {
    width: 70%;
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: dissolve 0.35s ease-out;
  }

  /* State lamp on the portrait (#16): same shape/size as the connection
     dot, coloured by the agent's state via --tone. */
  .lamp {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 6px var(--tone);
  }

  .meta h2 {
    margin: 0;
    font-size: 1.1rem;
    color: var(--fg);
  }

  .state {
    margin: 0.2rem 0 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--tone);
    animation: dissolve 0.35s ease-out;
  }

  .id {
    margin: 0.3rem 0 0;
    font-size: 0.7rem;
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  /* Claude Code status meta panel (#16): model / ctx / rate-limit meters. */
  .cc {
    margin: 0;
    padding-top: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    font-size: 0.7rem;
  }

  .cc-row {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .cc dt {
    color: var(--fg-dim);
    letter-spacing: 0.05em;
  }

  .cc dd {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .cc-model {
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  /* Placeholder for a rate window the SDK has not surfaced yet (#16). */
  .cc-pending {
    font-size: 0.7rem;
    color: var(--fg-dim);
  }

  /* cwd can be a long absolute path; clip to one line keeping the tail (the
     project dir) visible, full value on hover. rtl+left-align truncates the
     start (`…/git/kaoiro`) rather than the more useful tail. */
  .cc-cwd {
    color: var(--fg);
    direction: rtl;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meter {
    width: 100%;
    height: 0.45rem;
    border-radius: 0.25rem;
    background: var(--bg);
    border: 1px solid var(--line);
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    background: var(--c-waiting_input);
  }

  .meter[data-status="allowed_warning"] .meter-fill {
    background: var(--c-tool_running);
  }

  .meter[data-status="rejected"] .meter-fill {
    background: var(--c-error);
  }

  .meter-val {
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .log {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    overflow-y: auto;
    padding-right: 0.4rem;
  }

  .empty {
    color: var(--fg-dim);
    font-size: 0.85rem;
  }

  .msg {
    margin: 0;
    padding: 0.6rem 0.8rem;
    border-radius: 0.5rem;
    font-size: 0.85rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  /* Rendered-markdown children (#30): tighten margins and style code so a
     reply reads cleanly inside the bubble. :global because {@html} content
     is not scoped by Svelte. */
  .msg :global(:first-child) { margin-top: 0; }
  .msg :global(:last-child) { margin-bottom: 0; }
  .msg :global(p) { margin: 0.4rem 0; }
  .msg :global(ul),
  .msg :global(ol) { margin: 0.4rem 0; padding-left: 1.2rem; }
  .msg :global(a) { color: var(--c-thinking); }

  .msg :global(code) {
    font-family: inherit;
    color: var(--c-thinking);
  }

  .msg :global(pre) {
    margin: 0.4rem 0;
    padding: 0.5rem 0.6rem;
    background: var(--bg);
    border-radius: 0.3rem;
    overflow-x: auto;
  }

  .msg :global(pre code) { color: var(--fg); }

  /* Rendered mermaid diagram (#42): centre it and keep the SVG responsive. */
  .msg :global(.mermaid-rendered) {
    margin: 0.5rem 0;
    text-align: center;
  }

  .msg :global(.mermaid-rendered svg) {
    max-width: 100%;
    height: auto;
  }

  .msg.assistant {
    background: var(--bg-card);
    border: 1px solid var(--line);
    color: var(--fg);
  }

  /* Operator's own instruction echoed into the transcript (#31): a
     right-aligned bubble to read it as the "sent" side of the chat. */
  .msg.user {
    align-self: flex-end;
    max-width: 85%;
    background: color-mix(in srgb, var(--c-waiting_input) 14%, var(--bg-card));
    border: 1px solid var(--c-waiting_input);
    color: var(--fg);
  }

  .turn-end {
    margin: 0.2rem 0;
    text-align: center;
    font-size: 0.68rem;
    letter-spacing: 0.1em;
    color: var(--c-done);
  }

  .turn-end.error {
    color: var(--c-error);
  }

  /* Per-line wall-clock time (#38): small, dim, monospaced digits. */
  .ts {
    font-size: 0.62rem;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }

  .msg .ts {
    display: block;
    margin-top: 0.3rem;
    text-align: right;
    opacity: 0.8;
  }

  .turn-end .ts {
    margin-left: 0.5em;
  }

  /* Session cost on the turn boundary (#8). */
  .cost {
    margin-left: 0.5em;
    font-size: 0.68rem;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }

  .tool {
    font-size: 0.75rem;
    color: var(--fg-dim);
    border: 1px dashed var(--line);
    border-radius: 0.45rem;
    padding: 0.35rem 0.6rem;
  }

  .tool summary {
    cursor: pointer;
    color: var(--c-tool_running);
  }

  /* tool_use <-> tool_result pairing (#40): hovering one highlights both, and
     the link badge jumps to (and flashes) the partner. */
  .tool.linked {
    border-color: var(--c-tool_running);
    background: color-mix(in srgb, var(--c-tool_running) 8%, transparent);
  }

  .tlink {
    margin-left: 0.4rem;
    padding: 0 0.3rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg);
    color: var(--c-tool_running);
    font: inherit;
    font-size: 0.62rem;
    cursor: pointer;
  }

  /* .flash is toggled from JS (jumpToTool), so mark it global to keep
     svelte-check from flagging it as an unused selector. */
  .tool:global(.flash) {
    animation: flash 1s ease-out;
  }

  @keyframes flash {
    from { background: color-mix(in srgb, var(--c-tool_running) 35%, transparent); }
  }

  .tool pre {
    margin: 0.4rem 0 0;
    max-height: 16rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--fg-dim);
  }

  /* Permission dock (#46): a transparent clip/anchor box that floats over the
     transcript. Open, it rests just above the composer at full width; folded
     (.min) it shrinks to a pill in the top-right corner. The 0.25s eased move
     is a transition on position + size; its two layers (.permission-full /
     .permission-pill) crossfade. --full-h (the open height, measured) lets the
     box animate its height between the panel and the pill. */
  .permission-dock {
    --pill-h: 2.4rem;
    --pill-w: 10rem;
    position: absolute;
    right: 0;
    bottom: calc(var(--composer-h, 0px) + 0.6rem);
    z-index: 2;
    width: 100%;
    height: var(--full-h, auto);
    overflow: hidden;
    transition:
      bottom 0.25s ease,
      width 0.25s ease,
      height 0.25s ease;
  }

  .permission-dock.min {
    bottom: calc(100% - var(--pill-h));
    width: var(--pill-w);
    height: var(--pill-h);
  }

  .permission-full {
    position: relative;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.45rem;
    background: var(--bg-card);
    font-size: 0.8rem;
    transition: opacity 0.25s ease;
  }

  .permission-dock.min .permission-full {
    opacity: 0;
    pointer-events: none;
  }

  /* Minimize affordance, tucked into the panel's top-right corner. */
  .permission-min {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    width: 1.4rem;
    height: 1.4rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg);
    color: var(--fg-dim);
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }

  /* Minimize glyph drawn as a bar (no ambiguous-width dash character). */
  .permission-min::before {
    content: "";
    width: 0.7rem;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
  }

  .permission-tool { margin: 0; padding-right: 1.6rem; color: var(--fg); }
  .permission-note { margin: 0.3rem 0 0; color: var(--fg-dim); }
  .permission-full details { margin-top: 0.35rem; color: var(--fg-dim); }

  .permission-full pre {
    margin: 0.3rem 0 0;
    max-height: 10rem;
    overflow: auto;
    font-size: 0.7rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .permission-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }

  .permission-actions button {
    flex: 1;
    padding: 0.35rem 0;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .permission-actions .allow {
    border-color: var(--c-done);
    color: var(--c-done);
  }

  .permission-actions .deny {
    border-color: var(--c-error);
    color: var(--c-error);
  }

  /* ESC-equivalent (#51): sits above the composer when the agent is
     executing, styled like a warning action — visible but not alarming. */
  .interrupt {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--c-tool_running);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--c-tool_running);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .interrupt:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-tool_running) 14%, var(--bg-card));
  }

  .interrupt:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .interrupt-icon {
    font-size: 0.7em;
    line-height: 1;
  }

  /* Delete a disconnected agent (#14): occupies the interrupt button's slot
     (mutually exclusive states), styled as a muted destructive action. */
  .remove {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--c-error);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: 0.8rem;
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
    font-size: 0.7em;
    line-height: 1;
  }

  /* Folded-state button: fills the dock (pill-sized when .min), crossfades
     with the panel, and carries a pulsing lamp so a pending decision stays
     noticeable in the corner. */
  .permission-pill {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.45rem;
    background: var(--bg-card);
    color: var(--c-waiting_permission);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }

  .permission-dock.min .permission-pill {
    opacity: 1;
    pointer-events: auto;
  }

  .permission-pill-lamp {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--c-waiting_permission);
    box-shadow: 0 0 6px var(--c-waiting_permission);
    animation: blink 1.2s ease-in-out infinite;
  }

  /* The fold/unfold move is a CSS transition, which the global reduced-motion
     rule in app.css (animations only) does not tame — shorten it here too. */
  @media (prefers-reduced-motion: reduce) {
    .permission-dock,
    .permission-full,
    .permission-pill {
      transition-duration: 0.01ms;
    }
  }

  .instruct {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .instruct textarea {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: 0.85rem;
    line-height: 1.4;
    resize: vertical;
  }

  /* Awaiting-response cue (#32): dark-yellow field while the agent is in the
     wrapper-issued `sending` state, until its first real turn state lands. */
  .instruct textarea.sending {
    background: color-mix(in srgb, var(--c-tool_running) 22%, var(--bg-card));
    border-color: var(--c-tool_running);
  }

  .sending-note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--c-tool_running);
  }

  .instruct button {
    padding: 0.5rem 1rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .instruct button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .action-error {
    margin: 0;
    font-size: 0.75rem;
    color: var(--c-error);
    overflow-wrap: anywhere;
  }
</style>
