// Codex wrapper CLI — the composition root of the codex engine: loads the
// config, connects the ServerLink, waits fail-closed for the server-pushed
// personality (ADR-0029 F3), then drives a CodexHost. Mirrors the Claude
// composition (@kaoiro/claude-code/src/cli.ts) minus the Claude-only parts:
// no permission broker wiring (approval is launch-fixed, ADR-0033 F3), no
// image-only upload rendering, rollout history replay.
//
// Usage: node dist/cli.js [configPath] [prompt] [--resume <session_id>]

import { randomUUID } from "node:crypto";
import {
  HistoryReplayer,
  IaSidecar,
  InterAgentTool,
  QuestionBroker,
  askUserQuestionDescriptor,
  canAddToCoalescedBatch,
  classifyInterAgentError,
  formatInboundMessage,
  formatInboundMessages,
  isIngressStamp,
  makeLog,
  makeStateChange,
  mergePendingDisplayNameSync,
} from "@kaoiro/agent-common";
import type {
  Envelope,
  InboundReplyMode,
  InterAgentMessagePayload,
  KaoiroState,
  ModelSource,
} from "@kaoiro/agent-common";
import { ServerLink, loadConfig, parseCliArgs } from "@kaoiro/wrapper-core";
import { CodexHost } from "./host.js";
import { readCodexHistory } from "./history.js";
import { codexSidecarPath } from "./rollout.js";
import { effectiveNetworkAccess } from "./network_access.js";
import {
  applyEnvDefaultModel,
  resolveCodexSources,
} from "./source_resolution.js";

const COLOR: Record<KaoiroState, string> = {
  idle: "90",
  sending: "93",
  thinking: "36",
  tool_running: "33",
  waiting_permission: "35",
  waiting_question: "95",
  waiting_input: "32",
  done: "92",
  error: "31",
};

/** Upper bound on the wait for the server's `persona_prompt` push after
 *  join (ADR-0029 F3, fail-closed). Matches the Claude CLI. */
const PERSONA_PROMPT_TIMEOUT_MS = 10_000;

// issue #219 D25: human-facing log lines show `display_name` (the
// mutable, operator-chosen label), never the pack's canonical
// `persona.name` — see claude-code cli.ts's identical rationale.
function printState(envelope: Envelope): void {
  const color = COLOR[envelope.state];
  const time = envelope.ts.slice(11, 19);
  process.stdout.write(
    `\x1b[${color}m[${time}] ${envelope.display_name}: ${envelope.state}\x1b[0m\n`,
  );
}

function printLog(envelope: Envelope): void {
  const time = envelope.ts.slice(11, 19);
  const name = envelope.display_name;
  const payload = envelope.payload;
  if (envelope.type === "result") {
    const text = typeof payload.text === "string" ? payload.text : "(no text)";
    process.stdout.write(`\x1b[37m[${time}] ${name} -> ${text}\x1b[0m\n`);
  } else if (payload.kind === "assistant" && typeof payload.text === "string") {
    process.stdout.write(`\x1b[37m[${time}] ${name}: ${payload.text}\x1b[0m\n`);
  }
}

