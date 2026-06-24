<script lang="ts">
  // Operator launch dialog (#22, 案A/ADR-0024). Picks a host, one of its
  // declared personas, a cwd from the host allow-list, and an optional first
  // prompt, then asks the server to spawn. The server allocates the agent_id
  // and mints the per-agent token; this form never handles secrets.
  import type { HostInfo, KaoiroConnection } from "./protocol";

  let {
    hosts,
    connection,
    onClose,
  }: {
    hosts: HostInfo[];
    connection: KaoiroConnection;
    onClose: () => void;
  } = $props();

  let hostId = $state("");
  let personaId = $state("");
  let cwd = $state("");
  let prompt = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  const host = $derived(hosts.find((h) => h.host_id === hostId) ?? null);

  // Default the host to the first available, and keep persona/cwd valid for
  // the chosen host: fall back to the first option whenever the current
  // selection is not offered (also covers the initial empty state).
  $effect(() => {
    if (!hosts.some((h) => h.host_id === hostId)) {
      hostId = hosts[0]?.host_id ?? "";
    }
    const h = host;
    if (!h) return;
    if (!h.personas.some((p) => p.id === personaId)) {
      personaId = h.personas[0]?.id ?? "";
    }
    if (!h.cwd_allowlist.includes(cwd)) {
      cwd = h.cwd_allowlist[0] ?? "";
    }
  });

  const canLaunch = $derived(
    !busy && hostId !== "" && personaId !== "" && cwd !== "",
  );

  async function launch(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canLaunch) return;
    busy = true;
    error = null;
    try {
      const trimmed = prompt.trim();
      await connection.spawn({
        host_id: hostId,
        persona: personaId,
        cwd,
        ...(trimmed === "" ? {} : { initial_prompt: trimmed }),
      });
      // The launch outcome arrives separately via spawn_result; closing here
      // returns the operator to the grid where the new agent will appear.
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : "起動に失敗しました。";
    } finally {
      busy = false;
    }
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
<div class="dialog" role="dialog" aria-modal="true" aria-label="エージェント起動">
  <form onsubmit={launch}>
    <h2>エージェントを起動</h2>

    {#if hosts.length === 0}
      <p class="note">起動可能なホストがありません(runner 未接続)。</p>
    {:else}
      <label>
        ホスト
        <select bind:value={hostId}>
          {#each hosts as h (h.host_id)}
            <option value={h.host_id}>{h.host_id}</option>
          {/each}
        </select>
      </label>

      <label>
        ペルソナ
        <select bind:value={personaId} disabled={!host}>
          {#each host?.personas ?? [] as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>

      <label>
        作業ディレクトリ
        <select bind:value={cwd} disabled={!host}>
          {#each host?.cwd_allowlist ?? [] as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </label>

      <label>
        初期プロンプト(任意)
        <textarea
          bind:value={prompt}
          rows="3"
          placeholder="最初の指示(空ならアイドルで待機)"
        ></textarea>
      </label>
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={onClose}>キャンセル</button>
      <button type="submit" disabled={!canLaunch}>
        {busy ? "起動中…" : "起動"}
      </button>
    </div>
  </form>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(30rem, 92vw);
    padding: 1.6rem;
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    z-index: 1;
  }

  h2 {
    margin: 0 0 1rem;
    font-size: 0.95rem;
    color: var(--fg);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.78rem;
    color: var(--fg-dim);
  }

  select,
  textarea {
    padding: 0.5rem 0.6rem;
    font-size: 0.85rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    font-family: inherit;
  }

  textarea {
    resize: vertical;
  }

  .note {
    margin: 0;
    font-size: 0.8rem;
    color: var(--fg-dim);
  }

  .error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--c-error);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 0.3rem;
  }

  button {
    padding: 0.45rem 0.9rem;
    font-size: 0.82rem;
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  button.ghost {
    color: var(--fg-dim);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
