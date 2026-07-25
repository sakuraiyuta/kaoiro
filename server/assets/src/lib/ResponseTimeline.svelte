<script lang="ts">
  import { onDestroy } from "svelte";
  // 実機検収 3 (2026-07-23 マスター指示): per-agent 最終応答一覧から
  // 「全 agent の会話ログを時系列マージ」に切り替え。 純関数の
  // 分類ロジックは conversationTimeline.ts が担当し、この component は
  // 描画と click routing のみ。
  //
  // 行の左には agent の persona 画像 (小サイズ) を置いて「誰との
  // メッセージか」を判別できるように。 user prompt の場合も送信先
  // agent の persona を出す (log kind=user の envelope は送信先 agent
  // の transcript に echoed されるので、envelope.agent_id がそのまま
  // 送信先 agent id)。 user 発と agent 発の見分けは軽い styling
  // (badge + row 色の tone) で。

  import { spriteUrlFor } from "./expression";
  import { conversationEntries, conversationEntryKey } from "./conversationTimeline";
  import { formatRelativeJa } from "./relativeTime";
  import type { DirectoryEntry, Envelope, PersonaManifest } from "./protocol";

  let {
    agents,
    directory,
    logs,
    manifest = null,
    now,
    onSelectAgent,
  }: {
    /** Persona lookup 用の agent 状態 map。 state 変更や filter には
     *  使わないので、切断済み agent の row も表示され得る (履歴が
     *  残っている限り)。 */
    agents: Record<string, Envelope>;
    /** Restart-persistent persona fallback for durable IA after AgentStates
     * is empty following a full server restart. */
    directory?: Record<string, DirectoryEntry>;
    /** 全 transcript map。 conversationEntries が assistant / user のみを
     * 取り出して時系列マージする（result は turn boundary として除外）。 */
    logs: Record<string, Envelope[]>;
    manifest?: PersonaManifest | null;
    /** ms clock。 formatRelativeJa の tick 用に App から受ける。 */
    now: number;
    /** row click → 該当 agent の詳細を開く。 App.svelte 側で origin=null
     *  にして expand animation を省略する契約。 */
    onSelectAgent: (agentId: string) => void;
  } = $props();

  const entries = $derived(conversationEntries(logs));
  let visibleCount = $state(50);
  const visibleEntries = $derived(entries.slice(0, visibleCount));
  // #124: 既読情報はこのブラウザ・この mount の中だけに置く。永続化しない
  // ため、リロード時には agent / inter-agent の全行が再び未閲覧になる。
  let readEntryKeys = $state<ReadonlySet<string>>(new Set());
  const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const HOVER_READ_DELAY_MS = 300;

  function canBeUnread(kind: string): boolean {
    return kind === "agent" || kind === "inter_agent";
  }

  function markRead(key: string): void {
    const timer = readTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      readTimers.delete(key);
    }
    if (readEntryKeys.has(key)) return;
    // Set を丸ごと置き換え、Svelte の依存追跡を明示的に起こす。
    readEntryKeys = new Set(readEntryKeys).add(key);
  }

  function scheduleRead(key: string, kind: string): void {
    if (!canBeUnread(kind) || readEntryKeys.has(key) || readTimers.has(key)) return;
    readTimers.set(
      key,
      setTimeout(() => markRead(key), HOVER_READ_DELAY_MS),
    );
  }

  function cancelScheduledRead(key: string): void {
    const timer = readTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    readTimers.delete(key);
  }

  onDestroy(() => {
    for (const timer of readTimers.values()) clearTimeout(timer);
    readTimers.clear();
  });

  function loadMore(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 8) {
      visibleCount = Math.min(entries.length, visibleCount + 50);
    }
  }

  function personaName(agentId: string): string {
    const p = agents[agentId]?.persona ?? directory?.[agentId]?.persona;
    return p?.name ?? agentId;
  }

  function personaSprite(agentId: string, state: string): string | null {
    const p = agents[agentId]?.persona ?? directory?.[agentId]?.persona;
    return spriteUrlFor(manifest, p?.sprite_set, state);
  }

  function stateFor(agentId: string): string {
    return agents[agentId]?.state ?? "disconnected";
  }
</script>

