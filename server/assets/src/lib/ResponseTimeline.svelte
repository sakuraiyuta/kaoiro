<script lang="ts">
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
  import { conversationEntries } from "./conversationTimeline";
  import { formatRelativeJa } from "./relativeTime";
  import type { Envelope, PersonaManifest } from "./protocol";

  let {
    agents,
    logs,
    manifest = null,
    now,
    onSelectAgent,
  }: {
    /** Persona lookup 用の agent 状態 map。 state 変更や filter には
     *  使わないので、切断済み agent の row も表示され得る (履歴が
     *  残っている限り)。 */
    agents: Record<string, Envelope>;
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

  function personaName(agentId: string): string {
    const p = agents[agentId]?.persona;
    return p?.name ?? agentId;
  }

  function personaSprite(agentId: string, state: string): string | null {
    const p = agents[agentId]?.persona;
    return spriteUrlFor(manifest, p?.sprite_set, state);
  }

  function stateFor(agentId: string): string {
    return agents[agentId]?.state ?? "idle";
  }
</script>

<aside class="timeline" aria-label="会話タイムライン">
  <h2 class="title">会話タイムライン</h2>
  {#if entries.length === 0}
    <p class="empty">まだ会話なし</p>
  {:else}
    <ul class="rows">
      {#each entries as entry (entry.envelope.agent_id + "|" + entry.envelope.ts + "|" + (entry.envelope.seq ?? 0) + "|" + entry.envelope.type + "|" + entry.kind)}
        {@const state = stateFor(entry.agentId)}
        {@const sprite = personaSprite(entry.agentId, state)}
        <li>
          <button
            type="button"
            class="row"
            class:from-user={entry.kind === "user"}
            class:from-agent={entry.kind === "agent"}
            onclick={() => onSelectAgent(entry.agentId)}
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
                  {:else}
                    <span class="who-name">{personaName(entry.agentId)}</span>
                  {/if}
                </span>
                <span class="when">{formatRelativeJa(entry.envelope.ts, now)}</span>
              </span>
              <span class="summary">
                {entry.text ||
                  (entry.kind === "user" ? "(空メッセージ)" : "(空応答)")}
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
    max-height: 100%;
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

  .row:hover,
  .row:focus-visible {
    border-color: var(--c-thinking);
    background: color-mix(in srgb, var(--c-thinking) 8%, var(--bg-card));
    outline: none;
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
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
