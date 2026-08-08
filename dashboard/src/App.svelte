<script lang="ts">
  import { onMount } from "svelte";
  import AgentCard from "./lib/AgentCard.svelte";
  import AgentDetail from "./lib/AgentDetail.svelte";
  import AgentGridShell from "./lib/AgentGridShell.svelte";
  import LaunchDialog from "./lib/LaunchDialog.svelte";
  import SettingsDrawer from "./lib/SettingsDrawer.svelte";
  import { adjacentAgentId } from "./lib/agentNavigation";
  import {
    conversationEntryKey,
    isTimelineArrival,
  } from "./lib/conversationTimeline";
  import {
    beginTimelineReplay,
    clearTimelineReplay,
    completeTimelineReplay,
    computeStaleTimelineKeys,
    isTimelineReplayEnvelope,
    retainTimelineReplaysOfGeneration,
    type ActiveTimelineReplays,
  } from "./lib/timelineArrival";
  import { expressionFor, spriteUrlFor } from "./lib/expression";
  import type {
    AuthMethods,
    ConnectionStatus,
    DirectoryEntry,
    Envelope,
    HostInfo,
    KaoiroConnection,
    PersonaManifest,
    RunnerSessions,
    SpawnResult,
    TicketRefreshResult,
  } from "./lib/protocol";
  import {
    connectKaoiro,
    decideWakeAction,
    defaultSocketUrl,
    dispatchOnlineWake,
    fetchAuthMethods,
    fetchPersonaManifest,
    filterAfterHistoryCleared,
    filterInterAgentTargetsByWatermark,
    formatAgentLabel,
    isReplyEnvelope,
    mergeTranscriptEntries,
    applyProjectionEpoch,
    resetTranscriptHistory,
  } from "./lib/protocol";
  import {
    isWaitTransition,
    notifyWait,
    requestNotificationPermission,
  } from "./lib/notify";
  import { RELATIVE_TIME_TICK_MS } from "./lib/relativeTime";

  let agents = $state<Record<string, Envelope>>({});
  // Restart-surviving identity ledger (ADR-0030) — every agent_id we have
  // ever spawned, with its persona. Merged with `agents` (live) below to
  // surface offline entries in their own section with a restore button.
  let directory = $state<Record<string, DirectoryEntry>>({});
  // Sticky per-agent restore/spawn failure hints (ADR-0030 D8). Cleared
  // when the agent next reports a live envelope or a subsequent
  // spawn_result for the same agent_id succeeds.
  let spawnErrors = $state<Record<string, string>>({});
  // Per-agent session-reset progress (ADR-0036 F7, phase-17 17-9). The
  // value is the mode being reset ("new" | "clear"); presence in the
  // map means the reset is between started and completed/failed, which
  // the Composer uses to disable input and show a progress line.
  let sessionResets = $state<Record<string, "new" | "clear">>({});
  // Per-agent reply transcript (operator-only, ADR-0012): log/result
  // envelopes accumulate here instead of overwriting the latest state.
  let logs = $state<Record<string, Envelope[]>>({});
  // #124: read marker belongs to this session owner, rather than the
  // response-timeline mount. Opening a detail unmounts the grid/timeline;
  // keeping it here prevents an already-read row from becoming unread again.
  let readTimelineEntryKeys = $state<ReadonlySet<string>>(new Set());
  // #125: live socket envelope が実際に transcript へ追加されたときだけ
  // timeline に渡す one-shot CSS animation marker。history / snapshot は
  // この state を更新しないため、初回一括描画では点滅しない。
  let newTimelineEntryKeys = $state<ReadonlySet<string>>(new Set());
  // `history_reset` begins JSONL replay. The wrapper's explicit completion
  // boundary clears this map, so replayed assistant rows never look like a
  // live arrival while the first post-replay assistant still does. Each
  // marker carries the connection generation that opened it, so an epoch
  // discard can drop the dead ones without cancelling a running replay.
  let activeTimelineReplays = $state<ActiveTimelineReplays>({});
  // Per-agent IA visibility watermark (issue #109). It changes only after
  // operator clear_history; session transitions do not affect display.
  let clearWatermarks = $state<Record<string, string>>({});
  // ADR-0051 D4: the server projection lifetime `logs` was merged against.
  // A different value on the next `history` push means the projection we
  // merged into is gone (server restart / AgentStates crash) and the local
  // baseline is a ghost.
  let projectionEpoch: string | null = null;
  // Live reply envelopes received since THIS connection joined, kept apart
  // from the baseline so an epoch mismatch can drop the stale merge target
  // without losing rows that arrived before the history push (D4 step 1).
  // Not $state: nothing renders from it.
  //
  // ふじ 30-10 must-fix M1: the window is one CONNECTION's join → that
  // connection's `history` push, NOT "between two history pushes". The
  // earlier version only ever reset on a push, so rows from a previous,
  // now-dead projection sat in the buffer and an epoch mismatch promoted
  // them straight back into the baseline — resurrecting the exact ghosts
  // D4 exists to kill. `connectionGeneration` bumps on every channel join
  // and `awaitingHistory` is the open/closed flag for the window.
  let connectionGeneration = 0;
  let awaitingHistory = false;
  let liveSinceJoin: Record<string, Envelope[]> = {};
  // Ticking clock owned by App for the response-timeline pane (#25).
  // Passed to ResponseTimeline so its "N 分前" labels refresh live
  // without each row calling Date.now on its own. Advanced on
  // RELATIVE_TIME_TICK_MS by a setInterval in onMount; the same clock
  // also lets svelte-check track the reactivity chain cleanly.
  let now = $state(Date.now());
  let nowTimer: ReturnType<typeof setInterval> | undefined;
  // agent_id of the agent shown full-screen, or null for the grid.
  let selected = $state<string | null>(null);
  // Timeline click の発話位置。AgentDetail は stable entry identity を DOM
  // anchor に照合して、該当箇所まで smooth scroll する (#122)。primitive の
  // entryKey しか渡さないため、同じ行の再クリックでは reactive 変化として
  // 届かない (現状は開き直し = 別 selected → 別 target なので実運用では
  // 問題にならないが、同一 detail 内での repeat click は N/A)。
  let timelineScrollTarget = $state<{ entryKey: string } | null>(null);
  // Viewport centre of the tile that opened the detail, for the expand
  // animation (#36); null when no tile origin is known.
  let origin = $state<{ x: number; y: number } | null>(null);
  let status = $state<ConnectionStatus>("connecting");
  let manifest = $state<PersonaManifest | null>(null);
  let connection = $state<KaoiroConnection | null>(null);

  // Launch UI (#22, operator-only). `hosts` and operator-ness both come from
  // the `hosts` push, which only operators receive — so its arrival is what
  // reveals the launch affordance. `spawnNotice` is a transient toast for the
  // runner's spawn outcome.
  let hosts = $state<HostInfo[]>([]);
  let isOperator = $state(false);
  let showLaunch = $state(false);
  // Client-side settings drawer (#85, operator- and viewer-visible: it only
  // touches localStorage, no server round-trip).
  let showSettings = $state(false);
  let spawnNotice = $state<string | null>(null);
  let spawnNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  // spawn の immediate reply は新 agent が state_change を出す前に届くため、
  // 文字列を showNotice で固定すると label が永久に bare id のまま (#).
  // SpawnResult をそのまま保持して spawnResultText を $derived 化、 agents
  // の更新で label が自然に追従するようにする。
  let pendingSpawnResult = $state<SpawnResult | null>(null);
  let pendingSpawnTimer: ReturnType<typeof setTimeout> | undefined;
  // Latest resume candidates from enumerate_sessions (#22 phase-1); the
  // dialog matches them to its current host/cwd selection.
  let runnerSessions = $state<RunnerSessions | null>(null);
  let deletingAllOffline = $state(false);

  // Transient action notice (spawn outcome, or a stop/restore failure that
  // would otherwise fail silently, #22).
  function showNotice(message: string): void {
    spawnNotice = message;
    clearTimeout(spawnNoticeTimer);
    spawnNoticeTimer = setTimeout(() => (spawnNotice = null), 6000);
  }

  function notifySpawn(result: SpawnResult): void {
    // 文字列ではなく結果オブジェクトを $state に持たせて、 表示文字列は
    // spawnNoticeText が $derived で agents 更新に追従する形にする (#)。
    pendingSpawnResult = result;
    clearTimeout(pendingSpawnTimer);
    pendingSpawnTimer = setTimeout(() => (pendingSpawnResult = null), 6000);
  }

  // 表示用の単一窓口 — spawn 結果と汎用 notice を統合し、 spawn 結果は
  // agents の更新で label が自然に解決される。 spawn 結果が優先 (操作員の
  // アクションへの直接応答なので)。
  const spawnNoticeText = $derived.by<string | null>(() => {
    if (pendingSpawnResult !== null) {
      const label = formatAgentLabel(agents, pendingSpawnResult.agent_id);
      return pendingSpawnResult.ok
        ? `起動しました: ${label}`
        : `起動に失敗: ${label} (${pendingSpawnResult.reason ?? "error"})`;
    }
    return spawnNotice;
  });

  // Surface a control-command failure (stop / restore) that the grid buttons
  // would otherwise only console.warn (#22). `label` names the action.
  function notifyActionError(label: string, err: unknown): void {
    const reason = err instanceof Error ? err.message : "error";
    showNotice(`${label}できません (${reason})`);
  }

  // Login form (案A): shown when there is no live session — first load with
  // no usable cookie, after logout, or on a revoked-session 401. Submitting
  // exchanges the typed token for the httpOnly cookie (POST /session/new),
  // then opens the socket. The token is a shared viewer/operator secret
  // (ADR-0011), not a personal account; issue #65 tracks real auth.
  let needLogin = $state(false);
  let loginToken = $state("");
  let loginError = $state<string | null>(null);
  let loginBusy = $state(false);
  // Which login paths the server offers (issue #65 / ADR-0042), fetched at
  // startup. Defaults to token-only so a pre-#65 server (auth-methods
  // 404/unreachable) keeps today's behavior — see fetchAuthMethods.
  let authMethods = $state<AuthMethods>({ token: true, oauth: [] });

  // The first auth check (onMount) is async; until it resolves, render a
  // neutral loading state instead of flashing the dashboard before we know
  // whether a session exists.
  let authChecked = $state(false);

  // Connection lifecycle refs shared by mount / login / logout. Plain refs:
  // only their effects (connection, status) need to be reactive.
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  // Handlers for tab-visibility / network-online wake-ups (issue #123).
  // Retained across startSession / endSession so removeEventListener can pair
  // the exact function references addEventListener registered.
  let wakeHandler: (() => void) | undefined;
  let visibilityHandler: (() => void) | undefined;
  // Timestamp when the tab last went hidden (issue #123). shouldForceReconnectOnVisible
  // (protocol.ts) decides on visible-resume whether the gap crossed the
  // heartbeat-horizon threshold and a full socket rebuild is warranted.
  let hiddenAt: number | null = null;

  // Live grid: agents whose wrapper is currently connected (state !== disconnected).
  // Disconnected agents move to the offline section below so restore UX is
  // consistent whether the server restarted (directory-only) or only the
  // wrapper died (live disconnected — hot reload / crash / network hiccup).
  const sorted = $derived(
    Object.values(agents)
      .filter((envelope) => envelope.state !== "disconnected")
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  );
  // Everything not in the live grid: directory entries with NO AgentStates
  // envelope (server restarted, ADR-0030) AND live entries whose state is
  // `disconnected` (wrapper died, server survived). Both are restore
  // candidates; unifying them here keeps the operator's UX identical across
  // failure modes.
  type OfflineTile = {
    id: string;
    envelope: Envelope;
    directoryOnly: boolean;
  };
  const offlineEntries = $derived<OfflineTile[]>(
    [
      ...Object.entries(directory)
        .filter(([id]) => !(id in agents))
        .map(([id, entry]): OfflineTile => ({
          id,
          envelope: directoryEnvelope(id, entry),
          directoryOnly: true,
        })),
      ...Object.values(agents)
        .filter((env) => env.state === "disconnected")
        .map((env): OfflineTile => ({
          id: env.agent_id,
          envelope: env,
          directoryOnly: false,
        })),
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );

  // Synthesizes a minimal Envelope from a directory-only entry so AgentCard
  // can render it with the existing disconnected styling. `state=disconnected`
  // is what unlocks the restore button; live-disconnected tiles pass their
  // real envelope through instead (they carry the last session_id / ext).
  function directoryEnvelope(id: string, entry: DirectoryEntry): Envelope {
    return {
      version: "0",
      agent_id: id,
      persona: entry.persona,
      ts: "",
      type: "state_change",
      state: "disconnected",
    };
  }

  function markTimelineEntryRead(key: string): void {
    if (readTimelineEntryKeys.has(key)) return;
    readTimelineEntryKeys = new Set(readTimelineEntryKeys).add(key);
  }

  function consumeTimelineArrival(key: string): void {
    if (!newTimelineEntryKeys.has(key)) return;
    const next = new Set(newTimelineEntryKeys);
    next.delete(key);
    newTimelineEntryKeys = next;
  }

  /** Removes ephemeral timeline state for a specific set of stale keys.
   * ふじ再レビュー must-fix (2026-07-25): the previous "prune all of the
   * agent's rows" version dropped read/pulse state for entries that
   * filterAfterHistoryCleared / resetTranscriptHistory kept alive (IA
   * envelopes with preserve_inter_agent: true), so previously-read rows
   * reappeared as unread after resume. Callers now compute the actual
   * before→after diff via computeStaleTimelineKeys and pass only the
   * discarded keys; full-drop cases (agent_deleted) still pass every key.
   */
  function pruneTimelineStateByKeys(stale: Set<string>): void {
    if (stale.size === 0) return;
    readTimelineEntryKeys = new Set(
      [...readTimelineEntryKeys].filter((key) => !stale.has(key)),
    );
    newTimelineEntryKeys = new Set(
      [...newTimelineEntryKeys].filter((key) => !stale.has(key)),
    );
  }

  /** Drops the ephemeral timeline state derived from a discarded history.
   * `retainReplaysOfGeneration` keeps the replay markers opened on that
   * connection: an epoch discard invalidates the BASELINE, not the replay
   * the current wrapper still has in flight, and cancelling its marker made
   * every remaining replayed row pulse as a live arrival. `null` (logout)
   * wipes everything. */
  function clearTimelineState(
    retainReplaysOfGeneration: number | null = null,
  ): void {
    readTimelineEntryKeys = new Set();
    newTimelineEntryKeys = new Set();
    activeTimelineReplays =
      retainReplaysOfGeneration === null
        ? {}
        : retainTimelineReplaysOfGeneration(
            activeTimelineReplays,
            retainReplaysOfGeneration,
          );
  }

  /** What a `/clear` leaves in the pane: THIS reset's own session_boundary
   * marker and nothing else (ADR-0036 F3 復元, 2026-07-24). Matched by
   * `request_id` rather than by type, because prior /new・/clear markers
   * still held locally would otherwise survive and the pane would show 2+
   * boundary lines instead of exactly one. Shared by the `logs` update and
   * the join-window buffer mirror so the two cannot drift.
   */
  function retainClearMarkerOnly(
    rows: Envelope[],
    requestId: unknown,
  ): Envelope[] {
    return rows.filter(
      (entry) =>
        entry.type === "session_boundary" &&
        (entry.payload as { request_id?: unknown } | undefined)?.request_id ===
          requestId,
    );
  }

  /** Applies to the join-window buffer the same transformation just applied
   * to `logs`. The buffer becomes the baseline when an epoch mismatch
   * discards the old one (D4 step 1), so a clear / reset / delete that the
   * buffer never saw would come back to life exactly then — the case ふじ
   * 30-10 M1 flagged alongside the window boundary itself. */
  function mirrorIntoLiveBuffer(
    agentId: string,
    transform: (rows: Envelope[]) => Envelope[],
  ): void {
    const rows = liveSinceJoin[agentId];
    if (rows === undefined) return;
    const next = transform(rows);
    if (next.length === 0) {
      const { [agentId]: _drop, ...rest } = liveSinceJoin;
      liveSinceJoin = rest;
      return;
    }
    liveSinceJoin = { ...liveSinceJoin, [agentId]: next };
  }

  // A directory entry is enough to render a read-only offline detail. This
  // makes durable IA rows clickable even immediately after a server restart,
  // before their sender has reconnected and emitted a live state envelope.
  const selectedEnvelope = $derived.by<Envelope | null>(() => {
    if (selected === null) return null;
    return agents[selected] ??
      (directory[selected] ? directoryEnvelope(selected, directory[selected]) : null);
  });
  // Detail navigation follows the live grid's displayed order. Disconnected
  // cards live in a separate collapsed section and are intentionally absent
  // from the ring, matching the existing detail header's live-agent strip.
  const navigableAgentIds = $derived(
    sorted.map((envelope) => envelope.agent_id),
  );
  const previousAgentId = $derived(
    selected === null
      ? null
      : adjacentAgentId(navigableAgentIds, selected, -1),
  );
  const nextAgentId = $derived(
    selected === null
      ? null
      : adjacentAgentId(navigableAgentIds, selected, 1),
  );

  function selectAdjacentAgent(agentId: string | null): void {
    if (agentId === null || agents[agentId] === undefined) return;
    // Side navigation originates from the detail itself, not a grid tile.
    // Avoid replaying the expand-from-card animation with a stale origin.
    origin = null;
    timelineScrollTarget = null;
    selected = agentId;
  }

  function agentDisplayName(agentId: string): string {
    return agents[agentId]?.persona?.name ?? agentId;
  }

  // Opens the client socket with the given auth and starts the cookie-slide
  // timer (ADR-0013). `slideNow` does an immediate refresh because a cookie
  // already exists (reload / login paths); the first `?token=` load skips it
  // since its cookie-setting POST may still be in flight.
  function startSession(
    connectOpts: { token?: string; ticket?: string },
    slideNow: boolean,
  ): void {
    status = "connecting";
    // A WebSocket ticket lives for only 30 seconds. Keep its minting here,
    // next to the cookie-owned session lifecycle, while protocol.ts gates
    // every reconnect (including Phoenix's native retry) on this callback.
    // Only 401 is terminal; a transient failed request is retried by the
    // connection without ever reusing the expired ticket.
    const ticketRefreshOptions =
      connectOpts.ticket === undefined
        ? {}
        : {
            refreshTicket: async (
              signal: AbortSignal,
            ): Promise<TicketRefreshResult> => {
              const res = await fetch("/session/ticket", { signal });
              if (res.status === 401) return { kind: "unauthorized" };
              if (!res.ok) {
                throw new Error(`ticket refresh failed (${res.status})`);
              }
              const body = (await res.json()) as { ticket?: string };
              if (typeof body.ticket !== "string" || body.ticket === "") {
                throw new Error("ticket refresh returned no ticket");
              }
              return { kind: "ok", ticket: body.ticket };
            },
            onTicketRefreshUnauthorized: (): void => {
              if (!destroyed) {
                endSession();
                needLogin = true;
              }
            },
          };
    connection = connectKaoiro(
      defaultSocketUrl(location),
      {
        onStatus: (next) => (status = next),
        onJoined: () => {
          // A fresh connection: everything the previous one buffered belongs
          // to a projection this connection has not been told about yet, and
          // its replay markers can never be completed (the wrapper restarts
          // its own handshake per connection). Both go now, before the first
          // envelope of the new window arrives.
          connectionGeneration += 1;
          awaitingHistory = true;
          liveSinceJoin = {};
          activeTimelineReplays = retainTimelineReplaysOfGeneration(
            activeTimelineReplays,
            connectionGeneration,
          );
        },
        onSnapshot: (next) => (agents = next),
        onEnvelope: (envelope) => {
          // Reply lines feed the transcript; state envelopes update the
          // latest-state map that drives the grid faces.
          if (isReplyEnvelope(envelope)) {
            // inter_agent_message lands in BOTH the sender's and receiver's
            // transcript (protocol-inter-agent spec) so each agent's detail
            // view shows the full conversation. Operator-only — viewers
            // never receive these envelopes (sanitize_envelope_for drops
            // them at the channel boundary).
            let targets: Iterable<string> = new Set<string>([envelope.agent_id]);
            if (envelope.type === "inter_agent_message") {
              const to = (envelope.payload as { to?: unknown } | undefined)?.to;
              const acc = new Set<string>(targets);
              if (typeof to === "string" && to !== "") acc.add(to);
              // Server-synthesized escalates carry agent_id="server" with no
              // grid slot of their own; drop the synthetic sender so it does
              // not accumulate a phantom logs["server"] transcript.
              if (envelope.agent_id === "server") acc.delete("server");
              // ふじ R4 must-fix (2026-07-23): best-effort watermark
              // filter on the live path. A pane whose watermark >=
              // envelope.ts already has this IA hidden on reload
              // (server-authoritative ingress-order filter); drop it
              // here too so live and reload stay consistent within
              // clock-skew bounds.
              targets = filterInterAgentTargetsByWatermark(
                envelope,
                acc,
                clearWatermarks,
              );
            }
            const next = { ...logs };
            let addedToTranscript = false;
            for (const id of targets) {
              const previous = next[id] ?? [];
              const merged = mergeTranscriptEntries(previous, [envelope]);
              if (merged.length > previous.length) addedToTranscript = true;
              next[id] = merged;
              // ADR-0051 D4 step 1: remember it separately, so a history
              // push that invalidates the baseline can still keep it — but
              // ONLY inside this connection's join→history window. Outside
              // it the baseline is already authoritative and buffering
              // would just hoard rows for the next mismatch to resurrect.
              if (awaitingHistory) {
                liveSinceJoin[id] = mergeTranscriptEntries(
                  liveSinceJoin[id] ?? [],
                  [envelope],
                );
              }
            }
            logs = next;
            // JSONL resume replay deliberately reuses ordinary `envelope`
            // events. Its explicit reset/complete boundary, rather than an
            // arrival-count heuristic, is what distinguishes it from a live
            // assistant reply.
            const isResumeReplay = isTimelineReplayEnvelope(
              activeTimelineReplays,
              envelope,
            );
            if (
              addedToTranscript &&
              isTimelineArrival(envelope) &&
              !isResumeReplay
            ) {
              newTimelineEntryKeys = new Set(newTimelineEntryKeys).add(
                conversationEntryKey(envelope),
              );
            }
          } else {
            const prevState = agents[envelope.agent_id]?.state;
            agents = { ...agents, [envelope.agent_id]: envelope };
            // A live envelope from a previously-failed restore clears its
            // sticky error hint (ADR-0030 D8): the agent is speaking again.
            if (
              envelope.state !== "disconnected" &&
              spawnErrors[envelope.agent_id] !== undefined
            ) {
              const { [envelope.agent_id]: _drop, ...rest } = spawnErrors;
              spawnErrors = rest;
            }
            // Alert the operator the moment an agent needs them (#7).
            if (isWaitTransition(prevState, envelope.state)) {
              notifyWait(envelope);
            }
          }
        },
        onHistory: (histories, watermarks, projection, epoch) => {
          // issue #109 M6/M7 (2026-07-23): server pre-fans-out and
          // pre-filters IA per pane using its ingress ordering domain,
          // so `histories` already reflects the authoritative view for
          // every agent when the projection marker is present.
          // Watermarks are kept only as a display hint for the
          // live-clear UI.
          //
          // ふじ R3 must-fix (2026-07-23): the projection marker gates
          // the rolling-upgrade window (per-pane-v1 → direct merge,
          // absent → legacy fanOut). ふじ 4th advisory 2 (same date):
          // the projection-branch + fanOut + merge chain lives in
          // `projectAndMergeHistory` so this glue and the R3 composite
          // table test call the same production helper.
          //
          // ADR-0051 D4: `projection_epoch` decides WHAT this push merges
          // into. Same epoch (or a legacy server that sends none) keeps the
          // old behaviour; a different one means the projection the local
          // baseline was built against no longer exists, so the baseline is
          // dropped and only this connection's live rows survive alongside
          // the authoritative history.
          const applied = applyProjectionEpoch({
            previousEpoch: projectionEpoch,
            incomingEpoch: epoch,
            histories,
            incomingWatermarks: watermarks,
            previousWatermarks: clearWatermarks,
            projection,
            baseline: logs,
            sinceJoin: liveSinceJoin,
          });
          if (applied.discarded) {
            // Everything else derived from the discarded history goes with
            // it: the read / new timeline keys and the replay markers of
            // PREVIOUS connections now point at rows that no longer exist.
            // This connection's own markers stay — its replay is still
            // running and its rows must not start pulsing as live.
            clearTimelineState(connectionGeneration);
          }
          clearWatermarks = applied.clearWatermarks;
          logs = applied.logs;
          projectionEpoch = applied.epoch;
          // The window this buffer covers — this connection's join until
          // its history push — has closed; live envelopes now land in
          // `logs` directly.
          awaitingHistory = false;
          liveSinceJoin = {};
        },
        onHistoryCleared: (agentId, sessionId, watermark) => {
          // An operator purged past-session lines (#48); keep only the
          // surviving session's transcript to match the server buffer.
          //
          // ふじ R4 must-fix (2026-07-23): also drop any pre-clear
          // inter_agent_message (same-session IA whose ts <= watermark).
          // The session_id filter alone leaves IA whose session_id
          // happens to match the current session visible on the live
          // path — a reload would hide them because the server-side
          // ingress-order filter dominates. Move the watermark FIRST so
          // the filter uses the freshest value even if the server
          // omitted `watermark` on the broadcast (legacy path).
          if (typeof watermark === "string") {
            const current = clearWatermarks[agentId];
            if (current === undefined || current < watermark) {
              clearWatermarks = { ...clearWatermarks, [agentId]: watermark };
            }
          }
          const prev = logs[agentId];
          if (prev) {
            const next = filterAfterHistoryCleared(
              prev,
              sessionId,
              clearWatermarks[agentId],
            );
            pruneTimelineStateByKeys(
              computeStaleTimelineKeys(prev, next, conversationEntryKey),
            );
            logs = { ...logs, [agentId]: next };
          }
          mirrorIntoLiveBuffer(agentId, (rows) =>
            filterAfterHistoryCleared(rows, sessionId, clearWatermarks[agentId]),
          );
        },
        onHistoryReset: (agentId, preserveInterAgent, replayId) => {
          // history_reset is resume replay only; /new and /clear preserve
          // the existing display projection (#109).
          const prev = logs[agentId] ?? [];
          const next = resetTranscriptHistory(prev, preserveInterAgent);
          pruneTimelineStateByKeys(
            computeStaleTimelineKeys(prev, next, conversationEntryKey),
          );
          logs = { ...logs, [agentId]: next };
          mirrorIntoLiveBuffer(agentId, (rows) =>
            resetTranscriptHistory(rows, preserveInterAgent),
          );
          activeTimelineReplays = beginTimelineReplay(
            activeTimelineReplays,
            agentId,
            replayId,
            connectionGeneration,
          );
        },
        onHistoryReplayEnvelope: (paneAgentId, envelope) => {
          // ADR-0051 D3-3 追補: the server already decided which pane this
          // restored row belongs to. Unlike `onEnvelope` above there is NO
          // fan-out to payload.to — that widening is precisely what put a
          // restored row into an offline peer's pane (ふじ 30-10 M2). No
          // arrival marker either: this is a replay, not a live reply.
          const previous = logs[paneAgentId] ?? [];
          logs = {
            ...logs,
            [paneAgentId]: mergeTranscriptEntries(previous, [envelope]),
          };
          if (awaitingHistory) {
            liveSinceJoin[paneAgentId] = mergeTranscriptEntries(
              liveSinceJoin[paneAgentId] ?? [],
              [envelope],
            );
          }
        },
        onHistoryReplayComplete: (agentId, replayId) => {
          // Ignore stale completions from an older reconnect; only the
          // boundary paired to the currently active reset may enable pulse.
          activeTimelineReplays = completeTimelineReplay(
            activeTimelineReplays,
            agentId,
            replayId,
          );
        },
        onAgentDeleted: (agentId) => {
          // A disconnected agent was removed (#14, ADR-0030 D6): drop it
          // from the grid, its transcript, the directory ledger, AND any
          // sticky spawn error. Missing the directory drop leaves a
          // directory-only tile (the operator's typical delete target for
          // a restore-broken agent) visible in the offline section until a
          // page reload re-fetches the shrunk directory. The detail view
          // falls back to the grid on its own when the selected agent
          // vanishes (selectedEnvelope).
          // agent_deleted は transcript を丸ごと破棄するので、prev の全 key
          // が stale (= next=[] との差集合)。
          {
            const prev = logs[agentId] ?? [];
            pruneTimelineStateByKeys(
              computeStaleTimelineKeys(prev, [], conversationEntryKey),
            );
          }
          activeTimelineReplays = clearTimelineReplay(
            activeTimelineReplays,
            agentId,
          );
          agents = Object.fromEntries(
            Object.entries(agents).filter(([id]) => id !== agentId),
          );
          if (agentId in directory) {
            directory = Object.fromEntries(
              Object.entries(directory).filter(([id]) => id !== agentId),
            );
          }
          if (logs[agentId]) {
            logs = Object.fromEntries(
              Object.entries(logs).filter(([id]) => id !== agentId),
            );
          }
          // The join-window buffer holds a second copy of the transcript and
          // becomes the baseline on an epoch mismatch, so a deleted agent
          // left in it would reappear with its whole history.
          mirrorIntoLiveBuffer(agentId, () => []);
          if (agentId in spawnErrors) {
            const { [agentId]: _drop, ...rest } = spawnErrors;
            spawnErrors = rest;
          }
        },
        onHosts: (next) => {
          // Operators alone receive `hosts`, so this is also the operator
          // signal that reveals the launch UI (#22).
          hosts = next;
          isOperator = true;
        },
        onDirectory: (next) => (directory = next),
        onSpawnResult: (result) => {
          notifySpawn(result);
          // Track failed restore/spawn per agent so the tile can show a
          // sticky error icon (ADR-0030 D8). A subsequent success or a live
          // envelope clears it above.
          if (!result.ok) {
            spawnErrors = {
              ...spawnErrors,
              [result.agent_id]: result.reason ?? "error",
            };
          } else if (spawnErrors[result.agent_id] !== undefined) {
            const { [result.agent_id]: _drop, ...rest } = spawnErrors;
            spawnErrors = rest;
          }
        },
        onSessions: (result) => (runnerSessions = result),
        onAttachRejected: (payload) => {
          // wrapper-side upload rejection (file-upload spec / ADR-0025);
          // surface to operator via the shared transient notice channel.
          showNotice(
            `添付却下: ${payload.upload_id} (${payload.reason}${
              payload.detail !== undefined ? ` — ${payload.detail}` : ""
            })`,
          );
        },
        onInstructionRejected: (payload) => {
          showNotice(
            `指示却下: ${payload.reason}${
              payload.detail !== undefined ? ` — ${payload.detail}` : ""
            }`,
          );
        },
        // phase-17 17-9: session-reset lifecycle events. `started` /
        // `completed` update a per-agent progress flag consumed by
        // AgentDetail's Composer disable / progress indicator. `failed`
        // additionally surfaces a loud notice with the closed-vocab
        // reason so the operator sees why (agent_busy /
        // unsupported_session_reset / session_reset_pending /
        // runner_unavailable / spawn_failed / rollback_failed / timeout).
        onSessionResetStarted: (payload) => {
          sessionResets = { ...sessionResets, [payload.agent_id]: payload.mode };
        },
        onSessionResetCompleted: (payload) => {
          const { [payload.agent_id]: _drop, ...rest } = sessionResets;
          void _drop;
          sessionResets = rest;
          // ADR-0036 F3 復元 (2026-07-24): /clear は当該 agent の pane 表示を
          // marker 1 行だけに絞る。marker envelope は同じ session_reset で
          // 先に届いているので、非 marker を drop する形で pane を空にする。
          // clear_watermark は future の live IA を per-pane hide するために
          // ローカル map へ反映する — reload 時は server merged_histories が
          // authoritative に filter するのでこの map は live 用途のみ。
          if (payload.mode === "clear") {
            if (typeof payload.clear_watermark === "string") {
              const current = clearWatermarks[payload.agent_id];
              if (current === undefined || current < payload.clear_watermark) {
                clearWatermarks = {
                  ...clearWatermarks,
                  [payload.agent_id]: payload.clear_watermark,
                };
              }
            }
            const prev = logs[payload.agent_id];
            if (prev) {
              logs = {
                ...logs,
                [payload.agent_id]: retainClearMarkerOnly(
                  prev,
                  payload.request_id,
                ),
              };
            }
            // ふじ 30-10 R1: `/clear` は他の 3 経路と同じく buffer にも
            // 効かせる。epoch 不一致で buffer が baseline に昇格したとき、
            // mirror していないと clear 前の行がそのまま蘇る。
            mirrorIntoLiveBuffer(payload.agent_id, (rows) =>
              retainClearMarkerOnly(rows, payload.request_id),
            );
          }
        },
        onSessionResetFailed: (payload) => {
          const { [payload.agent_id]: _drop, ...rest } = sessionResets;
          void _drop;
          sessionResets = rest;
          showNotice(
            `session_reset 失敗 (${payload.mode}): ${payload.reason}`,
          );
        },
      },
      { ...connectOpts, ...ticketRefreshOptions },
    );

    // Slide the httpOnly cookie while this tab is open so future reloads can
    // still mint a ticket (ADR-0013). On 401 the session is gone
    // (revoked/expired) — tear down and fall back to the login form.
    const refresh = (): void => {
      void fetch("/session/refresh").then(
        (r) => {
          // Guard against an in-flight refresh resolving after teardown.
          if (r.status === 401 && !destroyed) {
            endSession();
            needLogin = true;
          }
        },
        () => {},
      );
    };
    if (slideNow) refresh();
    refreshTimer = setInterval(refresh, 12 * 60 * 60 * 1000);

    // issue #123: macOS スリープ復帰時などブラウザが WS を切っても close
    // event が届かず Phoenix 内蔵 reconnect が発火しないケースの救済。
    // タブ復帰 / ネット復帰時に status が disconnected なら明示的に socket を
    // 張り直す。connected の間は no-op なので誤検知で無限リトライしない。
    // wake / visibility lifecycle (issue #123 round 3). Decision logic
    // is factored into decideWakeAction (protocol.ts) so every branch is
    // unit-testable without mounting this component.
    wakeHandler = () => {
      if (connection === null) return;
      // dispatchOnlineWake (issue #162 advisory 2) picks exactly one of
      // notifyOnline() / reconnect(): a healthy socket (decision "noop")
      // still needs notifyOnline() so a ticket-mint retry waiting under
      // exponential backoff runs immediately when the network returns, but
      // a disconnected socket (decision "reconnect") only needs reconnect()
      // — it already performs everything notifyOnline() would, and calling
      // both back-to-back let reconnect()'s requireFreshTicket() abort a
      // mint notifyOnline() had just started (advisory 1's dominant
      // trigger; see the analysis on requireFreshTicket in protocol.ts).
      const decision = decideWakeAction(
        "online",
        status,
        hiddenAt,
        Date.now(),
      );
      dispatchOnlineWake(decision, connection);
    };
    visibilityHandler = () => {
      const reason =
        document.visibilityState === "hidden"
          ? "visibility-hidden"
          : "visibility-visible";
      const decision = decideWakeAction(reason, status, hiddenAt, Date.now());
      if (decision === "record-hidden") {
        hiddenAt = Date.now();
        return;
      }
      hiddenAt = null;
      if (decision === "reconnect" || decision === "force-reconnect") {
        connection?.reconnect();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    window.addEventListener("online", wakeHandler);
  }

  // Tears down the live socket and its slide timer without touching the
  // cookie; the caller decides what to show next.
  function endSession(): void {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    if (visibilityHandler !== undefined) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = undefined;
    }
    if (wakeHandler !== undefined) {
      window.removeEventListener("online", wakeHandler);
      wakeHandler = undefined;
    }
    hiddenAt = null;
    connection?.disconnect();
    connection = null;
    // Hide the launch UI until the next connection re-announces hosts; a
    // revoked/expired session must not keep the operator affordance.
    hosts = [];
    isOperator = false;
    showLaunch = false;
    runnerSessions = null;
    // Clear the identity ledger overlay so a re-connect / login starts
    // clean; the next `directory` push repopulates for operators.
    directory = {};
    spawnErrors = {};
  }

  // Bulk restore of every offline entry (ADR-0030 D5). Confirms once, then
  // fires the same per-agent restore call the tile button uses — one at a
  // time in a for-loop, since spawn broadcasts are fire-and-forget and each
  // is guarded by the runner's in-flight lock (ADR-0030 D11).
  async function restoreAllOffline(): Promise<void> {
    if (!connection || offlineEntries.length === 0) return;
    const count = offlineEntries.length;
    if (!confirm(`${count} 体のオフラインエージェントを一括復元します。よろしいですか?`)) {
      return;
    }
    for (const tile of offlineEntries) {
      try {
        await connection.restore(tile.id);
      } catch (err) {
        // Record locally too — spawn_result will land later for successful
        // restores, but a per-restore RPC-level error (rare) still needs
        // surfacing so the tile picks up the icon.
        spawnErrors = {
          ...spawnErrors,
          [tile.id]: err instanceof Error ? err.message : "error",
        };
      }
    }
  }

  // Bulk purge uses the same guarded server operation as each tile's delete
  // button. Snapshot the ids before starting because every successful delete
  // broadcasts `agent_deleted`, which shrinks `offlineEntries` as we iterate.
  async function deleteAllOffline(): Promise<void> {
    if (!connection || offlineEntries.length === 0 || deletingAllOffline) return;
    const ids = offlineEntries.map((tile) => tile.id);
    if (
      !confirm(
        `${ids.length} 体のオフラインエージェントを完全に削除します。` +
          "\n会話の復元情報も削除されます。この操作は取り消せません。よろしいですか?",
      )
    ) {
      return;
    }

    deletingAllOffline = true;
    let failed = 0;
    try {
      for (const id of ids) {
        try {
          await connection.deleteAgent(id);
        } catch {
          failed += 1;
        }
      }
    } finally {
      deletingAllOffline = false;
    }

    if (failed > 0) {
      showNotice(`${failed} 体を削除できませんでした`);
    }
  }

  // Mints a short-lived WS ticket from the current httpOnly cookie and opens
  // the socket; no usable cookie/ticket falls back to the login form. Shared
  // by the reload path and post-login: both already hold a valid cookie and
  // must connect via the ticket so the reusable token never rides the WS
  // upgrade URL / access logs (ADR-0013).
  async function connectFromCookie(): Promise<void> {
    try {
      const res = await fetch("/session/ticket");
      if (res.ok) {
        const body = (await res.json()) as { ticket?: string };
        if (typeof body.ticket === "string") {
          if (!destroyed) startSession({ ticket: body.ticket }, true);
          return;
        }
      }
    } catch {
      // No cookie / network error: fall through to the login form.
    }
    if (!destroyed) needLogin = true;
  }

  // Login form submit: exchange the typed token for the cookie, then connect.
  async function login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const token = loginToken.trim();
    if (token === "" || loginBusy) return;
    loginBusy = true;
    loginError = null;
    try {
      // Token in the POST body, not the URL, so it stays out of access logs.
      const res = await fetch("/session/new", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        loginError = "トークンが無効です。";
        return;
      }
    } catch {
      loginError = "サーバに接続できませんでした。";
      return;
    } finally {
      loginBusy = false;
    }
    loginToken = "";
    needLogin = false;
    // Connect via a ticket minted from the just-set cookie, not the raw
    // token, so the shared secret never rides the WS upgrade URL / access
    // logs — same as the reload path (ADR-0013).
    await connectFromCookie();
  }

  // Logout (#47): drop the server session + cookie, force-close the socket,
  // and return to the login form. Re-entry needs a token (no personal
  // accounts yet — issue #65), so confirm to avoid an accidental logout.
  async function logout(): Promise<void> {
    if (!confirm("ログアウトしますか?")) return;
    try {
      await fetch("/session", { method: "DELETE" });
    } catch {
      // Drop the local session even if the request fails, so the operator
      // is never stuck on a dead or forbidden socket.
    }
    endSession();
    // Don't keep the previous session's data behind the login form.
    agents = {};
    logs = {};
    liveSinceJoin = {};
    awaitingHistory = false;
    projectionEpoch = null;
    clearTimelineState();
    timelineScrollTarget = null;
    selected = null;
    needLogin = true;
  }

  // Japanese wording for the callback's `?auth_error=` code (ADR-0042 API
  // contract). Unknown codes fall back to a generic message rather than
  // showing nothing.
  function authErrorMessage(code: string): string {
    switch (code) {
      case "provider_error":
        return "認証プロバイダでのログインに失敗しました。";
      case "not_allowed":
        return "このアカウントはアクセスを許可されていません。管理者に確認してください。";
      case "invalid_state":
        return "認証セッションの有効期限が切れました。もう一度お試しください。";
      default:
        return "ログインに失敗しました。もう一度お試しください。";
    }
  }

  function oauthProviderLabel(provider: string): string {
    switch (provider) {
      case "google":
        return "Google";
      case "github":
        return "GitHub";
      case "nextcloud":
        return "Nextcloud";
      default:
        return provider;
    }
  }

  onMount(() => {
    // Cards render the CSS face until the manifest arrives (or on
    // fetch failure), then swap to persona sprites.
    fetchPersonaManifest().then((next) => (manifest = next));

    // Ask once so wait-state hand-offs can raise a desktop notification (#7).
    requestNotificationPermission();

    void (async () => {
      // Auth (ADR-0011/0013). A `?token=` in the URL is the first load (dev
      // Vite, or a direct link): set the httpOnly cookie so reloads can mint
      // a ticket, authenticate this load with the token, then scrub the URL.
      const params = new URLSearchParams(location.search);
      const urlToken = params.get("token");

      // A failed OAuth callback (ADR-0042 API contract) redirects here with
      // `?auth_error=`; show it on the login form and scrub the URL the same
      // way as `?token=` below.
      const authErrorCode = params.get("auth_error");
      if (authErrorCode !== null) {
        loginError = authErrorMessage(authErrorCode);
        const scrubbed = new URL(location.href);
        scrubbed.searchParams.delete("auth_error");
        history.replaceState(null, "", scrubbed);
      }

      // Fetched in parallel with the token/cookie flow below so authMethods
      // is already settled by the time authChecked reveals the login form
      // (no flash of the wrong form).
      const authMethodsPromise = fetchAuthMethods().then((next) => {
        if (next !== null) authMethods = next;
      });

      if (urlToken !== null) {
        // Token in the POST body, not the query string, so it does not land
        // in proxy/server access logs (the request-line URL is logged even
        // though Phoenix filters the token param).
        void fetch("/session/new", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: urlToken }),
        }).then(
          (r) => {
            if (!r.ok) {
              console.warn("kaoiro: session cookie set failed", r.status);
            }
          },
          () => console.warn("kaoiro: session cookie request failed"),
        );
        const scrubbed = new URL(location.href);
        scrubbed.searchParams.delete("token");
        history.replaceState(null, "", scrubbed);
        if (!destroyed) startSession({ token: urlToken }, false);
      } else {
        // Reload path: the token lives only in the httpOnly cookie, which
        // cannot ride the WS upgrade (Vite proxy / cross-origin) — mint a
        // ticket from it. With no usable cookie, connectFromCookie shows the
        // login form rather than failing closed silently (案A). The token
        // itself never reaches JS on this path.
        await connectFromCookie();
      }
      await authMethodsPromise;
      // The auth check is done; reveal the form or dashboard instead of the
      // neutral loading state.
      if (!destroyed) authChecked = true;
    })();

    // #25: refresh the timeline clock on a fixed cadence. Kept short
    // enough (30 s) that "たった今" gives way to concrete minutes but
    // not so short that it fires every animation frame; the tick is
    // idempotent (just Date.now()) so a missed tick during background
    // throttling costs nothing.
    nowTimer = setInterval(() => {
      now = Date.now();
    }, RELATIVE_TIME_TICK_MS);

    return () => {
      if (nowTimer !== undefined) clearInterval(nowTimer);
      nowTimer = undefined;
      destroyed = true;
      endSession();
    };
  });
