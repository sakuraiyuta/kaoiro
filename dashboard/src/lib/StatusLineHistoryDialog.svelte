<script lang="ts">
  // The change log of one agent's self-written status line (issue 482).
  // Newest first. Only the latest entry is rendered as markdown on open; an
  // older entry shows its time and first line as plain text and is rendered
  // only when expanded, so opening the dialog parses one entry however long
  // the log is. Entries are immutable, and a component instance is kept for as
  // long as its entry stays, so a refetch re-parses nothing that did not
  // change.
  import Modal from "./Modal.svelte";
  import UntrustedMarkdown from "./UntrustedMarkdown.svelte";
  import type { StatusLineHistoryEntry } from "./statusLine";

  let {
    agentId,
    label,
    fetchHistory,
    refreshKey,
    onClose,
  }: {
    agentId: string;
    /** What to call the agent in the title. */
    label: string;
    fetchHistory: (agentId: string) => Promise<StatusLineHistoryEntry[]>;
    /** Changes whenever the agent's latest line changes, so the log is read
     *  again. */
    refreshKey: string | null;
    onClose: () => void;
  } = $props();

  let entries = $state<StatusLineHistoryEntry[] | null>(null);
  let notice = $state<string | null>(null);
  let expanded = $state<Record<string, true>>({});

  // Identity of an entry: stable, because entries never change.
  function keyOf(entry: StatusLineHistoryEntry): string {
    return `${agentId}#${entry.seq}#${entry.updatedAt}`;
  }

  function firstLine(text: string): string {
    const line = text.split("\n", 1)[0] ?? "";
    return line === "" ? "(空の先頭行)" : line;
  }

  function clock(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString("ja-JP", { hour12: false });
  }

  // Reads on open and again when the agent writes. A reply that arrives after
  // the agent or the key changed belongs to a request nobody is waiting for.
  $effect(() => {
    const id = agentId;
    void refreshKey;
    let cancelled = false;
    fetchHistory(id).then(
      (next) => {
        if (cancelled) return;
        // Entries are immutable, so one already shown stays the very same
        // object: a fresh object for the same entry would make Svelte treat its
        // text as changed and render the markdown again.
        const held = new Map((entries ?? []).map((e) => [keyOf(e), e]));
        entries = next.map((e) => held.get(keyOf(e)) ?? e);
        notice = null;
      },
      (err: unknown) => {
        if (cancelled) return;
        const reason = err instanceof Error ? err.message : "error";
        if (reason === "unknown_agent") {
          // The agent left the set this viewer may see while the dialog was
          // open: keep nothing, so a stale log is not shown as current.
          entries = [];
          notice = "このエージェントの履歴は現在表示できません";
        } else if (reason === "status_line_unavailable") {
          notice = "履歴を一時的に取得できません";
        } else {
          notice = `履歴を取得できません (${reason})`;
        }
      },
    );
    return () => {
      cancelled = true;
    };
  });

  function toggle(entry: StatusLineHistoryEntry): void {
    const key = keyOf(entry);
    if (key in expanded) {
      const { [key]: _removed, ...rest } = expanded;
      expanded = rest;
    } else {
      expanded = { ...expanded, [key]: true };
    }
  }
</script>

<Modal ariaLabel="{label} の状況表示の履歴" {onClose} contentClass="status-line-history">
  <header class="head">
    <h2>{label} の状況表示</h2>
    <button type="button" class="close" onclick={onClose} aria-label="閉じる">✕</button>
  </header>

  {#if notice !== null}
    <p class="notice" role="status">{notice}</p>
  {/if}

  {#if entries === null}
    {#if notice === null}<p class="loading">読み込み中…</p>{/if}
  {:else if entries.length === 0 && notice === null}
    <p class="empty">履歴はありません</p>
  {:else}
    <ol class="entries">
      {#each entries as entry, index (keyOf(entry))}
        <li class="entry" data-seq={entry.seq}>
          <p class="meta">
            <time datetime={entry.updatedAt}>{clock(entry.updatedAt)}</time>
            {#if entry.bytes !== null}<span class="size">{entry.bytes} B</span>{/if}
          </p>
          {#if entry.text === null}
            <p class="cleared">(クリア)</p>
          {:else if index === 0 || keyOf(entry) in expanded}
            <UntrustedMarkdown text={entry.text} />
            {#if index !== 0}
              <button type="button" class="toggle" onclick={() => toggle(entry)}>折りたたむ</button>
            {/if}
          {:else}
            <p class="first-line">{firstLine(entry.text)}</p>
            <button type="button" class="toggle" onclick={() => toggle(entry)}>展開</button>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</Modal>

<style>
  :global(.modal-content.status-line-history) {
    width: min(42rem, 92vw);
    max-height: 80vh;
    overflow-y: auto;
    padding: 1rem 1.2rem;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-body);
  }

  .close {
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .notice,
  .loading,
  .empty {
    margin: 0.6rem 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .entries {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }

  .entry {
    border-top: 1px solid var(--line);
    padding-top: 0.5rem;
  }

  .meta {
    margin: 0 0 0.25rem;
    font-size: var(--fs-caption);
    color: var(--fg-dim);
    display: flex;
    gap: 0.6rem;
  }

  .cleared,
  .first-line {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .cleared {
    opacity: 0.6;
  }

  .toggle {
    margin-top: 0.3rem;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--fs-caption);
    color: var(--fg-dim);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