<aside class="timeline" aria-label="会話タイムライン">
  <h2 class="title">会話タイムライン</h2>
  {#if entries.length === 0}
    <p class="empty">まだ会話なし</p>
  {:else}
    <ul class="rows" onscroll={loadMore}>
      {#each visibleEntries as entry (conversationEntryKey(entry.envelope))}
        {@const state = stateFor(entry.agentId)}
        {@const sprite = personaSprite(entry.agentId, state)}
        {@const key = conversationEntryKey(entry.envelope)}
        <li>
          <button
            type="button"
            class="row"
            class:from-user={entry.kind === "user"}
            class:from-agent={entry.kind === "agent"}
            class:inter-agent={entry.kind === "inter_agent"}
            class:unread={canBeUnread(entry.kind) && !readEntryKeys.has(key)}
            onmouseenter={() => scheduleRead(key, entry.kind)}
            onmouseleave={() => cancelScheduledRead(key)}
            onclick={() => {
              markRead(key);
              onSelectAgent(entry.agentId);
            }}
            title={`${personaName(entry.agentId)} の詳細を開く`}
          >
            <span class="portrait" aria-hidden="true">
              {#if sprite}
                <img src={sprite} alt="" />
              {:else}
                <span class="portrait-fallback">👤</span>
              {/if}
            </span>
            <span class="meta">
              <span class="row-head">
                <span class="name">
                  {#if entry.kind === "user"}
                    <span class="who-badge" aria-label="operator prompt">→ {personaName(entry.agentId)}</span>
                  {:else if entry.kind === "inter_agent"}
                    <span class="who-name">{personaName(entry.agentId)} <span class="receiver">→ {entry.recipientId ? personaName(entry.recipientId) : "受信側"}</span></span>
                  {:else}
                    <span class="who-name">{personaName(entry.agentId)}</span>
                  {/if}
                </span>
                <span class="when">{formatRelativeJa(entry.envelope.ts, now)}</span>
              </span>
              <span class="summary">
                {entry.text ||
                  (entry.kind === "user" ? "(空メッセージ)" : entry.kind === "inter_agent" ? "(空の連携メッセージ)" : "(空応答)")}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: calc(100vh - 2rem);
    max-height: 100%;
    position: sticky;
    top: 1rem;
    padding: 0.75rem 0.85rem 1rem;
    border: 1px solid var(--line);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--bg-card) 70%, transparent);
    overflow: hidden;
  }

  .title {
    margin: 0 0 0.65rem;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--fg-dim);
    letter-spacing: 0.02em;
  }

  .empty {
    margin: 0.35rem 0 0;
    color: var(--fg-dim);
    font-size: var(--fs-body-sm);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    overflow-y: auto;
    min-height: 0;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    border: 1px solid transparent;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--bg-card) 88%, transparent);
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
    transition:
      border-color 0.12s,
      background 0.12s;
  }

  /* user prompt は subtle に色を変え、agent 発話と一目で区別できる
     ようにする。 マスター指示: 「軽い styling」なので border 左だけ
     アクセントを付ける最小コスト。 */
  .row.from-user {
    border-left: 3px solid color-mix(in srgb, var(--c-thinking) 60%, transparent);
    padding-left: 0.45rem;
  }

  .row.inter-agent {
    border-left: 3px solid color-mix(in srgb, var(--c-success) 60%, transparent);
    padding-left: 0.45rem;
  }

  .row:hover,
  .row:focus-visible {
    border-color: var(--c-thinking);
    background: color-mix(in srgb, var(--c-thinking) 8%, var(--bg-card));
    outline: none;
  }

  /* #124: 静かな青紫の面で未閲覧を残す。hover 中も少しだけ明度を上げる
     ので、既存の focus/hover 枠と区別しながら 300ms 後の既読化も分かる。 */
  .row.unread {
    background: color-mix(in srgb, var(--c-thinking) 14%, var(--bg-card));
  }

  .row.unread:hover,
  .row.unread:focus-visible {
    background: color-mix(in srgb, var(--c-thinking) 18%, var(--bg-card));
  }

  .portrait {
    flex: 0 0 auto;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    overflow: hidden;
    background: color-mix(in srgb, var(--bg-card) 60%, transparent);
    display: grid;
    place-items: center;
  }

  .portrait img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .portrait-fallback {
    font-size: 1.2rem;
    line-height: 1;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 auto;
  }

  .row-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    font-size: var(--fs-body-sm);
  }

  .name {
    font-weight: 600;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .who-name,
  .who-badge {
    font-weight: 600;
  }

  .receiver {
    color: var(--fg-dim);
    font-weight: 500;
  }

  .who-badge {
    color: color-mix(in srgb, var(--c-thinking) 80%, var(--fg));
    font-weight: 500;
  }

  .when {
    flex: 0 0 auto;
    color: var(--fg-dim);
    font-size: var(--fs-caption, var(--fs-body-sm));
    white-space: nowrap;
  }

  .summary {
    color: var(--fg-dim);
    font-size: var(--fs-body-sm);
    line-height: 1.35;
    /* #126: 短い preview も 3 行ぶんの面積を確保する。固定値ではなく
       line-height と同じ em 基準にすることで、文字サイズの設定変更にも
       追従する。 */
    min-block-size: 4.05em;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
