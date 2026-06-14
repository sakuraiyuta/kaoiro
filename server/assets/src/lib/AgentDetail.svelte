<script lang="ts">
  import { tick } from "svelte";
  import { expressionFor, spriteUrlFor } from "./expression";
  import { renderMarkdown } from "./markdown";
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
    onClose,
  }: {
    envelope: Envelope;
    logs?: Envelope[];
    agents?: Record<string, Envelope>;
    connection?: KaoiroConnection | null;
    manifest?: PersonaManifest | null;
    onClose: () => void;
  } = $props();

  const expression = $derived(expressionFor(envelope.state));
  const name = $derived(envelope.persona?.name ?? envelope.agent_id);
  const spriteUrl = $derived(
    spriteUrlFor(manifest, envelope.persona?.sprite_set, envelope.state),
  );
  const permission = $derived(permissionRequestOf(envelope));

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
  let logEl = $state<HTMLDivElement | null>(null);

  // Keep the transcript pinned to the latest line as it streams.
  $effect(() => {
    void logs.length;
    void tick().then(() => {
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

<section class="detail" data-state={expression.variant}>
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

  <header class="head">
    {#if spriteUrl}
      <img class="sprite" src={spriteUrl} alt={expression.label} />
    {:else}
      <span class="face" aria-label={expression.label}></span>
    {/if}
    <div class="meta">
      <h2>{name}</h2>
      <p class="state">{expression.label}</p>
      <p class="id">{envelope.agent_id}</p>
    </div>
  </header>

  <div class="log" bind:this={logEl}>
    {#if logs.length === 0}
      <p class="empty">まだ返答はありません。</p>
    {/if}
    {#each logs as env, i (env.ts + ":" + (env.seq ?? i))}
      {@const log = logOf(env)}
      {@const res = resultOf(env)}
      {#if log?.kind === "user"}
        <!-- Untrusted: renderMarkdown sanitizes via DOMPurify (#30). -->
        <div class="msg user">{@html renderMarkdown(log.text ?? "")}</div>
      {:else if log?.kind === "assistant"}
        <!-- Untrusted: renderMarkdown sanitizes via DOMPurify (#30). -->
        <div class="msg assistant">{@html renderMarkdown(log.text ?? "")}</div>
      {:else if log?.kind === "tool_use"}
        <details class="tool">
          <summary>ツール呼び出し: {log.tool_name}</summary>
          <pre>{JSON.stringify(log.input ?? {}, null, 2)}{log.truncated
              ? "\n…(入力が大きいため省略)"
              : ""}</pre>
        </details>
      {:else if log?.kind === "tool_result"}
        <details class="tool">
          <summary>結果: {log.tool_name ?? "tool"}</summary>
          <pre>{log.output ?? ""}{log.truncated ? "\n…(省略)" : ""}</pre>
        </details>
      {:else if res}
        <!-- The reply text already shows as the final assistant log; the
             result only marks the turn boundary, not a duplicate (#29). -->
        <p class="turn-end" class:error={res.is_error}>
          {res.is_error ? "エラーで終了" : "応答完了"}
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
      <input
        type="text"
        placeholder="指示を送る…"
        bind:value={instruction}
        aria-label="instruction for {name}"
      />
      <button type="submit" disabled={instruction.trim() === ""}>送信</button>
    </form>

    {#if actionError}
      <p class="action-error">{actionError}</p>
    {/if}
  {/if}
</section>

<style>
  .detail {
    --tone: var(--c-idle);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 56rem;
    margin: 0 auto;
    min-height: calc(100vh - 4rem);
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
    align-items: center;
    gap: 1.2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--line);
  }

  .sprite {
    width: 5rem;
    height: 5rem;
    object-fit: contain;
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
  }

  .id {
    margin: 0.3rem 0 0;
    font-size: 0.7rem;
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  .log {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    overflow-y: auto;
    max-height: 60vh;
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
    gap: 0.5rem;
  }

  .instruct input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: 0.85rem;
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
