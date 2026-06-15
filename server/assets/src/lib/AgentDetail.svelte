<script lang="ts">
  import { tick, untrack } from "svelte";
  import { expressionFor, spriteUrlFor } from "./expression";
  import { StatusQueue } from "./statusDisplay.svelte";
  import { renderMarkdown, renderMermaidIn } from "./markdown";
  import { logOf, permissionRequestOf, resultOf } from "./protocol";
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
  // Optimistic "sent, awaiting the agent's next state" flag (#32). Purely
  // client-side; cleared by the next state envelope, not by the protocol.
  let sending = $state(false);
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
      await renderMermaidIn(logEl);
      logEl.scrollTop = logEl.scrollHeight;
    });
  });

  // Clear a stale action error once the agent moves on.
  $effect(() => {
    void envelope.state;
    actionError = "";
  });

  // Drop the optimistic "sending" flag once the agent's next state lands
  // (#32): the new state envelope means the turn has started.
  $effect(() => {
    void envelope.ts;
    sending = false;
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
    sending = true;
    void run(async () => {
      try {
        await connection.sendInstruction(envelope.agent_id, text);
        instruction = "";
      } catch (error) {
        // A refused send never triggers a state transition, so clear the
        // flag here rather than waiting for one. Rethrow so run() surfaces it.
        sending = false;
        throw error;
      }
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
        {#key display.shown}
          {#if spriteUrl}
            <img class="sprite" src={spriteUrl} alt={expression.label} />
          {:else}
            <span class="face" aria-label={expression.label}></span>
          {/if}
        {/key}
        <div class="meta">
          <h2>{name}</h2>
          {#key display.shown}
            <p class="state">{expression.label}</p>
          {/key}
          <p class="id">{envelope.agent_id}</p>
        </div>
      </header>
    </aside>

    <div class="main">
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
            <!-- The reply text already shows as the final assistant log; the
                 result only marks the turn boundary, not a duplicate (#29). -->
            <p class="turn-end" class:error={res.is_error}>
              {res.is_error ? "エラーで終了" : "応答完了"}
              <time class="ts" datetime={env.ts}>{time}</time>
            </p>
          {/if}
        {/each}
      </div>

      {#if connection}
        {#if permission}
          <div class="permission">
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
        {/if}

        <form class="instruct" onsubmit={sendInstruction}>
          <textarea
            class:sending
            placeholder="指示を送る…(Ctrl+Enter で送信)"
            bind:value={instruction}
            onkeydown={onInstructionKeydown}
            rows="2"
            aria-label="instruction for {name}"
          ></textarea>
          <button type="submit" disabled={instruction.trim() === ""}>送信</button>
        </form>

        {#if sending}
          <p class="sending-note">送信中… 応答待ち</p>
        {/if}

        {#if actionError}
          <p class="action-error">{actionError}</p>
        {/if}
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
    height: calc(100vh - 4rem);
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

  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
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

  .sprite {
    width: 5rem;
    height: 5rem;
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
    width: 3.4rem;
    height: 3.4rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    animation: dissolve 0.35s ease-out;
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

  .permission {
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.45rem;
    font-size: 0.8rem;
  }

  .permission-tool { margin: 0; color: var(--fg); }
  .permission-note { margin: 0.3rem 0 0; color: var(--fg-dim); }
  .permission details { margin-top: 0.35rem; color: var(--fg-dim); }

  .permission pre {
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

  /* Awaiting-response cue (#32): dark-yellow field while a send is in
     flight, until the agent's next state envelope clears it. */
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
