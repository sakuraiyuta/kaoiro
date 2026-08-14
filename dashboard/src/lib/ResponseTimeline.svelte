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

  import { expressionFor, spriteUrlFor } from "./expression";
  import {
    conversationEntries,
    conversationEntryKey,
    type ConversationEntry,
  } from "./conversationTimeline";
  import { formatRelativeJa } from "./relativeTime";
  import type { DirectoryEntry, Envelope, PersonaManifest } from "./protocol";

  let {
    agents,
    directory,
    logs,
    manifest = null,
    now,
    readTimelineEntryKeys = new Set<string>(),
    newTimelineEntryKeys = new Set<string>(),
    onMarkRead = () => {},
    onArrivalAnimationComplete = () => {},
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
    /** App session が所有する既読 marker。detail 表示でこの component が
     * unmount しても既読状態を失わない。 */
    readTimelineEntryKeys?: ReadonlySet<string>;
    /** onEnvelope 経由で追加された行だけの一回限り arrival marker (#125)。
     * history / snapshot は App がこの set に入れないため、初期描画では
     * アニメーションしない。 */
    newTimelineEntryKeys?: ReadonlySet<string>;
    onMarkRead?: (key: string) => void;
    /** CSS animation 完了時に App の one-shot marker を消費する。 */
    onArrivalAnimationComplete?: (key: string) => void;
    /** row click → 該当 agent の詳細を開く。 App.svelte 側で origin=null
     *  にして expand animation を省略する契約。 */
    onSelectAgent: (entry: ConversationEntry) => void;
  } = $props();

  const entries = $derived(conversationEntries(logs));
  let visibleCount = $state(50);
  const visibleEntries = $derived(entries.slice(0, visibleCount));
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
    if (readTimelineEntryKeys.has(key)) return;
    onMarkRead(key);
  }

  function scheduleRead(key: string, kind: string): void {
    if (
      !canBeUnread(kind) ||
      readTimelineEntryKeys.has(key) ||
      readTimers.has(key)
    ) return;
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

  // Unlike agent-strip (App.svelte) / AgentCard / AgentDetail, this
  // component resolves persona from a bare agentId string rather than
  // being handed an already-resolved envelope, because a timeline row
  // can reference an agent that is no longer in `agents` at all (its
  // whole transcript is a durable past log, e.g. after a server
  // restart). The `directory` fallback exists ONLY to cover that case —
  // see the "directory-only IA" test in responseTimeline.integration.
  // test.ts. It is a no-op whenever the agent is still live: `default`
  // (unassigned) persona is always a concrete `{id:"default",...}`
  // object (personas.md), never `undefined`, so `??` never reaches
  // `directory` for a live agent. issue #244's dashboard/App.svelte /
  // AgentCard.svelte / AgentDetail.svelte agree with this (verified) —
  // do not "fix" this fallback away as part of that issue.
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
        {@const expr = expressionFor(state)}
        {@const key = conversationEntryKey(entry.envelope)}
        <li>
          <button
            type="button"
            class="row"
            class:from-user={entry.kind === "user"}
            class:from-agent={entry.kind === "agent"}
            class:inter-agent={entry.kind === "inter_agent"}
            class:unread={canBeUnread(entry.kind) && !readTimelineEntryKeys.has(key)}
            class:new-arrival={canBeUnread(entry.kind) && newTimelineEntryKeys.has(key)}
            onmouseenter={() => scheduleRead(key, entry.kind)}
            onmouseleave={() => cancelScheduledRead(key)}
            onanimationend={(event) => {
              if (event.animationName === "timeline-arrival") {
                onArrivalAnimationComplete(key);
              }
            }}
            onclick={() => {
              markRead(key);
              onSelectAgent(entry);
            }}
            title={`${personaName(entry.agentId)} の詳細を開く`}
          >
            <!-- issue #244: sprite-less fallback mirrors agent-strip
                 (App.svelte) / AgentCard.svelte / AgentDetail.svelte's
                 CSS face (.face/.eye/.mouth) instead of a static emoji,
                 so the views never disagree again on an unassigned-
                 persona agent. This is NOT byte-identical to the other
                 3: the only contract all 4 share is
                 "sprite-or-CSS-face". Tone, eye/mouth shape and
                 animation already differ per site and are NOT unified
                 here — agent-strip keeps eye/mouth fixed at its 2.4rem
                 size (see App.svelte's `.chip .face` comment), and
                 neither `.chip` nor AgentDetail's `.detail` carries a
                 `waiting_question` tone rule while `.card` and this
                 `.portrait` do (pre-existing drift, ふじ 2026-08-14).
                 Unifying those is issue #245's job. This is a 4th manual
                 copy of that markup/CSS (the other three already note
                 they must be kept in sync by hand) — a shared component
                 was scoped out of this bugfix.
                 Follow-up: issue #245 (extract a shared PersonaFace.svelte
                 and replace all 4 copies). -->
            <span class="portrait" data-state={expr.variant} aria-hidden="true">
              {#if sprite}
                <img src={sprite} alt="" />
              {:else}
                <div class="face" role="img" aria-label={expr.label}>
                  <span class="eye left"></span>
                  <span class="eye right"></span>
                  <span class="mouth"></span>
                </div>
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

  /* #125: live stream で追加された行だけを 1 回パルスさせる。最終色を
     未閲覧の背景色と揃えることで、アニメーション終了後も #124 の静的な
     マーカーが自然に残る。 */
  .row.new-arrival {
    animation: timeline-arrival 1.35s ease-in-out;
  }

  @keyframes timeline-arrival {
    0% {
      background: color-mix(in srgb, var(--c-thinking) 34%, var(--bg-card));
    }

    38% {
      background: color-mix(in srgb, var(--c-thinking) 22%, var(--bg-card));
    }

    100% {
      background: color-mix(in srgb, var(--c-thinking) 14%, var(--bg-card));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .row.new-arrival {
      animation-duration: 0.01ms;
    }
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
    --tone: var(--c-idle);
  }

  .portrait img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* issue #244: state-tone + CSS face fallback. The contract shared by
     all 4 fallback sites (agent-strip / AgentCard / AgentDetail / here)
     is sprite-or-CSS-face, and nothing beyond it — the tone rules below
     are NOT uniform across the four (`.chip` and `.detail` have no
     `waiting_question` entry; issue #245 unifies this). The
     per-state eye/mouth SHAPE rules below additionally mirror only
     AgentCard.svelte / AgentDetail.svelte's `.face`/`.eye`/`.mouth`
     (agent-strip keeps its eye/mouth fixed at 2.4rem — see the
     template comment above). Sized in % of `.portrait` (2.25rem) since
     that circle is far smaller than AgentCard's (5.4rem) /
     AgentDetail's (responsive) — percentages scale correctly where the
     siblings' rem values would not; border/shadow weights are thinned
     to match. Keep these three (this file, AgentCard, AgentDetail) in
     sync when a state expression changes. */
  .portrait[data-state="sending"] { --tone: var(--c-sending); }
  .portrait[data-state="thinking"] { --tone: var(--c-thinking); }
  .portrait[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .portrait[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .portrait[data-state="waiting_question"] {
    --tone: var(--c-waiting_question);
  }
  .portrait[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .portrait[data-state="done"] { --tone: var(--c-done); }
  .portrait[data-state="error"] { --tone: var(--c-error); }
  .portrait[data-state="disconnected"] { --tone: var(--c-disconnected); }

  .face {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 1px solid var(--tone);
    animation: face-dissolve 0.35s ease-out;
  }

  @keyframes face-dissolve {
    from { opacity: 0; }
  }

  .eye {
    position: absolute;
    top: 38%;
    width: 14%;
    height: 14%;
    border-radius: 50%;
    background: var(--fg);
  }

  .eye.left { left: 26%; }
  .eye.right { right: 26%; }

  .mouth {
    position: absolute;
    bottom: 22%;
    left: 50%;
    translate: -50% 0;
    width: 30%;
    height: 14%;
    border-bottom: 1.5px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  [data-state="idle"] .mouth {
    width: 20%;
    height: 0;
    border-radius: 0;
  }

  [data-state="thinking"] .eye {
    top: 30%;
    height: 6%;
    border-radius: 50% 50% 0 0;
  }

  [data-state="thinking"] .mouth {
    width: 12%;
    height: 12%;
    border: 1.5px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="tool_running"] .eye {
    height: 8%;
    border-radius: 8%;
  }

  [data-state="tool_running"] .mouth {
    width: 24%;
    height: 0;
    border-radius: 0;
  }

  [data-state="waiting_permission"] .eye {
    width: 18%;
    height: 18%;
    box-shadow: inset 0 0 0 1.5px var(--tone);
  }

  [data-state="waiting_permission"] .mouth {
    width: 10%;
    height: 12%;
    border: 1.5px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="waiting_input"] .mouth {
    width: 36%;
  }

  [data-state="done"] .eye {
    height: 8%;
    border-radius: 0 0 50% 50%;
    background: transparent;
    border-bottom: 1.5px solid var(--fg);
  }

  [data-state="done"] .mouth {
    width: 40%;
    height: 18%;
  }

  [data-state="error"] .eye {
    border-radius: 0;
    background:
      linear-gradient(45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%);
  }

  [data-state="error"] .mouth {
    border-bottom: none;
    border-top: 1.5px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  [data-state="disconnected"] .face {
    opacity: 0.45;
  }

  [data-state="disconnected"] .eye {
    height: 3%;
    border-radius: 0;
  }

  [data-state="disconnected"] .mouth {
    width: 20%;
    height: 0;
    border-radius: 0;
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