</script>

{#if needLogin}
  <main class="login">
    <form class="login-card" onsubmit={login}>
      <h1>kaoiro</h1>
      {#if authMethods.token}
        <p class="login-note">アクセストークンを入力してください。</p>
      {:else if authMethods.oauth.length > 0}
        <p class="login-note">ログイン方法を選択してください。</p>
      {:else}
        <p class="login-note">
          認証手段が構成されていません。管理者に問い合わせてください。
        </p>
      {/if}
      {#if loginError}
        <p class="login-error" role="alert">{loginError}</p>
      {/if}
      {#if authMethods.token}
        <input
          type="password"
          bind:value={loginToken}
          placeholder="トークン"
          autocomplete="off"
          aria-label="アクセストークン"
        />
        <button
          type="submit"
          disabled={loginBusy || loginToken.trim() === ""}
        >
          {loginBusy ? "確認中…" : "ログイン"}
        </button>
      {/if}
      {#if authMethods.token && authMethods.oauth.length > 0}
        <p class="login-divider">または</p>
      {/if}
      {#if authMethods.oauth.length > 0}
        <div class="login-oauth">
          {#each authMethods.oauth as provider (provider)}
            <a class="login-oauth-button" href={`/auth/${provider}`}>
              {oauthProviderLabel(provider)} でログイン
            </a>
          {/each}
        </div>
      {/if}
    </form>
  </main>
{:else if authChecked}
<header>
  <h1>kaoiro</h1>
  {#if selectedEnvelope && sorted.length > 1}
    <nav class="agent-strip" aria-label="エージェント一覧">
      {#each sorted as envelope (envelope.agent_id)}
        {@const expr = expressionFor(envelope.state)}
        {@const sprite = spriteUrlFor(
          manifest,
          envelope.persona?.sprite_set,
          envelope.state,
        )}
        <button
          type="button"
          class="chip"
          class:current={envelope.agent_id === selected}
          data-state={expr.variant}
          aria-current={envelope.agent_id === selected ? "true" : undefined}
          title="{envelope.persona?.name ?? envelope.agent_id} — {expr.label}"
          onclick={() => {
            origin = null;
            timelineScrollTarget = null;
            selected = envelope.agent_id;
          }}
        >
          {#if sprite}
            <img class="thumb" src={sprite} alt="" />
          {:else}
            <div class="face" aria-hidden="true">
              <span class="eye left"></span>
              <span class="eye right"></span>
              <span class="mouth"></span>
            </div>
          {/if}
          <span class="lamp"></span>
        </button>
      {/each}
    </nav>
  {/if}
  <div class="session">
    <button
      type="button"
      class="settings-toggle"
      onclick={() => (showSettings = true)}
      aria-label="設定"
      title="設定"
    >
      ⚙
    </button>
    {#if isOperator && connection}
      <button type="button" class="launch" onclick={() => (showLaunch = true)}>
        + 起動
      </button>
    {/if}
    <p class="conn" data-status={status}>
      <span class="conn-dot"></span><span class="conn-label">{status}</span>
    </p>
    <button type="button" class="logout" onclick={logout}>ログアウト</button>
  </div>
</header>

{#if spawnNoticeText}
  <p class="spawn-notice" role="status">{spawnNoticeText}</p>
{/if}

{#if showLaunch && connection}
  <LaunchDialog
    {hosts}
    {connection}
    sessions={runnerSessions}
    onClose={() => (showLaunch = false)}
  />
{/if}

{#if showSettings}
  <SettingsDrawer onClose={() => (showSettings = false)} onLogout={logout} />
{/if}

<main>
  {#if selectedEnvelope}
    <div
      class="detail-navigation"
      class:with-switchers={previousAgentId !== null && nextAgentId !== null}
    >
      {#if previousAgentId}
        <button
          type="button"
          class="agent-switch previous"
          aria-label="前のエージェント {agentDisplayName(previousAgentId)} へ"
          title="前: {agentDisplayName(previousAgentId)}"
          onclick={() => selectAdjacentAgent(previousAgentId)}
        >◀</button>
      {/if}
      <div class="detail-stage">
        <AgentDetail
          envelope={selectedEnvelope}
          logs={logs[selectedEnvelope.agent_id] ?? []}
          {agents}
          {connection}
          {manifest}
          sessions={runnerSessions}
          resetMode={sessionResets[selectedEnvelope.agent_id] ?? null}
          {origin}
          scrollToEntryKey={timelineScrollTarget?.entryKey ?? null}
          onClose={() => {
            timelineScrollTarget = null;
            selected = null;
          }}
          onSelectAgent={(id) => {
            // Inter-agent bubble の peer ボタンから呼ばれる。 origin はタイルの
            // 中心ではなく detail 内クリック由来なので null に倒し、 既存の
            // expand-from-origin アニメは省略 (相手が既知 agent ならグリッドで
            // 再選択した時と同じ素直な切替えが得られる)。
            if (agents[id]) {
              origin = null;
              timelineScrollTarget = null;
              selected = id;
            }
          }}
        />
      </div>
      {#if nextAgentId}
        <button
          type="button"
          class="agent-switch next"
          aria-label="次のエージェント {agentDisplayName(nextAgentId)} へ"
          title="次: {agentDisplayName(nextAgentId)}"
          onclick={() => selectAdjacentAgent(nextAgentId)}
        >▶</button>
      {/if}
    </div>
  {:else if sorted.length === 0 && offlineEntries.length === 0}
    <p class="empty">
      no agents yet — start a wrapper with <code>server_url</code> set.
    </p>
  {:else}
    <!-- When offline entries exist, this vertical shell assigns all remaining
         viewport height to the live grid/timeline. This keeps the offline
         summary visible at the bottom instead of letting the timeline's
         independent scroll area push it below the page fold. -->
    <div
      class="dashboard"
      class:with-offline={isOperator && offlineEntries.length > 0}
    >
      <div class="live-dashboard">
        <!-- Grid + response-timeline side-by-side (operator only).
             Layout gate + shell lives in AgentGridShell: one production
             component wraps the `.grid-with-timeline` + `.agents` +
             optional ResponseTimeline, so the integration test can
             mount the same component instead of a hand-built div
             stand-in. Viewport-width threshold removed 2026-07-24 —
             the pane now shows at all widths. -->
        <AgentGridShell
          operator={isOperator}
          fitViewport={isOperator && offlineEntries.length > 0}
          {agents}
          {directory}
          {logs}
          {manifest}
          {now}
          {readTimelineEntryKeys}
          {newTimelineEntryKeys}
          onMarkRead={markTimelineEntryRead}
          onArrivalAnimationComplete={consumeTimelineArrival}
          onSelectAgent={(entry) => {
            // 詳細を開く。timeline クリックには「元タイル座標」がないので
            // origin=null に倒し、既存の expand-from-origin アニメは省略。
            // 同じ行を再度クリックしても scroll request を発火できるよう、
            // target object は request ごとに新しい参照へする。 server
            // synthetic IA は `detailAgentId` (= recipient) へ、directory
            // only IA は directory fallback の read-only pane へ進める。
            if (
              agents[entry.detailAgentId] === undefined &&
              directory[entry.detailAgentId] === undefined
            ) return;
            origin = null;
            timelineScrollTarget = {
              entryKey: conversationEntryKey(entry.envelope),
            };
            selected = entry.detailAgentId;
          }}
        >
          {#each sorted as envelope, index (envelope.agent_id)}
            <li style:--stagger="{index * 60}ms">
              <AgentCard
                {envelope}
                {manifest}
                spawnError={spawnErrors[envelope.agent_id] ?? null}
                onSelect={(o) => {
                  origin = o ?? null;
                  timelineScrollTarget = null;
                  selected = envelope.agent_id;
                }}
                onInterrupt={connection
                  ? () => connection!.sendInterrupt(envelope.agent_id)
                  : undefined}
                onStop={connection
                  ? () =>
                      connection!
                        .stop(envelope.agent_id)
                        .catch((e) => notifyActionError("終了", e))
                  : undefined}
                onRestore={connection
                  ? () =>
                      connection!
                        .restore(envelope.agent_id)
                        .catch((e) => notifyActionError("復帰", e))
                  : undefined}
                onDelete={connection
                  ? () => connection!.deleteAgent(envelope.agent_id)
                  : undefined}
              />
            </li>
          {/each}
        </AgentGridShell>
      </div>
      {#if selectedEnvelope === null && isOperator && offlineEntries.length > 0}
        <!-- Offline agents (ADR-0030): directory-only (server restarted) OR live
             disconnected (wrapper died but server survived — hot reload etc.).
             Collapsed by default so the live section stays uncluttered; expand +
             "前回の状態を復元" surfaces the restore affordance. Live-disconnected
             tiles keep click-to-detail so the operator can still browse the
             transcript history; directory-only tiles have no live envelope to
             detail against, so they stay non-interactive (offline label + no click). -->
        <details class="offline">
          <summary>
            オフライン({offlineEntries.length})
            {#if connection}
              <button
                type="button"
                class="restore-all"
                onclick={(e) => {
                  e.preventDefault();
                  void restoreAllOffline();
                }}
                title="オフライン全体を一括復元"
              >
                前回の状態を復元
              </button>
              <button
                type="button"
                class="delete-all"
                disabled={deletingAllOffline}
                onclick={(e) => {
                  e.preventDefault();
                  void deleteAllOffline();
                }}
                title="オフライン全体を台帳ごと削除"
              >
                {deletingAllOffline ? "削除中…" : "すべて削除"}
              </button>
            {/if}
          </summary>
          <ul class="agents">
            {#each offlineEntries as tile, index (tile.id)}
              <li style:--stagger="{index * 60}ms">
                <AgentCard
                  envelope={tile.envelope}
                  {manifest}
                  directoryOnly={tile.directoryOnly}
                  spawnError={spawnErrors[tile.id] ?? null}
                  onSelect={tile.directoryOnly
                    ? undefined
                    : (o) => {
                        origin = o ?? null;
                        timelineScrollTarget = null;
                        selected = tile.id;
                      }}
                  onRestore={connection
                    ? () =>
                        connection!
                          .restore(tile.id)
                          .catch((e) => notifyActionError("復帰", e))
                    : undefined}
                  onDelete={connection
                    ? () => connection!.deleteAgent(tile.id)
                    : undefined}
                />
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    </div>
  {/if}
</main>
{:else}
  <main class="login">
    <p class="login-note">接続中…</p>
  </main>
{/if}

<style>
  header {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    /* Safe-area insets are a FLOOR on the existing edge padding, never an
       addition (responsive-layout.md セーフエリア). */
    padding: max(1.6rem, env(safe-area-inset-top))
      max(2rem, env(safe-area-inset-right)) 0.4rem
      max(2rem, env(safe-area-inset-left));
    border-bottom: 1px solid var(--line);
  }

  /* Smartphone header (responsive-reachability.md app chrome): the title
     drops its "— 顔色" suffix, the connection badge shrinks to its dot,
     logout moves into SettingsDrawer, and the agent strip scrolls
     horizontally instead of wrapping the header taller. */
  @media (max-width: 939px) {
    header {
      align-items: center;
      gap: 0.6rem;
      padding-inline: max(0.8rem, env(safe-area-inset-left));
      padding-inline-end: max(0.8rem, env(safe-area-inset-right));
    }

    h1::after {
      content: none;
    }

    .conn .conn-label {
      display: none;
    }

    .conn .conn-dot {
      margin-right: 0;
    }

    header .logout {
      display: none;
    }

    .agent-strip {
      flex-wrap: nowrap;
      justify-content: flex-start;
      overflow-x: auto;
      min-width: 0;
    }
  }

  /* short (max-height 500px): 縦圧縮 override — header の縦 padding のみ。
     横方向のレイアウトは幅トークンが決めるので触らない (ADR-0052 F8). */
  @media (max-height: 500px) {
    header {
      padding-top: max(0.5rem, env(safe-area-inset-top));
      padding-bottom: 0.25rem;
    }
  }

  h1 {
    margin: 0;
    font-size: var(--fs-h1);
    letter-spacing: 0.35em;
    text-transform: lowercase;
    color: var(--fg);
  }

  h1::after {
    content: "— 顔色";
    margin-left: 0.6em;
    letter-spacing: 0;
    color: var(--fg-dim);
    font-size: 0.8em; /* em-relative to parent h1; do not tokenize */
  }

  .conn {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .conn-dot {
    display: inline-block;
    width: 0.55em;
    height: 0.55em;
    margin-right: 0.5em;
    border-radius: 50%;
    background: var(--fg-dim);
  }

  .conn[data-status="connected"] .conn-dot {
    background: var(--c-waiting_input);
    box-shadow: 0 0 6px var(--c-waiting_input);
  }

  .conn[data-status="disconnected"] .conn-dot {
    background: var(--c-error);
  }

  /* Detail view only: a compact strip of every agent's state lamp, sitting
     between the title and the connection badge, for quick switching (#16).
     space-between in the header drops it to centre when present. */
  .agent-strip {
    align-self: center;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  /* Each agent now reads as a miniature grid tile: the persona sprite shrunk
     into a small cell with its state lamp overlaid on the top-right corner. */
  .chip {
    --tone: var(--c-idle);
    position: relative;
    display: inline-flex;
    width: 2.4rem;
    height: 2.4rem;
    padding: 0.15rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
    background: var(--bg-card);
    line-height: 0;
    cursor: pointer;
    transition: border-color 0.2s;
  }

  .chip:hover {
    border-color: var(--line);
  }

  .chip.current {
    border-color: var(--tone);
  }

  /* Shrunk persona sprite filling the cell; disconnected greys out like the
     grid cards (personas.md). */
  .chip .thumb {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .chip[data-state="disconnected"] .thumb {
    filter: grayscale(1);
    opacity: 0.45;
  }

  /* Fallback when the manifest has no sprite (#35 default ペルソナ等):
     state-coloured disc with simplified eyes/mouth so it reads as a face,
     not a bare dot next to sprite-bearing neighbours. State is already on
     the .lamp corner dot, so per-state eye/mouth expressions are skipped
     here -- the chip is 2.4rem and per-state nuance would not be legible. */
  .chip .face {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 1px solid var(--tone);
  }

  .chip .face .eye {
    position: absolute;
    top: 38%;
    width: 12%;
    height: 12%;
    border-radius: 50%;
    background: var(--fg);
  }

  .chip .face .eye.left { left: 28%; }
  .chip .face .eye.right { right: 28%; }

  .chip .face .mouth {
    position: absolute;
    bottom: 26%;
    left: 50%;
    translate: -50% 0;
    width: 30%;
    height: 12%;
    border-bottom: 1.5px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  .chip .lamp {
    position: absolute;
    top: 0.1rem;
    right: 0.1rem;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 6px var(--tone);
  }

  .chip[data-state="sending"] { --tone: var(--c-sending); }
  .chip[data-state="thinking"] { --tone: var(--c-thinking); }
  .chip[data-state="tool_running"] { --tone: var(--c-tool_running); }
  .chip[data-state="waiting_permission"] {
    --tone: var(--c-waiting_permission);
  }
  .chip[data-state="waiting_input"] { --tone: var(--c-waiting_input); }
  .chip[data-state="done"] { --tone: var(--c-done); }
  .chip[data-state="error"] { --tone: var(--c-error); }
  .chip[data-state="disconnected"] { --tone: var(--c-disconnected); }

  /* Fills the viewport below the header; the active view (grid or detail)
     scrolls inside here so the detail composer can pin to the bottom (#33). */
  main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* Inline padding = the 64px 本体 padding the breakpoint derivation in
       responsive-layout.md assumes; env() is a floor, not an addition. The
       3rem bottom band doubles as clearance for the fixed sheet handle. */
    padding: 1.6rem max(2rem, env(safe-area-inset-right)) 3rem
      max(2rem, env(safe-area-inset-left));
  }

  /* short: main の縦 padding 縮退 (phase-31 31-8 の第一調整候補)。bottom は
     sheet handle (高さ約 2rem + safe-area) の逃げ幅を残す。 */
  @media (max-height: 500px) {
    main {
      padding-top: 0.5rem;
      padding-bottom: 2.6rem;
    }
  }

  /* Full-height previous / next controls for detail browsing (#80). The
     middle stage preserves AgentDetail's own max-width and scroll layout;
     the side columns consume only a slim strip at the main viewport edges. */
  .detail-navigation {
    height: 100%;
    min-height: 0;
  }

  .detail-navigation.with-switchers {
    display: grid;
    grid-template-columns:
      clamp(2.25rem, 4vw, 3.5rem)
      minmax(0, 1fr)
      clamp(2.25rem, 4vw, 3.5rem);
    gap: clamp(0.4rem, 1vw, 1rem);
  }

  .detail-stage {
    min-width: 0;
    min-height: 0;
    height: 100%;
  }

  .agent-switch {
    align-self: stretch;
    min-height: 6rem;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    color: var(--fg-dim);
    background: color-mix(in srgb, var(--bg-card) 72%, transparent);
    font: inherit;
    font-size: 1rem;
    cursor: pointer;
    transition:
      color 0.15s,
      border-color 0.15s,
      background 0.15s;
  }

  .agent-switch:hover,
  .agent-switch:focus-visible {
    color: var(--fg);
    border-color: var(--c-thinking);
    background: color-mix(in srgb, var(--c-thinking) 10%, var(--bg-card));
    outline: none;
  }

  /* Smartphone band (was an ad-hoc 640px query; aligned to the ADR-0052
     breakpoint tokens). */
  @media (max-width: 939px) {
    .detail-navigation.with-switchers {
      grid-template-columns: 1.75rem minmax(0, 1fr) 1.75rem;
      gap: 0.25rem;
    }

    .agent-switch {
      border-radius: 0.35rem;
      font-size: var(--fs-body-sm);
    }
  }

  .empty {
    margin-top: 3rem;
    text-align: center;
    color: var(--fg-dim);
    font-size: var(--fs-body);
  }

  /* #25 grid + timeline layout: moved to AgentGridShell.svelte
     (ふじ A1 must-fix 2026-07-23, 3rd review). Only styles that
     apply outside the shell (offline section, etc.) remain here. */

  /* In the offline state, this is the viewport-bounded dashboard body.
     `live-dashboard` may shrink, while the offline section keeps its summary
     at the bottom edge. The individual live panes opt into their own scroll
     in AgentGridShell. */
  .dashboard.with-offline {
    block-size: 100%;
    min-block-size: 0;
    display: flex;
    flex-direction: column;
  }

  .dashboard.with-offline .live-dashboard {
    flex: 1 1 0;
    min-block-size: 0;
    overflow: hidden;
  }

  /* Offline section (ADR-0030): collapsed by default; the restore button
     sits in the summary so it never crowds the header. */
  .offline {
    margin-top: 2rem;
    border-top: 1px solid var(--line);
    padding-top: 1rem;
  }

  /* A large expanded offline list stays useful without displacing the live
     dashboard: it takes at most half the available height and scrolls its
     own card grid. The collapsed summary remains at the viewport bottom. */
  .dashboard.with-offline .offline {
    flex: 0 0 auto;
    max-block-size: 50%;
  }

  .dashboard.with-offline .offline[open] {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .offline > summary {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    cursor: pointer;
    padding: 0.2rem 0;
    user-select: none;
  }

  .offline > summary::-webkit-details-marker {
    color: var(--fg-dim);
  }

  /* A1 refactor (2026-07-23) moved the live-grid `.agents { display:
     grid; ... }` rule to AgentGridShell.svelte's component-scoped
     styles. The offline section still uses its own `<ul class="agents">`
     under this file's scope and needs the same grid layout, otherwise
     each `<li>` collapses to a full-width block (実機検収 1,
     2026-07-23 マスター指示). Keep the auto-fill grid identical to
     AgentGridShell so the offline card size matches the live grid. */
  .offline .agents {
    margin-top: 1rem;
    list-style: none;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 1.2rem;
    /* Kept identical to AgentGridShell's `.agents` (see its comment,
       issue #193): directory-only tiles never show the stats block, but
       stay consistent so the two grids never silently drift apart. */
    align-items: start;
  }

  .dashboard.with-offline .offline[open] .agents {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-y: auto;
  }

  .offline .agents > li {
    animation: rise 0.45s ease-out backwards;
    animation-delay: var(--stagger, 0ms);
  }

  .restore-all {
    font-size: var(--fs-body-sm);
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .restore-all:hover {
    border-color: var(--fg-dim);
  }

  .delete-all {
    font-size: var(--fs-body-sm);
    color: var(--c-error);
    background: var(--bg-card);
    border: 1px solid color-mix(in srgb, var(--c-error) 55%, var(--line));
    border-radius: 0.4rem;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .delete-all:hover:not(:disabled) {
    border-color: var(--c-error);
  }

  .delete-all:disabled {
    opacity: 0.55;
    cursor: default;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(0.6rem);
    }
  }

  /* Connection badge + logout grouped at the header's right edge so
     space-between keeps the title left and this cluster right. */
  .session {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .logout {
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .logout:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .launch {
    font-size: var(--fs-body-sm);
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.25rem 0.7rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .launch:hover {
    border-color: var(--fg-dim);
  }

  .settings-toggle {
    font-size: var(--fs-body);
    line-height: 1;
    color: var(--fg-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    transition:
      color 0.2s,
      border-color 0.2s;
  }

  .settings-toggle:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .spawn-notice {
    flex: 0 0 auto;
    margin: 0;
    padding: 0.4rem max(2rem, env(safe-area-inset-right)) 0.4rem
      max(2rem, env(safe-area-inset-left));
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
    background: var(--bg-card);
    border-bottom: 1px solid var(--line);
  }

  /* Token-entry login (案A): a centred card filling the main area when there
     is no live session. */
  .login {
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }

  .login-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: min(22rem, 90vw);
    margin-top: 8vh;
    padding: 2rem;
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    background: var(--bg-card);
  }

  .login-card h1 {
    margin: 0;
    font-size: var(--fs-h1);
    letter-spacing: 0.35em;
    text-transform: lowercase;
    text-align: center;
    color: var(--fg);
  }

  .login-note {
    margin: 0;
    font-size: var(--fs-body-sm);
    text-align: center;
    color: var(--fg-dim);
  }

  .login-card input {
    padding: 0.6rem 0.7rem;
    font-size: var(--fs-input);
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
  }

  .login-error {
    margin: 0;
    font-size: var(--fs-body-sm);
    color: var(--c-error);
  }

  .login-card button {
    padding: 0.55rem;
    font-size: var(--fs-body);
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }

  .login-card button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .login-divider {
    margin: 0;
    font-size: var(--fs-body-sm);
    text-align: center;
    color: var(--fg-dim);
  }

  .login-oauth {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .login-oauth-button {
    padding: 0.55rem;
    font-size: var(--fs-body);
    text-align: center;
    text-decoration: none;
    color: var(--fg);
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    cursor: pointer;
  }
</style>