async function main(): Promise<void> {
  const { configPath, prompt, resume: resumeSessionId } = parseCliArgs(
    process.argv.slice(2),
  );
  const config = loadConfig(configPath);

  // Codex CLI env source (ADR-0032 F4bc addendum, phase-15 15-3):
  // KAOIRO_CODEX_DEFAULT_MODEL is the env-tier default, applied when
  // config.model is unset. Legacy KAOIRO_WRAPPER_DEFAULT_MODEL is
  // deliberately NOT read here — it may hold a claude-* value that would
  // fail with 400/404 under Codex ChatGPT auth (codex-model-catalog.md).
  // Resolution: launch (config.model, SpawnMessage relay) > env > engine
  // account default. Model source stamping to ext.model_source lands in
  // 15-4c.
  const envDefaultModel = process.env.KAOIRO_CODEX_DEFAULT_MODEL;

  // Source vocabulary for ext.model_source / ext.effort_source (ADR-0032
  // F4bc addendum, phase-15 15-4c + phase-23 P1 pair-aware apply).
  // Priority + semantics are pinned in `resolveCodexSources` unit tests
  // (source_resolution.test.ts); CLI just consumes the resolved pair.
  // MUST run before the env-default mutation below — it reads
  // `config.model` to decide "config" vs "env" attribution, and that
  // distinction only exists before the mutation fills the field in.
  const { modelSource: resolvedModelSource, effortSource: resolvedEffortSource } =
    resolveCodexSources(config, envDefaultModel);

  // issue #197 段階3 (ふじ MF-1 レビュー指摘): mutates `config.model` in
  // place rather than cloning into a separate `effectiveConfig` — see
  // `applyEnvDefaultModel`'s own doc for why the split object was a bug
  // (two independently-diverging persona sources of truth after a
  // rename). Every producer below now reads the same, single, mutated
  // `config` object.
  applyEnvDefaultModel(config, envDefaultModel);

  // Engine-mismatch config warns (phase-15 15-6). Claude-only fields
  // (permission_mode, allowed_tools) surface loudly instead of being
  // silently ignored when written into a Codex config (D3 rationale).
  if (config.permission_mode !== undefined) {
    process.stderr.write(
      "config warn: permission_mode is claude-code-only, ignored on codex\n",
    );
  }
  if (config.allowed_tools !== undefined) {
    process.stderr.write(
      "config warn: allowed_tools is claude-code-only, ignored on codex\n",
    );
  }

  // Startup resolved-config summary (phase-15 15-5): one stderr line with
  // the engine-relevant fields and their source tags. approval is
  // host-fixed to "never" on Codex (ADR-0033 F3); effort is included only
  // when explicitly resolved. ignored-flags mark claude-only fields when
  // they were nonetheless supplied.
  {
    const resolvedModel = config.model ?? "<account default>";
    const resolvedModelTag =
      resolvedModelSource !== undefined
        ? `(source=${resolvedModelSource})`
        : "(source=account)";
    const effortPart =
      config.effort !== undefined
        ? ` effort=${config.effort}(source=${resolvedEffortSource ?? "default"})`
        : "";
    const sandbox = config.sandbox ?? "workspace-write";
    const sandboxSource: string =
      config.sandbox !== undefined ? "config" : "default";
    // Sandbox-aware normalization (phase-22 藤 audit, ADR-0033 F3 追補):
    // the raw toggle is meaningful only for workspace-write; danger-full-
    // access always carries network, read-only never does. Same helper as
    // CodexHost's effective-status snapshot (SSoT) so this log line never
    // diverges from ext.effective / whoami.
    const networkAccess = effectiveNetworkAccess(
      sandbox,
      config.network_access ?? false,
    );
    const permissionModePart =
      config.permission_mode !== undefined
        ? ` permission_mode=${config.permission_mode}(ignored)`
        : "";
    const allowedToolsPart =
      config.allowed_tools !== undefined
        ? ` allowed_tools=${config.allowed_tools.length}(ignored)`
        : "";
    process.stderr.write(
      `[wrapper resolved] engine=codex ` +
        `model=${resolvedModel}${resolvedModelTag}${effortPart} ` +
        `sandbox=${sandbox}(source=${sandboxSource}) ` +
        `network_access=${networkAccess} ` +
        `approval=never(host-fixed)` +
        `${permissionModePart}${allowedToolsPart} ` +
        `persona=${config.persona.id}\n`,
    );
  }

  let host: CodexHost;
  let link: ServerLink | null = null;
  let questionBroker: QuestionBroker | null = null;
  let interAgent: InterAgentTool | null = null;
  let instructionChain: Promise<void> = Promise.resolve();
  // The after_join display_name sync push
  // (WrapperChannel.after_join_handshake, issue #197 段階3, renamed
  // issue #219 D19/D23) can arrive before `host` is constructed below —
  // `personaPromptPromise` is awaited first (same ordering claude-code's
  // cli.ts documents for its own pendingPermissionMode buffer). Buffer it
  // and apply once `host` exists, rather than risk touching an
  // undefined `host` from the handler.
  let pendingDisplayNameSync: { displayName: string; revision: number } | undefined;

  /** One coalesced batch of pending inbound envelopes from the SAME peer
   *  (issue #221 段階3, direction 2 — coalescing unit is same-peer, クロエ
   *  裁定 2026-08-11). `bytes` tracks the SUM of each item's own
   *  `formatInboundMessage()` size, checked against
   *  `canAddToCoalescedBatch()` so a batch never exceeds the shared
   *  count/size caps. Mirrors `@kaoiro/claude-code/src/cli.ts`'s identical
   *  structure. */
  interface PendingBatch {
    items: { envelope: Envelope; mode: InboundReplyMode }[];
    bytes: number;
  }
  /** peer agent_id -> FIFO of batches queued to send for that peer, oldest
   *  first (issue #221 段階3). The LAST entry is the one still open for new
   *  items to append to (subject to `canAddToCoalescedBatch()`); any
   *  earlier entry is already closed and just waiting its turn. Normally
   *  length 0 or 1 — a second entry only appears when the cap closes the
   *  open batch again while the peer is STILL busy (see `inFlightPeers`
   *  below). Absent key = nothing queued for that peer. */
  const pendingBatches = new Map<string, PendingBatch[]>();
  /** peer agent_id -> present while a turn for that peer is currently in
   *  flight (sent via host.send(), `onTurnEnd` not yet observed for it) —
   *  issue #221 段階3, direction 2. This, NOT `instructionChain`'s own
   *  idle/busy state, is the real busy-trigger signal (クロエ裁定 3):
   *  `host.send()` itself resolves almost the instant its text is pushed
   *  onto codex's OWN internal `#queue` — long before the model actually
   *  finishes that turn — so gating on `instructionChain` alone would read
   *  "idle" again within a microtask of every send, even while codex spends
   *  the next several seconds thinking. That multi-second window is exactly
   *  where a busy peer's next few messages need to accumulate, so "busy"
   *  here means the turn itself hasn't completed, tracked via `onTurnEnd`
   *  below — not merely "the push completed". */
  const inFlightPeers = new Set<string>();
  /** conversation_id -> peer, for cids belonging to the CURRENTLY in-flight
   *  turn ONLY (issue #221 段階3). Populated when a batch is sent, drained
   *  by `onTurnEnd` below to learn which peer just freed up — every cid in
   *  one batch always maps to the same peer by construction (same-peer
   *  coalescing unit), so any single entry identifies it. */
  const inFlightCidPeer = new Map<string, string>();

  /** Sends the OLDEST queued batch for `peer`, if the peer is free
   *  (`!inFlightPeers.has(peer)`) and a batch is actually waiting (issue
   *  #221 段階3). No-ops otherwise. Called speculatively — both from a new
   *  arrival (the peer MIGHT already be free) and from `onTurnEnd` (a busy
   *  peer just became free) — so it must be safe to call whether or not
   *  either condition currently holds. */
  function trySendNextBatch(peer: string): void {
    if (inFlightPeers.has(peer)) return;
    const queue = pendingBatches.get(peer);
    const batch = queue?.shift();
    if (batch === undefined) return;
    if (queue!.length === 0) pendingBatches.delete(peer);
    inFlightPeers.add(peer);
    const cids = batch.items
      .map(
        (item) =>
          (item.envelope.payload as Partial<InterAgentMessagePayload>)
            .conversation_id,
      )
      .filter((cid): cid is string => typeof cid === "string");
    for (const cid of cids) inFlightCidPeer.set(cid, peer);
    // issue #221 段階3 MF-1 (ふじレビュー差し戻し): register each item's
    // pending injection HERE, at dispatch time — not at receipt time in
    // onInterAgentMessage. See the comment there for why receipt-time
    // registration was wrong. This ties every cid's map entry one-for-one
    // to the batch actually being sent below, matching the cids passed as
    // host.send()'s third parameter.
    for (const item of batch.items) {
      interAgent?.notePendingInjection(item.envelope);
    }
    const text = formatInboundMessages(batch.items);
    instructionChain = instructionChain.then(() =>
      host.send(text, undefined, cids).catch((err: unknown) => {
        process.stderr.write(`inter-agent inject failed: ${String(err)}\n`);
        // issue #136 / #221 段階3: host.send() rejecting here means this
        // batch never reached the queue, so no turn will ever run for it
        // and onTurnEnd never fires either — without this cleanup the peer
        // would stay marked in-flight forever and never send whatever
        // queued up behind it. Free it up the same way onTurnEnd's own
        // handler does below, resolve every one of this batch's cids so
        // each bundled peer gets a peer_error notice instead of silence
        // (クロエ裁定 — 全件波及), then try the peer's next queued batch.
        for (const cid of cids) inFlightCidPeer.delete(cid);
        inFlightPeers.delete(peer);
        const classified = classifyInterAgentError({ detail: String(err) });
        for (const notice of interAgent?.resolveTurnEnd(cids, classified) ?? []) {
          link?.send(notice);
        }
        trySendNextBatch(peer);
      }),
    );
  }

  const onState = (envelope: Envelope): void => {
    printState(envelope);
    link?.send(envelope);
  };
  const onLog = (envelope: Envelope): void => {
    printLog(envelope);
    link?.send(envelope);
  };
  // Tasklist snapshots, like child task envelopes, are dashboard-only relay
  // data rather than this agent's console transcript.
  const onTask = (envelope: Envelope): void => {
    link?.send(envelope);
  };

  let resolvePersonaPrompt!: (prompt: string) => void;
  let rejectPersonaPrompt!: (reason: Error) => void;
  const personaPromptPromise = new Promise<string>((resolve, reject) => {
    resolvePersonaPrompt = resolve;
    rejectPersonaPrompt = reject;
  });

  questionBroker = new QuestionBroker({
    config,
    send: (envelope) => link?.send(envelope),
    // Stamps ext.pending_question AND drives waiting_question on codex —
    // CodexHost derives the state from this signal (no canUseTool hook).
    onPendingChange: (pending) => host?.setPendingQuestion(pending),
  });
  interAgent = new InterAgentTool({
    config,
    getState: () => host.state,
    send: (envelope) => link?.send(envelope),
    // ADR-0051 D3-2: `send_to_agent`'s result is the server's acceptance
    // ack, not the local push. No link yet means no server took it.
    sendInterAgent: (envelope) =>
      link?.sendInterAgent(envelope) ??
      Promise.resolve({ kind: "unknown" as const, reason: "not_connected" }),
    requestDirectory: () =>
      link?.requestDirectory() ?? Promise.resolve({ agents: [], users: [] }),
    getWhoami: () => host.statusSnapshot(),
  });
  // ADR-0051 D3-2 / D3-5 — same contract as the Claude wrapper, with the
  // codex rollout directory as the sidecar's home. That directory is
  // date-nested and only resolvable once the rollout exists, which is
  // exactly what the pending journal covers.
  const sidecar = new IaSidecar({
    agentId: config.agent_id,
    generation: config.transition_id ?? randomUUID(),
    resolveSessionPath: (sessionId) => codexSidecarPath(sessionId),
  });

  const recordInboundIa = (envelope: Envelope): void => {
    const stamp = (envelope as { ingress_stamp?: unknown }).ingress_stamp;
    if (!isIngressStamp(stamp)) {
      process.stderr.write(
        "inter_agent_message without ingress_stamp; not recorded\n",
      );
      return;
    }
    sidecar.append({ ingress_stamp: stamp, envelope });
  };

  // Constructed before the link: the join reply can arrive before `host`
  // exists, so the verdict has to be held until markReady() (ADR-0051 D2).
  const replayer = new HistoryReplayer({
    seedState: () =>
      link?.send(
        makeStateChange(
          config,
          host?.state ?? "idle",
          new Date().toISOString(),
          {},
          host?.statusExtSnapshot() ?? {},
        ),
      ),
    sessionId: () => link?.currentSessionId() ?? null,
    readTranscript: (sessionId) => readCodexHistory(sessionId, config),
    readSidecar: () => sidecar.read(),
    sendHistoryReset: (replayId) => link?.sendHistoryReset(replayId),
    sendEnvelope: (envelope) => link?.send(envelope),
    sendReplayIa: (replayId, items) => link?.sendReplayIa(replayId, items),
    sendHistoryReplayComplete: (replayId) =>
      link?.sendHistoryReplayComplete(replayId),
    ...(resumeSessionId !== undefined
      ? { legacyResumeSessionId: resumeSessionId }
      : {}),
  });

  link = new ServerLink(config.server_url, config.agent_id, {
    personaId: config.persona.id,
    ...(config.transition_id === undefined
      ? {}
      : { transitionId: config.transition_id }),
    ...(config.server_token === undefined
      ? {}
      : { token: config.server_token }),
    onPersonaPrompt: (received) => resolvePersonaPrompt(received),
    onHydration: (verdict) => replayer.onVerdict(verdict),
    onInterAgentAck: (envelope, stamp) =>
      sidecar.append({ ingress_stamp: stamp, envelope }),
    onInstruction: (text, attachmentIds) => {
      const tag = attachmentIds && attachmentIds.length > 0
        ? `instruction(+${attachmentIds.length})`
        : "instruction";
      process.stdout.write(`  ${tag}: ${text}\n`);
      onLog(
        makeLog(config, host.state, new Date().toISOString(), {
          kind: "user",
          text,
        }),
      );
      instructionChain = instructionChain.then(() =>
        host.send(text, attachmentIds).catch((err: unknown) => {
          process.stderr.write(`send failed: ${String(err)}\n`);
        }),
      );
    },
    onQuestionResponse: (response) => questionBroker?.resolve(response),
    onInterrupt: () => {
      process.stdout.write("  interrupt\n");
      void host.interrupt().catch(() => {});
    },
    onSetModel: (value) => {
      process.stdout.write(`  set_model: ${value}\n`);
      void host.setModel(value).catch(() => {});
    },
    onSetEffort: (level) => {
      process.stdout.write(`  set_effort: ${level}\n`);
      void host.setEffort(level).catch(() => {});
    },
    onSetPermissionMode: (mode) => {
      // Claude-mode pushes (server after_join restores a persisted pick)
      // do not apply to codex: permission is launch-fixed (ADR-0033 F3).
      process.stdout.write(
        `  set_permission_mode: ignored (codex is launch-fixed): ${mode}\n`,
      );
    },
    onRenameDisplayName: (displayName, revision) => {
      // protocol.md (issue #197 段階3, renamed issue #219 D19/D23):
      // authoritative display_name from the server — fresh-join /
      // reconnect sync OR a live `rename_agent` relay, delivered via
      // EITHER `persona_sync` (legacy) or `display_name_sync` (new,
      // D22 dual-emit). Structural validation already happened in
      // transport.ts; the revision-freshness check happens inside
      // host.renameDisplayName itself (D15). Buffer if `host` is not
      // yet constructed (see pendingDisplayNameSync comment above).
      process.stdout.write(`  display_name_sync: ${displayName} (revision=${revision})\n`);
      if (host === undefined) {
        // D15 review follow-up: a plain overwrite here would let a
        // lower-revision push win the pre-host race against a
        // higher-revision one (see mergePendingDisplayNameSync's doc).
        pendingDisplayNameSync = mergePendingDisplayNameSync(
          pendingDisplayNameSync,
          displayName,
          revision,
        );
        return;
      }
      host.renameDisplayName(displayName, revision);
    },
    onAttachOpen: (msg) => {
      host.attachOpen(msg);
    },
    onAttachChunk: (payload) => host.attachChunk(payload),
    onAttachClose: (uploadId) => host.attachClose(uploadId),
    // issue #177 review round 2 (ふじ差し戻し): async — receiveInbound() may
    // gate briefly on a concurrently in-flight done=true send_to_agent for
    // the same conversation_id, so it must be awaited before this handler
    // acts on the disposition (host.send / notePendingInjection). The
    // caller (transport.ts) does not await onInterAgentMessage — an async
    // handler here is still fire-and-forget from its perspective, exactly
    // as the previous synchronous one was.
    onInterAgentMessage: async (envelope) => {
      // Recorded before anything consumes it (ADR-0051 D3-2 receive side).
      recordInboundIa(envelope);
      const disposition = (await interAgent?.receiveInbound(envelope)) ?? {
        consumed: false,
        inject: true,
        mode: "reply-owed" as const,
      };
      if (disposition.consumed) {
        process.stdout.write(`  inter_agent_message reply consumed: ${envelope.agent_id}\n`);
        return;
      }
      if (!disposition.inject) {
        // issue #221 direction 1: `inject: false` has two distinct causes
        // that must not share a log line (agent-common's `InboundDisposition`
        // doc) — `mode === "terminal"` means this DID happen and the track
        // above just learned `closed`, only that no reply is owed and no SDK
        // turn should be spent on it; anything else here is AC9's late /
        // stale / duplicate turn_number, which never happened at all
        // (track untouched).
        if (disposition.mode === "terminal") {
          process.stdout.write(
            `  inter_agent_message terminal, no reply owed: ${envelope.agent_id}\n`,
          );
        } else if (disposition.notice) {
          // issue #222 欠陥3: notify the ORIGINAL sender (and resync its
          // track — see InterAgentTool#receiveInbound's doc) instead of
          // dropping this silently. Same AC10-bypassing pattern as
          // resolveTurnEnd()'s notices below — this never goes through
          // invoke()/#dispatch() either.
          link?.send(disposition.notice);
          process.stdout.write(
            `  inter_agent_message stale/duplicate turn dropped, stale_turn notice sent: ${envelope.agent_id}\n`,
          );
        } else {
          // `receiveInbound()` decided this stale no-notice exemption and
          // supplied its display-ready reason. Keep that decision in
          // agent-common: a later exemption must either provide a reason
          // there or fail typecheck before this adapter can misreport it.
          process.stdout.write(
            `  inter_agent_message stale/duplicate turn dropped, no notice (${disposition.noticeSkipReason}): ${envelope.agent_id}\n`,
          );
        }
        return;
      }
      process.stdout.write(`  inter_agent_message: ${envelope.agent_id}\n`);
      // issue #131: this wrapper now owes a reply on the conversation.
      // notePendingInjection() is called from trySendNextBatch() below, NOT
      // here — issue #221 段階3 MF-1 (ふじレビュー差し戻し) moved the call
      // from receipt time to dispatch time. Registering it here (at
      // receipt) let a second same-cid message, queued into a LATER batch
      // while this peer was still busy, overwrite an EARLIER batch's
      // still-pending map entry before that earlier turn even completed —
      // resolveTurnEnd() then deleted the wrong (later) registration when
      // the earlier turn ended, silently no-op'ing the later turn's own
      // resolution on failure. issue #177 AC8's terminal-exclusion still
      // holds under the new call site: `batch.items` below never holds a
      // terminal-disposition envelope, since `inject: false` already
      // returned early above.
      // issue #221 段階3: append to (or start) this peer's open batch, then
      // try to send. A NEW batch is pushed onto the peer's queue both when
      // none is open yet, and when the existing open one is already at
      // either coalescing cap: `canAddToCoalescedBatch()` guards this so an
      // open batch never exceeds the shared count/size limits, and the
      // excess item starts the NEXT batch (its own eventual turn) rather
      // than being dropped (クロエ裁定 2 — 捨てない).
      // `trySendNextBatch()` itself decides whether this can go out now
      // (peer free) or must wait (peer already busy on an earlier turn) —
      // see that function's doc for why "busy" is `onTurnEnd`-driven, not
      // `instructionChain`-driven.
      const peer = envelope.agent_id;
      const itemText = formatInboundMessage(envelope, {
        mode: disposition.mode,
      });
      const itemBytes = Buffer.byteLength(itemText, "utf8");
      let queue = pendingBatches.get(peer);
      if (queue === undefined) {
        queue = [];
        pendingBatches.set(peer, queue);
      }
      let open = queue[queue.length - 1];
      if (
        open === undefined ||
        !canAddToCoalescedBatch(open.items.length, open.bytes, itemBytes)
      ) {
        open = { items: [], bytes: 0 };
        queue.push(open);
      }
      open.items.push({ envelope, mode: disposition.mode });
      open.bytes += itemBytes;
      trySendNextBatch(peer);
    },
  });

  const timeoutHandle = setTimeout(() => {
    rejectPersonaPrompt(
      new Error(
        `timed out waiting for persona_prompt from ${config.server_url} ` +
          `after ${PERSONA_PROMPT_TIMEOUT_MS}ms (ADR-0029 fail-closed)`,
      ),
    );
  }, PERSONA_PROMPT_TIMEOUT_MS);

  let appendSystemPrompt: string;
  try {
    appendSystemPrompt = await personaPromptPromise;
  } catch (err) {
    link?.close();
    questionBroker?.close();
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  host = new CodexHost(config, {
    onState,
    onLog,
    onTask,
    // issue #131: resolve exactly the conversation(s) this turn was tagged
    // with (must-fix 1 — turn-scoped, never a sweep of everything pending;
    // extended issue #221 段階3 for a coalesced turn's multiple cids). On
    // error, classify what codex reported (best-effort — no structured
    // reason, only a raw message when one is available) and push the
    // resulting notice envelope(s) straight through ServerLink — this
    // bypasses the model/tool path entirely since the turn just failed to
    // produce one, so no broker approval applies.
    onTurnEnd: ({ conversationIds, error }) => {
      const classified = error ? classifyInterAgentError(error) : undefined;
      for (const envelope of interAgent?.resolveTurnEnd(
        conversationIds,
        classified,
      ) ?? []) {
        link?.send(envelope);
      }
      // issue #221 段階3: this turn's conversationIds — if any — belong to
      // exactly one peer (same-peer coalescing unit), so any single entry
      // identifies which peer's turn just completed. Free it and try
      // sending whatever queued up for it while it was busy — the actual
      // busy-trigger signal (see `inFlightPeers`'s doc above `trySendNextBatch`).
      const freedPeer =
        conversationIds.length > 0
          ? inFlightCidPeer.get(conversationIds[0]!)
          : undefined;
      if (freedPeer !== undefined) {
        for (const cid of conversationIds) inFlightCidPeer.delete(cid);
        inFlightPeers.delete(freedPeer);
        trySendNextBatch(freedPeer);
      }
    },
    appendSystemPrompt,
    onInstructionRejected: (envelope) => link?.send(envelope),
    onAttachRejected: (envelope) => link?.send(envelope),
    onSessionId: (id) => {
      link?.setSessionId(id);
      sidecar.bind(id);
    },
    toolDescriptors: [
      ...interAgent.descriptors(),
      askUserQuestionDescriptor((questions) => questionBroker!.decide(questions)),
    ],
    ...(resolvedModelSource !== undefined
      ? { modelSource: resolvedModelSource }
      : {}),
    ...(resolvedEffortSource !== undefined
      ? { effortSource: resolvedEffortSource }
      : {}),
    // Resume snapshot relayed by the runner on a resume launch (ADR-0014
    // F1 追補, phase-15 D8). Undefined on a fresh spawn.
    ...(config.resume_snapshot !== undefined
      ? { resumeSnapshot: config.resume_snapshot }
      : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
  });

  // Apply the after_join display_name sync that arrived before host was
  // constructed (issue #197 段階3, renamed issue #219 D19/D23), same
  // reasoning as pendingDisplayNameSync above.
  if (pendingDisplayNameSync !== undefined) {
    host.renameDisplayName(
      pendingDisplayNameSync.displayName,
      pendingDisplayNameSync.revision,
    );
  }

  process.on("SIGINT", () => {
    void host
      .interrupt()
      .catch(() => {})
      .finally(() => host.close());
  });

  try {
    // Idle-wait start, matching the Claude CLI: announce idle so the agent
    // appears on the dashboard before its first turn.
    if (prompt === undefined) {
      const idle = makeStateChange(
        config, "idle", new Date().toISOString(), {},
        host.statusExtSnapshot(),
      );
      printState(idle);
      link?.send(idle);
    }
    // resumeThread continues only future turns; the display transcript is
    // rebuilt from the rollout by the replay below (#106).
    if (resumeSessionId !== undefined) {
      link.setSessionId(resumeSessionId);
      sidecar.bind(resumeSessionId);
    }
    // ADR-0051 D2: the server's join verdict decides whether a replay runs,
    // on startup and on every later reconnect. See the Claude CLI for the
    // rationale; the two wrappers share the coordinator.
    replayer.markReady();
    await host.run(prompt);
  } finally {
    questionBroker?.close();
    link?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
