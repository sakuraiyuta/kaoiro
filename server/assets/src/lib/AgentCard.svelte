<script lang="ts">
  import { expressionFor, spriteUrlFor } from "./expression";
  import { permissionRequestOf } from "./protocol";
  import type {
    Envelope,
    KaoiroConnection,
    PersonaManifest,
  } from "./protocol";

  let {
    envelope,
    manifest = null,
    connection = null,
  }: {
    envelope: Envelope;
    manifest?: PersonaManifest | null;
    connection?: KaoiroConnection | null;
  } = $props();

  const expression = $derived(expressionFor(envelope.state));
  const name = $derived(envelope.persona?.name ?? envelope.agent_id);
  const spriteUrl = $derived(
    spriteUrlFor(manifest, envelope.persona?.sprite_set, envelope.state),
  );
  const permission = $derived(permissionRequestOf(envelope));

  let instruction = $state("");
  let actionError = $state("");

  // The card clears its own error once the agent moves on.
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

<article class="card" data-state={expression.variant}>
  {#key envelope.state}
    {#if spriteUrl}
      <img class="sprite" src={spriteUrl} alt={expression.label} />
    {:else}
      <div class="face" role="img" aria-label={expression.label}>
        <span class="eye left"></span>
        <span class="eye right"></span>
        <span class="mouth"></span>
      </div>
    {/if}
  {/key}
  <h2>{name}</h2>
  <p class="state">{expression.label}</p>
  <p class="id">{envelope.agent_id}</p>

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

  .card[data-state="thinking"] { --tone: var(--c-thinking); }
  .card[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .card[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .card[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .card[data-state="done"] { --tone: var(--c-done); }
  .card[data-state="error"] { --tone: var(--c-error); }
  .card[data-state="disconnected"] { --tone: var(--c-disconnected); }

  /* Persona sprite (ADR-0008): square transparent PNG, contain-fit.
     disconnected has no sprite by spec — grey out idle instead. */
  .sprite {
    display: block;
    width: 8rem;
    height: 8rem;
    margin: 0 auto 1rem;
    object-fit: contain;
    animation: pop 0.35s ease-out;
  }

  [data-state="disconnected"] .sprite {
    filter: grayscale(1);
    opacity: 0.45;
  }

  /* The placeholder face: 顔色 = the state color itself. Fallback when
     the manifest has no sprite for the persona. */
  .face {
    position: relative;
    width: 5.4rem;
    height: 5.4rem;
    margin: 0 auto 1rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: pop 0.35s ease-out;
  }

  @keyframes pop {
    from { transform: scale(0.85); }
    60% { transform: scale(1.05); }
  }

  .eye {
    position: absolute;
    top: 38%;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--fg);
  }

  .eye.left { left: 28%; }
  .eye.right { right: 28%; }

  .mouth {
    position: absolute;
    bottom: 24%;
    left: 50%;
    translate: -50% 0;
    width: 1.4rem;
    height: 0.65rem;
    border-bottom: 2px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  /* --- per-state expressions ----------------------------------------- */

  [data-state="idle"] .mouth {
    width: 0.9rem;
    height: 0;
    border-radius: 0;
  }

  [data-state="thinking"] .eye {
    top: 30%;
    height: 0.3rem;
    border-radius: 50% 50% 0 0;
  }

  [data-state="thinking"] .mouth {
    width: 0.5rem;
    height: 0.5rem;
    border: 2px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="thinking"] .face {
    animation: pop 0.35s ease-out, sway 2.4s ease-in-out infinite;
  }

  @keyframes sway {
    50% { rotate: 4deg; }
  }

  [data-state="tool_running"] .eye {
    height: 0.32rem;
    border-radius: 0.16rem;
  }

  [data-state="tool_running"] .mouth {
    width: 1.1rem;
    height: 0;
    border-radius: 0;
  }

  [data-state="waiting_permission"] .eye {
    width: 0.75rem;
    height: 0.75rem;
    box-shadow: inset 0 0 0 2px var(--tone);
  }

  [data-state="waiting_permission"] .mouth {
    width: 0.45rem;
    height: 0.55rem;
    border: 2px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="waiting_permission"] .face {
    animation: pop 0.35s ease-out, hop 1.1s ease-in-out infinite;
  }

  @keyframes hop {
    20% { translate: 0 -0.25rem; }
    40% { translate: 0 0; }
  }

  [data-state="waiting_input"] .mouth {
    width: 1.6rem;
  }

  [data-state="done"] .eye {
    height: 0.34rem;
    border-radius: 0 0 50% 50%;
    background: transparent;
    border-bottom: 2.5px solid var(--fg);
  }

  [data-state="done"] .mouth {
    width: 1.8rem;
    height: 0.8rem;
  }

  [data-state="error"] .eye {
    border-radius: 0;
    background:
      linear-gradient(45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%);
  }

  [data-state="error"] .mouth {
    border-bottom: none;
    border-top: 2px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  [data-state="disconnected"] .face {
    opacity: 0.45;
    box-shadow: none;
  }

  [data-state="disconnected"] .eye {
    height: 0.12rem;
    border-radius: 0;
  }

  [data-state="disconnected"] .mouth {
    width: 0.9rem;
    height: 0;
    border-radius: 0;
  }

  /* --- text ----------------------------------------------------------- */

  h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--fg);
  }

  .state {
    margin: 0.25rem 0 0;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--tone);
  }

  .id {
    margin: 0.45rem 0 0;
    font-size: 0.65rem;
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  /* --- bidirectional controls (Phase 3) ------------------------------- */

  .permission {
    margin-top: 0.9rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.4rem;
    text-align: left;
    font-size: 0.75rem;
  }

  .permission-tool {
    margin: 0;
    color: var(--fg);
  }

  .permission-note {
    margin: 0.3rem 0 0;
    color: var(--fg-dim);
  }

  .permission details {
    margin-top: 0.35rem;
    color: var(--fg-dim);
  }

  .permission pre {
    margin: 0.3rem 0 0;
    max-height: 8rem;
    overflow: auto;
    font-size: 0.65rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .permission-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.55rem;
  }

  .permission-actions button {
    flex: 1;
    padding: 0.3rem 0;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font-size: 0.75rem;
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
    gap: 0.4rem;
    margin-top: 0.8rem;
  }

  .instruct input {
    flex: 1;
    min-width: 0;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font-size: 0.75rem;
  }

  .instruct button {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font-size: 0.75rem;
    cursor: pointer;
  }

  .instruct button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .action-error {
    margin: 0.5rem 0 0;
    font-size: 0.7rem;
    color: var(--c-error);
    overflow-wrap: anywhere;
  }
</style>
