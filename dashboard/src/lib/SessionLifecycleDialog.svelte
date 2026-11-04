<script lang="ts">
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import { agentDisplayName } from "./personaName";
  import type { DirectoryEntry, Envelope, SessionLifecycleEventList, SessionLifecycleEventView } from "./protocol";

  let { agentId, label, fetchEvents, refreshKey, agents, directory, onClose }: {
    agentId: string;
    label: string;
    fetchEvents: (id: string) => Promise<SessionLifecycleEventList>;
    refreshKey: number;
    agents: Record<string, Envelope>;
    directory: Record<string, DirectoryEntry>;
    onClose: () => void;
  } = $props();

  let events = $state<SessionLifecycleEventView[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let incomplete = $state(false);
  let manualRefresh = $state(0);
  let requestSeq = 0;

  $effect(() => {
    const id = agentId;
    void refreshKey;
    void manualRefresh;
    const fetch = fetchEvents;
    const seq = ++requestSeq;
    let cancelled = false;
    const current = () => !cancelled && seq === requestSeq;
    untrack(() => {
      events = [];
      incomplete = false;
      error = null;
      loading = true;
      void fetch(id).then(
        (reply) => {
          if (!current()) return;
          events = reply.events;
          incomplete = reply.incomplete;
        },
        (failure: unknown) => {
          if (!current()) return;
          error = failure instanceof Error ? failure.message : "error";
        },
      ).finally(() => {
        if (current()) loading = false;
      });
    });
    return () => { cancelled = true; };
  });

  function timestamp(at: string): string {
    return Number.isNaN(Date.parse(at)) ? at : new Date(at).toLocaleString();
  }

  function requester(id: string): string {
    const name = agentDisplayName(id, agents, directory);
    return name === id ? id : `${name} (${id})`;
  }
</script>

<Modal ariaLabel="{label} のセッション履歴" {onClose} contentClass="session-lifecycle-dialog">
  <header>
    <h2>{label} のセッション履歴</h2>
    <button type="button" onclick={onClose} aria-label="閉じる">閉じる</button>
  </header>
  <p class="target-id">{agentId}</p>
  <button type="button" onclick={() => manualRefresh += 1}>更新</button>
  <p class="refresh-note">reset の開始・完了時に自動で再取得します。記録の順序により最新の行がまだ出ない場合や、ほかの種類の履歴は「更新」で取得できます。</p>
  {#if loading}<p class="loading" role="status">読み込み中</p>{/if}
  {#if error !== null}<p class="error" role="alert">履歴を取得できません ({error})</p>{/if}
  {#if incomplete}<p class="incomplete" role="status">履歴の一部を表示しています。古い行は応答サイズの上限により省略されています。</p>{/if}
  {#if !loading && error === null && !incomplete && events.length === 0}
    <p class="empty">履歴はありません</p>
  {/if}
  <ol class="events">
    {#each events as entry}
      {#if entry.status === "malformed"}
        <li class="lifecycle-row malformed">読めない行 — kind: {entry.rawKind ?? "unknown"} / at: {entry.rawAt ?? "unknown"}</li>
      {:else}
        <li class="lifecycle-row normal">
          <span class="kind">{entry.kind}</span> <time datetime={entry.at}>{timestamp(entry.at)}</time>
          {#if entry.trigger !== null}<span class="trigger">trigger: {entry.trigger}</span>{/if}
          {#if entry.disconnect !== null}<p>切断: {entry.disconnect.origin} ({entry.disconnect.reason})</p>{/if}
          {#if entry.resetAttribution !== null}
            <p>要求元: {entry.resetAttribution.origin}</p>
            {#if entry.resetAttribution.origin === "director"}
              <p class="requester">要求者: {requester(entry.resetAttribution.requested_by.id)}</p>
              <p class="work">work: {entry.resetAttribution.work_title === undefined
                ? entry.resetAttribution.work_id
                : `${entry.resetAttribution.work_title} (${entry.resetAttribution.work_id})`}</p>
            {/if}
          {/if}
        </li>
      {/if}
    {/each}
  </ol>
</Modal>

<style>
  :global(.modal-content.session-lifecycle-dialog) { width: min(48rem, calc(100vw - 2rem)); max-height: 85vh; overflow-y: auto; overflow-wrap: anywhere; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  h2 { font-size: var(--fs-h2); }
  .target-id, .refresh-note { color: var(--fg-dim); font-size: var(--fs-body); }
  .events { padding-inline-start: 1.5rem; }
  .lifecycle-row { font-size: var(--fs-body); padding: .7rem 0; border-bottom: 1px solid var(--line); }
  .lifecycle-row p { margin: .3rem 0; font-size: var(--fs-body-sm); }
  .kind { font-weight: 600; }
  time, .trigger { font-size: var(--fs-body-sm); }
  .trigger { display: block; }
  .malformed, .incomplete { color: var(--c-tool_running); }
  .error { color: var(--c-error); }
</style>
