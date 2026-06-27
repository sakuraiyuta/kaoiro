<script lang="ts">
  import { tick, untrack } from "svelte";
  import { expressionFor, spriteUrlFor } from "./expression";
  import { StatusQueue } from "./statusDisplay.svelte";
  import { renderMarkdown, renderMermaidIn } from "./markdown";
  import {
    logOf,
    modelsFrom,
    pendingPermissionFrom,
    resultOf,
    RUNNING_STATES,
    STOP_SAFE_STATES,
  } from "./protocol";
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
    origin = null,
    onClose,
  }: {
    envelope: Envelope;
    logs?: Envelope[];
    agents?: Record<string, Envelope>;
    connection?: KaoiroConnection | null;
    manifest?: PersonaManifest | null;
    /** Viewport centre of the originating tile, for the expand anim (#36). */
    origin?: { x: number; y: number } | null;
    onClose: () => void;
  } = $props();

  // Expand the detail from the tile that opened it (#36): scale up from the
  // tile's viewport centre. Honours prefers-reduced-motion by skipping motion.
  function expandFrom(
    node: HTMLElement,
    params: { origin: { x: number; y: number } | null },
  ) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (params.origin) {
      const rect = node.getBoundingClientRect();
      node.style.transformOrigin = `${params.origin.x - rect.left}px ${
        params.origin.y - rect.top
      }px`;
    }
    return {
      duration: reduce ? 0 : 240,
      css: (t: number) => `opacity: ${t}; transform: scale(${0.6 + 0.4 * t});`,
    };
  }

  // Displayed state lags the live state for min readability + crossfade (#43).
  const display = new StatusQueue(untrack(() => envelope.state));
  $effect(() => {
    display.push(envelope.state);
  });
  $effect(() => () => display.dispose());

  const expression = $derived(expressionFor(display.shown));
  const name = $derived(envelope.persona?.name ?? envelope.agent_id);
  const spriteUrl = $derived(
    spriteUrlFor(manifest, envelope.persona?.sprite_set, display.shown),
  );
  // Read from state_change.ext.pending_permission, the ADR-0022
  // authoritative source. Survives any other state_change arriving while
  // waiting_permission (issue #59 root cause was deriving this from the
  // permission_request envelope alone, which got overwritten).
  const permission = $derived(pendingPermissionFrom(envelope));

  // Cumulative session cost (USD) carried in ext.cost (#8), or null when the
  // wrapper did not attach it.
  function costUsd(env: Envelope): number | null {
    const cost = env.ext?.cost;
    return typeof cost === "number" ? cost : null;
  }

  // --- Claude Code status meta (#16): model / context / rate limits -------
  // All carried in ext.* and rendered defensively, since the SDK's exact
  // scales (0-1 vs 0-100) and timestamp units are not guaranteed.

  /** Normalise a rate-limit utilization (a 0-1 fraction) to an integer
   *  0..100. Values >1 are assumed already-percent and passed through; the
   *  only ambiguous input is exactly 1, read as 100% (a maxed limit — the
   *  safe reading for a rate-limit meter). */
  function pctNorm(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const pct = value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /** Clamp an already-percentage value (0-100) to an integer 0..100. Used for
   *  context usage, whose SDK `percentage` is a 0-100 scale — a value of 1
   *  means 1%, not 100%, so it must NOT go through pctNorm's fraction path. */
  function pctClamp(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  /** A finite, non-negative number, or null — for raw token counts (#55). */
  function numOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  }

  /** Compact token count: 1234 -> "1.2k", 1_200_000 -> "1.2M" (#55). */
  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }

  /** Format an epoch reset time (seconds or milliseconds) as MM/DD HH:MM. */
  function fmtReset(value: unknown): string | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const at = new Date(value < 1e12 ? value * 1000 : value);
    if (Number.isNaN(at.getTime())) return null;
    return at.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const RATE_LABELS: Record<string, string> = {
    five_hour: "5h",
    seven_day: "7day",
    seven_day_opus: "7day Opus",
    seven_day_sonnet: "7day Sonnet",
    overage: "追加",
  };

  interface RateRow {
    key: string;
    label: string;
    pct: number | null;
    reset: string | null;
    status: string | undefined;
  }

  /** Build display rows from ext.rate_limits, in a stable window order. The
   *  weekly `seven_day` window is always emitted (with a null pct = "awaiting
   *  data" placeholder) so its absence reads as pending, not a missing
   *  feature; other windows appear only once the SDK surfaces them. */
  function buildRateRows(raw: unknown): RateRow[] {
    const limits =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, Record<string, unknown> | undefined>)
        : {};
    const rows: RateRow[] = [];
    for (const key of Object.keys(RATE_LABELS)) {
      const win = limits[key];
      if (typeof win !== "object" || win === null) {
        if (key === "seven_day") {
          rows.push({
            key,
            label: RATE_LABELS[key],
            pct: null,
            reset: null,
            status: undefined,
          });
        }
        continue;
      }
      rows.push({
        key,
        label: RATE_LABELS[key],
        pct: pctNorm(win.utilization),
        reset: fmtReset(win.resets_at),
        status: typeof win.status === "string" ? win.status : undefined,
      });
    }
    return rows;
  }

  const ccModel = $derived(
    typeof envelope.ext?.model === "string" ? envelope.ext.model : null,
  );
  const ccCwd = $derived(
    typeof envelope.ext?.cwd === "string" ? envelope.ext.cwd : null,
  );
  const ccContext = $derived(
    envelope.ext?.context as Record<string, unknown> | undefined,
  );
  const ctxPct = $derived(pctClamp(ccContext?.used_percentage));
  // Real token counts behind the ctx meter (#55): the percentage alone hides
  // how much room is left. Both come from the same SDK usage object.
  const ctxUsed = $derived(numOrNull(ccContext?.used_tokens));
  const ctxMax = $derived(numOrNull(ccContext?.max_tokens));
  const ccRateRows = $derived(buildRateRows(envelope.ext?.rate_limits));
  // Selectable models + per-model effort levels for the switch dialogs (#54).
  // Operator-only: ext is stripped for viewers (#46), so these stay empty and
  // the switch controls never render for non-operators.
  const models = $derived(modelsFrom(envelope));
  // Effort choices = the union of every model's effort_levels, ordered
  // low→max. The SDK silently downgrades a level the active model does not
  // support, so offering the union is safe and avoids having to match the
  // resolved model id (ext.model) back to a supportedModels alias.
  const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  const effortLevels = $derived.by(() => {
    const seen = new Set<string>();
    for (const m of models) for (const l of m.effort_levels ?? []) seen.add(l);
    return EFFORT_ORDER.filter((l) => seen.has(l));
  });

  // The always-present seven_day placeholder (pct null) must not, by itself,
  // open the panel for a non-Claude-Code agent — require real meta or a rate
  // window that actually has data. Also open it when switch choices exist, so
  // the model / effort switch rows render even if ext.models lands before
  // ext.model (the list is a separate one-shot fetch, host #statusExt).
  const hasCcStatus = $derived(
    ccModel !== null ||
      ccCwd !== null ||
      ctxPct !== null ||
      ccRateRows.some((r) => r.pct !== null) ||
      models.length > 0,
  );

  // Wall-clock time of a log line from its envelope ts (#38). Invalid or
  // missing timestamps render as empty rather than "Invalid Date".
  function formatTime(ts: string): string {
    const at = new Date(ts);
    if (Number.isNaN(at.getTime())) return "";
    return at.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  // Local-day key for grouping consecutive log lines under a date divider
  // (#38). Null for an invalid/missing ts so it never forces a spurious
  // divider.
  function dayKey(ts: string): string | null {
    const at = new Date(ts);
    if (Number.isNaN(at.getTime())) return null;
    return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
  }

  // Date label for a day divider, e.g. "2026/06/23(月)" in ja locale (#38).
  function formatDate(ts: string): string {
    const at = new Date(ts);
    if (Number.isNaN(at.getTime())) return "";
    return at.toLocaleDateString([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
  }

  // Date-divider label per log index, recomputed only when logs changes (#38):
  // a line gets a label when its calendar day differs from the previous line
  // (and for the first line). Precomputing here avoids reconstructing the
  // previous entry's Date on every render.
  const dayDividers = $derived.by(() => {
    const labels = new Map<number, string>();
    let prev: string | null = null;
    logs.forEach((env, i) => {
      const dk = dayKey(env.ts);
      if (dk !== null && dk !== prev) labels.set(i, formatDate(env.ts));
      prev = dk;
    });
    return labels;
  });

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
  // Staged files for the next send (file-upload spec / ADR-0025 F12: lazy
  // upload — picker only holds the File references; bytes traverse the wire
  // when the operator hits 送信). Each picker open appends to the existing
  // tray (not replace), so the operator can build up the batch across
  // multiple opens. ✕ on a chip removes that one entry without touching
  // the wire. F6 caps the count at MAX_ATTACHMENTS_PER_INSTRUCTION; the
  // wrapper enforces the same cap server-side and rejects with count_over.
  let stagedFiles = $state<File[]>([]);
  let stagedFileInput = $state<HTMLInputElement | null>(null);
  // True while one of the uploadFile() calls is in flight (between the
  // first attach_open and the instruction push); locks the send button
  // against double-submits.
  let uploading = $state(false);
  // Per-instruction attachment cap (file-upload spec / ADR-0025 F6). Kept
  // in sync with the wrapper's MAX_ATTACHMENTS_PER_INSTRUCTION; reading
  // it from a shared constant would mean importing from @kaoiro/protocol
  // which is wrapper-side, so the spec value is mirrored here.
  const MAX_STAGED = 10;
  // Mid-flight ESC (#51): set on click, cleared when the server replies
  // (ok/error/timeout). The agent's own state change is what stops the
  // turn — this flag only locks the button against double-clicks.
  let interrupting = $state(false);

  // RUNNING_STATES is shared with AgentCard via protocol.ts so both
  // surfaces gate the interrupt button on the same set.
  const canInterrupt = $derived(RUNNING_STATES.has(envelope.state));

  // Delete is offered only for a disconnected agent (#14); the interrupt
  // button is hidden then (disconnected is not a running state), so the
  // delete button takes its place in the same action slot below it.
  const canDelete = $derived(envelope.state === "disconnected");
  let deleting = $state(false);

  // Terminate ends the wrapper process (#22), distinct from interrupt (which
  // only stops the current turn). Offered for any connected agent; hidden once
  // disconnected (nothing left to terminate — delete handles those).
  const canStop = $derived(envelope.state !== "disconnected");
  let stopping = $state(false);

  // Restore is offered for a disconnected agent with a resumable session
  // (#22, ADR-0014); it sits in the terminate button's slot (the two never
  // show at once — terminate is hidden once disconnected).
  const canRestore = $derived(
    envelope.state === "disconnected" &&
      typeof envelope.session_id === "string" &&
      envelope.session_id !== "",
  );
  let restoring = $state(false);

  // Folded state of the permission dock (#…): when true it sits as a small
  // button in the conversation's top-right corner instead of covering the
  // transcript. permFullH carries the panel's natural height so the dock can
  // animate height between the open panel and the folded pill.
  let permMinimized = $state(false);
  let permFullH = $state(0);
  // Input-area height, so the open dock can float just above the composer
  // without overlapping it (the composer grows with the sending/error notes).
  let composerH = $state(0);
  // A fresh request (new request_id) always opens expanded, so a pending
  // decision is never hidden by a stale folded state from an earlier one.
  $effect(() => {
    void permission?.request_id;
    permMinimized = false;
  });

  // --- model / effort switch (#54) ------------------------------------------
  // Popover state for the two switch buttons. selectedEffort is the operator's
  // last pick this session: the SDK does not report the active effort, so it
  // cannot be read off ext like the model (ext.model). It is client-side and
  // shows "既定" until the operator first chooses one.
  let modelMenuOpen = $state(false);
  let effortMenuOpen = $state(false);
  let selectedEffort = $state<string | null>(null);
  // Optimistic model label shown the instant the operator switches: ext.model
  // (the authoritative resolved id) only catches up a turn later, so without
  // this the model row stays on the old value until the next reply (#54).
  // Cleared once ext.model actually changes, or on agent switch.
  let pendingModel = $state<string | null>(null);
  let lastCcModel = untrack(() => ccModel);
  $effect(() => {
    if (ccModel !== lastCcModel) {
      lastCcModel = ccModel;
      pendingModel = null;
    }
  });
  const modelLabel = $derived(pendingModel ?? ccModel);
  // Reset the popovers + the optimistic picks when the detail switches to a
  // different agent (the component is reused, not re-keyed, in App.svelte).
  let switchAgentId = untrack(() => envelope.agent_id);
  $effect(() => {
    if (envelope.agent_id !== switchAgentId) {
      switchAgentId = envelope.agent_id;
      selectedEffort = null;
      pendingModel = null;
      modelMenuOpen = false;
      effortMenuOpen = false;
    }
  });
  // Close both popovers on a click outside any switch box.
  $effect(() => {
    if (!modelMenuOpen && !effortMenuOpen) return;
    function onDocClick(event: MouseEvent): void {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".cc-switchbox")) {
        modelMenuOpen = false;
        effortMenuOpen = false;
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });

  function toggleModelMenu(): void {
    effortMenuOpen = false;
    modelMenuOpen = !modelMenuOpen;
  }
  function toggleEffortMenu(): void {
    modelMenuOpen = false;
    effortMenuOpen = !effortMenuOpen;
  }
  function chooseModel(value: string): void {
    modelMenuOpen = false;
    if (!connection) return;
    // Reflect the pick immediately (ext.model lags a turn); show the friendly
    // name when known, else the raw alias.
    const choice = models.find((m) => m.value === value);
    pendingModel = choice?.display_name ?? value;
    void run(() => connection.setModel(envelope.agent_id, value));
  }
  function chooseEffort(level: string): void {
    effortMenuOpen = false;
    if (!connection) return;
    selectedEffort = level;
    void run(() => connection.setEffort(envelope.agent_id, level));
  }
  // tool_use_id under the pointer, so its tool_use and tool_result both
  // highlight while hovered (#40).
  let hoveredTool = $state<string | null>(null);
  let logEl = $state<HTMLDivElement | null>(null);

  // Render any new mermaid diagrams (#42), then keep the transcript pinned to
  // the latest line (diagrams change the scroll height, so scroll after).
  $effect(() => {
    void logs.length;
    void tick().then(async () => {
      if (!logEl) return;
      try {
        await renderMermaidIn(logEl);
      } catch (error) {
        console.error("mermaid render failed", error);
      }
      // The component may have unmounted during the await; re-check logEl.
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
    // Either text or at least one staged file is required; both empty is
    // a no-op.
    if (!connection || (text === "" && stagedFiles.length === 0)) return;
    const files = stagedFiles;
    void run(async () => {
      const before = logs.length;
      const attachmentIds: string[] = [];
      if (files.length > 0) {
        // Uploads run sequentially: parallel push would interleave many
        // attach_chunk frames in flight at once, which can exceed the
        // server's transport in-flight cap (file-upload spec). The
        // wall-clock cost is small for the 5 MB / 10-file phase ceiling.
        uploading = true;
        try {
          for (const file of files) {
            const uploadId = await connection.uploadFile(
              envelope.agent_id,
              file,
            );
            attachmentIds.push(uploadId);
          }
        } finally {
          uploading = false;
        }
      }
      await connection.sendInstruction(
        envelope.agent_id,
        text,
        attachmentIds.length > 0 ? attachmentIds : undefined,
      );
      instruction = "";
      stagedFiles = [];
      if (stagedFileInput !== null) stagedFileInput.value = "";
      // Wait for the server to reflect the user log back into the transcript
      // (one WS round-trip; ~50-200ms on a local link). Cap at 1.5s so a
      // stalled server still settles. Then bring the just-sent line into
      // view with scrollIntoView, which is robust to composer-reflow timing
      // that can leave a plain scrollTop=scrollHeight short.
      const deadline = Date.now() + 1500;
      while (logs.length === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await tick();
      const last = logEl?.lastElementChild as HTMLElement | null;
      last?.scrollIntoView({ block: "end", behavior: "smooth" });
    });
  }

  function onFilePicked(event: Event): void {
    // A fresh picker open is a new interaction: clear any stale error
    // from a prior overflow / failed submit so the operator does not see
    // a misleading message that no longer applies (the if-branch below
    // only sets the error on overflow and would otherwise leave it).
    actionError = "";
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    // Append rather than replace, so the operator can build up the tray
    // across multiple picker opens (e.g. browse twice for files in
    // different folders). The cap is the spec value; any overflow is
    // dropped with a hint so the operator knows not all were staged.
    const next: File[] = [...stagedFiles];
    let dropped = 0;
    for (const f of picked) {
      if (next.length >= MAX_STAGED) {
        dropped++;
        continue;
      }
      next.push(f);
    }
    stagedFiles = next;
    if (dropped > 0) {
      actionError = `添付は ${MAX_STAGED} 件まで(${dropped} 件は無視されました)`;
    }
    // The native input's FileList is consumed on read; clearing the
    // value here lets the operator re-pick the same file later if they
    // remove it with ✕ first.
    if (stagedFileInput !== null) stagedFileInput.value = "";
  }

  function removeStagedFile(index: number): void {
    stagedFiles = stagedFiles.filter((_, i) => i !== index);
  }

  // --- Slash command completion (#34) ---------------------------------------
  // Commands the SDK reported at session init, surfaced via ext. Viewers never
  // see the menu: #46 strips ext for non-operators, so slashCommands is empty.
  let slashTextarea = $state<HTMLTextAreaElement | null>(null);
  let slashIndex = $state(0);
  const slashCommands = $derived.by(() => {
    const raw = envelope.ext?.slash_commands;
    return Array.isArray(raw)
      ? raw.filter((c): c is string => typeof c === "string")
      : [];
  });
  // The command token being typed: "/" + non-space with no space yet. null
  // once a space is typed or the input does not start with "/".
  const slashQuery = $derived.by(() => {
    const m = /^\/(\S*)$/.exec(instruction);
    return m ? m[1] : null;
  });
  const slashMatches = $derived.by(() => {
    if (slashQuery === null || slashCommands.length === 0) return [];
    const q = slashQuery.toLowerCase();
    return slashCommands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 8);
  });
  // Escape dismisses the menu for the current query; retyping reopens it.
  let slashDismissed = $state<string | null>(null);
  const showSlash = $derived(
    slashMatches.length > 0 && slashDismissed !== slashQuery,
  );
  // Keep the highlight in range as the match set changes.
  $effect(() => {
    void slashMatches.length;
    slashIndex = 0;
  });

  function applySlash(command: string): void {
    instruction = `/${command} `;
    slashDismissed = null;
    slashTextarea?.focus();
  }

  // Multi-line input (#33): Enter inserts a newline; Ctrl/Cmd+Enter submits.
  // While the slash menu is open (#34), arrows/Tab/Enter/Escape drive it.
  function onInstructionKeydown(event: KeyboardEvent): void {
    if (showSlash) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        slashIndex =
          (slashIndex - 1 + slashMatches.length) % slashMatches.length;
        return;
      }
      if (
        event.key === "Tab" ||
        (event.key === "Enter" && !event.ctrlKey && !event.metaKey)
      ) {
        event.preventDefault();
        applySlash(slashMatches[slashIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        slashDismissed = slashQuery;
        return;
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  // Scroll to and flash the partner of a tool block (#40): from a tool_use to
  // its tool_result and vice versa, matched by tool_use_id.
  function jumpToTool(event: MouseEvent, id: string, fromKind: string): void {
    event.preventDefault();
    event.stopPropagation(); // don't toggle the <details> we live inside
    if (!logEl) return;
    const toKind = fromKind === "tool_use" ? "tool_result" : "tool_use";
    const target = logEl.querySelector<HTMLElement>(
      `[data-tuid="${CSS.escape(id)}"][data-kind="${toKind}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1000);
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

  // ESC-equivalent stop (#51): fire-and-forget to the wrapper. The button
  // is hidden when the agent is not running, so a stale click cannot happen
  // here; the wrapper still no-ops a stale interrupt on its end.
  function interrupt(): void {
    if (!connection || interrupting) return;
    void run(async () => {
      interrupting = true;
      try {
        await connection.sendInterrupt(envelope.agent_id);
      } finally {
        interrupting = false;
      }
    });
  }

  // Remove a disconnected agent (#14): destructive, so confirm first. On
  // success the server broadcasts agent_deleted; App drops it and this
  // detail falls back to the grid as its selected agent vanishes.
  function deleteAgent(): void {
    if (!connection || deleting) return;
    const ok = window.confirm(
      `切断済みエージェント「${name}」を一覧から削除します。よろしいですか?`,
    );
    if (!ok) return;
    void run(async () => {
      deleting = true;
      try {
        await connection.deleteAgent(envelope.agent_id);
      } finally {
        deleting = false;
      }
    });
  }

  // Terminate the wrapper (#22): the owning runner kills the process and the
  // agent goes disconnected. Warn first when it is mid-work; idle / your turn
  // / done are safe and skip the confirm.
  function stopAgent(): void {
    if (!connection || stopping) return;
    if (!STOP_SAFE_STATES.has(envelope.state)) {
      // Use the LIVE state for the label so it matches the gate above; the
      // detail's `expression` is display-lagged (StatusQueue) and could name a
      // stale state in the warning.
      const liveLabel = expressionFor(envelope.state).label;
      const ok = window.confirm(
        `「${name}」は${liveLabel}です。終了すると進行中の作業は失われる可能性があります。終了しますか?`,
      );
      if (!ok) return;
    }
    void run(async () => {
      stopping = true;
      try {
        await connection.stop(envelope.agent_id);
      } finally {
        stopping = false;
      }
    });
  }

  // Restore a disconnected agent (#22, ADR-0014「復帰」): re-spawn the same
  // agent_id with resume from the server's session pointer. Non-destructive,
  // so no confirm.
  function restoreAgent(): void {
    if (!connection || restoring) return;
    void run(async () => {
      restoring = true;
      try {
        await connection.restore(envelope.agent_id);
      } finally {
        restoring = false;
      }
    });
  }

  // Purge past-session reply lines (#48): destructive and irreversible, so
  // confirm first. No-op without a known current session_id (the button is
  // disabled then); the server keeps only that session's lines.
  function clearHistory(): void {
    if (!connection || !envelope.session_id) return;
    const ok = window.confirm(
      "現在のセッション以外の返答ログを消去します。元に戻せません。よろしいですか?",
    );
    if (!ok) return;
    void run(() => connection.clearHistory(envelope.agent_id));
  }
</script>

<section class="detail" data-state={expression.variant} in:expandFrom={{ origin }}>
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

  <div class="body">
    <aside class="status">
      <header class="head">
        <div class="portrait">
          {#key display.shown}
            {#if spriteUrl}
              <img class="sprite" src={spriteUrl} alt={expression.label} />
            {:else}
              <span class="face" aria-label={expression.label}></span>
            {/if}
          {/key}
          <span class="lamp" title={expression.label}></span>
        </div>
        <div class="meta">
          <h2>{name}</h2>
          {#key display.shown}
            <p class="state">{expression.label}</p>
          {/key}
          <p class="id">{envelope.agent_id}</p>
        </div>
      </header>

      {#if hasCcStatus}
        <!-- Claude Code status meta (#16): mirrors the local statusline's
             model / ctx / 5h / 7d segments for this agent. -->
        <dl class="cc">
          {#if ccModel}
            <div class="cc-row">
              <dt>model</dt>
              <dd>
                <div class="cc-switchbox">
                  <span class="cc-model">{modelLabel}</span>
                  {#if connection && models.length > 0}
                    <button
                      type="button"
                      class="cc-switch"
                      aria-haspopup="listbox"
                      aria-expanded={modelMenuOpen}
                      title="モデルを切替"
                      onclick={toggleModelMenu}
                    >切替</button>
                  {/if}
                  {#if modelMenuOpen}
                    <ul
                      class="switch-menu"
                      role="listbox"
                      aria-label="モデル候補"
                    >
                      {#each models as m (m.value)}
                        <li>
                          <button
                            type="button"
                            role="option"
                            aria-selected={ccModel === m.value}
                            title={m.description}
                            onclick={() => chooseModel(m.value)}
                          >{m.display_name}</button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </dd>
            </div>
          {/if}
          {#if connection && effortLevels.length > 0}
            <!-- effort has no SDK-reported current value; the dd shows the
                 operator's last pick this session (selectedEffort) or 既定. -->
            <div class="cc-row">
              <dt>effort</dt>
              <dd>
                <div class="cc-switchbox">
                  <span class="cc-model">{selectedEffort ?? "既定"}</span>
                  <button
                    type="button"
                    class="cc-switch"
                    aria-haspopup="listbox"
                    aria-expanded={effortMenuOpen}
                    title="effort を切替"
                    onclick={toggleEffortMenu}
                  >切替</button>
                  {#if effortMenuOpen}
                    <ul
                      class="switch-menu"
                      role="listbox"
                      aria-label="effort 候補"
                    >
                      {#each effortLevels as level (level)}
                        <li>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selectedEffort === level}
                            onclick={() => chooseEffort(level)}
                          >{level}</button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </dd>
            </div>
          {/if}
          {#if ccCwd}
            <div class="cc-row">
              <dt>cwd</dt>
              <dd class="cc-cwd" title={ccCwd}>{ccCwd}</dd>
            </div>
          {/if}
          {#if ctxPct !== null}
            <div class="cc-row">
              <dt>ctx</dt>
              <dd>
                <div class="meter">
                  <div class="meter-fill" style:width="{ctxPct}%"></div>
                </div>
                <span class="meter-val">
                  {ctxPct}%
                  {#if ctxUsed !== null && ctxMax !== null}
                    <span class="meter-abs"
                      >({fmtTokens(ctxUsed)}/{fmtTokens(ctxMax)})</span>
                  {/if}
                </span>
              </dd>
            </div>
          {/if}
          {#each ccRateRows as r (r.key)}
            <div class="cc-row">
              <dt>{r.label}</dt>
              <dd>
                {#if r.key === "seven_day" && r.pct === null}
                  <span class="cc-pending">まだ情報がありません</span>
                {:else}
                  <div
                    class="meter"
                    data-status={r.status}
                    title={r.reset ? "リセット " + r.reset : undefined}
                  >
                    <div class="meter-fill" style:width="{r.pct ?? 0}%"></div>
                  </div>
                  <span class="meter-val"
                    >{r.pct === null ? "?" : r.pct + "%"}</span>
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      {/if}

      {#if connection}
        <!-- Destructive (#48): purge the server-side reply log of past
             sessions, keeping only the current one. Disabled until the
             current session_id is known (nothing to scope the purge to). -->
        <button
          type="button"
          class="clear-history"
          disabled={!envelope.session_id}
          title={envelope.session_id
            ? "現在のセッション以外の返答ログを消去します"
            : "現在のセッションが不明なため消去できません"}
          onclick={clearHistory}
        >
          過去セッションのログを消去
        </button>
      {/if}

      {#if connection && canStop}
        <!-- Terminate the wrapper (#22): left-pane bottom. Warns first when
             the agent is mid-work (stopAgent). -->
        <button
          type="button"
          class="terminate"
          disabled={stopping}
          title="エージェント(wrapper)を終了する"
          onclick={stopAgent}
        >
          {stopping ? "終了中…" : "エージェントを終了"}
        </button>
      {:else if connection && canRestore}
        <!-- Restore a disconnected agent (#22, ADR-0014): same slot as the
             terminate button (hidden once disconnected). Re-spawns the same
             agent_id with resume; the server fills cwd from its pointer. -->
        <button
          type="button"
          class="restore"
          disabled={restoring}
          title="セッションを再開してエージェントを復帰させる"
          onclick={restoreAgent}
        >
          {restoring ? "復帰中…" : "エージェントを復帰"}
        </button>
      {/if}
    </aside>

    <div class="main" style:--composer-h={composerH ? composerH + "px" : null}>
      <div class="log" bind:this={logEl}>
        {#if logs.length === 0}
          <p class="empty">まだ返答はありません。</p>
        {/if}
        {#each logs as env, i (env.ts + ":" + (env.seq ?? i))}
          {@const log = logOf(env)}
          {@const res = resultOf(env)}
          {@const time = formatTime(env.ts)}
          {@const dateLabel = dayDividers.get(i)}
          {#if dateLabel}
            <div class="day-divider"><span>{dateLabel}</span></div>
          {/if}
          {#if log?.kind === "user"}
            <!-- Untrusted: renderMarkdown sanitizes via DOMPurify (#30). -->
            <div class="msg user">
              {@html renderMarkdown(log.text ?? "")}
              <time class="ts" datetime={env.ts}>{time}</time>
            </div>
          {:else if log?.kind === "assistant"}
            <!-- Untrusted: renderMarkdown sanitizes via DOMPurify (#30). -->
            <div class="msg assistant">
              {@html renderMarkdown(log.text ?? "")}
              <time class="ts" datetime={env.ts}>{time}</time>
            </div>
          {:else if log?.kind === "tool_use"}
            {@const tuid = log.tool_use_id}
            <details
              class="tool"
              class:linked={hoveredTool !== null && hoveredTool === tuid}
              data-tuid={tuid ?? ""}
              data-kind="tool_use"
              onmouseenter={() => (hoveredTool = tuid ?? null)}
              onmouseleave={() => (hoveredTool = null)}
            >
              <summary
                >ツール呼び出し: {log.tool_name}
                {#if tuid}
                  <button
                    type="button"
                    class="tlink"
                    title="対応する結果へ"
                    onclick={(e) => jumpToTool(e, tuid, "tool_use")}
                    >🔗{tuid.slice(-4)}</button>
                {/if}
                <time class="ts" datetime={env.ts}>{time}</time></summary>
              <pre>{JSON.stringify(log.input ?? {}, null, 2)}{log.truncated
                  ? "\n…(入力が大きいため省略)"
                  : ""}</pre>
            </details>
          {:else if log?.kind === "tool_result"}
            {@const tuid = log.tool_use_id}
            <details
              class="tool"
              class:linked={hoveredTool !== null && hoveredTool === tuid}
              data-tuid={tuid ?? ""}
              data-kind="tool_result"
              onmouseenter={() => (hoveredTool = tuid ?? null)}
              onmouseleave={() => (hoveredTool = null)}
            >
              <summary
                >結果: {log.tool_name ?? "tool"}
                {#if tuid}
                  <button
                    type="button"
                    class="tlink"
                    title="対応する呼び出しへ"
                    onclick={(e) => jumpToTool(e, tuid, "tool_result")}
                    >🔗{tuid.slice(-4)}</button>
                {/if}
                <time class="ts" datetime={env.ts}>{time}</time></summary>
              <pre>{log.output ?? ""}{log.truncated ? "\n…(省略)" : ""}</pre>
            </details>
          {:else if res}
            {@const cost = costUsd(env)}
            <!-- The reply text already shows as the final assistant log; the
                 result only marks the turn boundary, not a duplicate (#29). -->
            <p class="turn-end" class:error={res.is_error}>
              {res.is_error ? "エラーで終了" : "応答完了"}
              {#if cost !== null}
                <span
                  class="cost"
                  title="API 標準単価での推定値。Claude サブスク利用時は実課金額ではありません(従量 API キー利用時のみ実コストに近い)。セッション開始からの累計。"
                  >累計 ~${cost.toFixed(4)}</span>
              {/if}
              <time class="ts" datetime={env.ts}>{time}</time>
            </p>
          {/if}
        {/each}
      </div>

      {#if connection}
        {#if canInterrupt}
          <!-- ESC equivalent (#51, ADR-0020). One-click, fire-and-forget;
               the agent's own state change is the visible confirmation. -->
          <button
            type="button"
            class="interrupt"
            onclick={interrupt}
            disabled={interrupting}
            title="現在のターンを中断 (ESC 相当)"
          >
            <span class="interrupt-icon" aria-hidden="true">■</span>
            {interrupting ? "中断中…" : "中断"}
          </button>
        {:else if canDelete}
          <!-- Delete a disconnected agent (#14): sits in the interrupt
               button's slot (the two never show at once). -->
          <button
            type="button"
            class="remove"
            onclick={deleteAgent}
            disabled={deleting}
            title="切断済みエージェントを一覧から削除"
          >
            <span class="remove-icon" aria-hidden="true">✕</span>
            {deleting ? "削除中…" : "削除"}
          </button>
        {/if}

        {#if permission}
          <!-- Permission dock (#46): the request can fold up into a button in
               the conversation's top-right corner so it stops covering the
               transcript, then unfold back. Fold/unfold is a 0.25s eased move. -->
          <div
            class="permission-dock"
            class:min={permMinimized}
            style:--full-h={permFullH ? permFullH + "px" : null}
          >
            <div
              class="permission-full"
              bind:offsetHeight={permFullH}
              inert={permMinimized}
            >
              <button
                class="permission-min"
                type="button"
                title="最小化"
                aria-label="許可ダイアログを最小化"
                onclick={() => (permMinimized = true)}></button>
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
            <button
              class="permission-pill"
              type="button"
              title="許可ダイアログを開く"
              aria-label="許可ダイアログを開く"
              inert={!permMinimized}
              onclick={() => (permMinimized = false)}
            >
              <span class="permission-pill-lamp"></span>
              許可待ち
            </button>
          </div>
        {/if}

        <div class="composer" bind:offsetHeight={composerH}>
          {#if showSlash}
            <!-- Slash command completion (#34): pick with click or
                 arrows + Tab/Enter; Escape dismisses. -->
            <ul class="slash-menu" role="listbox" aria-label="スラッシュコマンド候補">
              {#each slashMatches as cmd, i (cmd)}
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === slashIndex}
                    class:active={i === slashIndex}
                    onmousedown={(e) => {
                      e.preventDefault();
                      applySlash(cmd);
                    }}>/{cmd}</button>
                </li>
              {/each}
            </ul>
          {/if}
          <form class="instruct" onsubmit={sendInstruction}>
            <textarea
              class:sending={display.shown === "sending"}
              placeholder="指示を送る…(Ctrl+Enter で送信、/ でコマンド候補)"
              bind:value={instruction}
              bind:this={slashTextarea}
              onkeydown={onInstructionKeydown}
              rows="2"
              aria-label="instruction for {name}"
            ></textarea>
            <label class="attach" title="ファイル添付(画像 / テキスト / コード、複数可)">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,text/*,application/json,application/xml,application/yaml,application/x-yaml,application/javascript,application/typescript,application/sql"
                multiple
                onchange={onFilePicked}
                bind:this={stagedFileInput}
              />
              <span>📎</span>
            </label>
            <button
              type="submit"
              disabled={uploading ||
                (instruction.trim() === "" && stagedFiles.length === 0)}
              >{uploading ? "送信中…" : "送信"}</button
            >
          </form>

          {#each stagedFiles as file, i (`${file.name}:${file.size}:${i}`)}
            <div class="staged">
              <span
                >{file.type.startsWith("image/") ? "🖼" : "📄"} {file.name} ({(
                  file.size / 1024
                ).toFixed(1)} KB)</span>
              <button
                type="button"
                onclick={() => removeStagedFile(i)}
                aria-label="添付を解除">✕</button>
            </div>
          {/each}

          {#if display.shown === "sending"}
            <p class="sending-note">送信中… 応答待ち</p>
          {/if}

          {#if actionError}
            <p class="action-error">{actionError}</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</section>

<style>
  .detail {
    --tone: var(--c-idle);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 72rem;
    margin: 0 auto;
    /* Fill the viewport-height main column (App shell) so the log scrolls and
       the composer stays pinned at the bottom of the screen (#33). */
    height: 100%;
  }

  /* Two-column body (#37): status pinned left, conversation log right.
     min-height:0 lets the log scroll instead of stretching the page. */
  .body {
    display: flex;
    gap: 1.5rem;
    flex: 1;
    min-height: 0;
  }

  .status {
    flex: 0 0 20%;
    min-width: 9rem;
  }

  .clear-history {
    margin-top: 0.75rem;
    width: 100%;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--c-error);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .clear-history:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 12%, var(--bg-card));
  }

  .clear-history:disabled {
    border-color: var(--line);
    color: var(--fg-dim);
    cursor: not-allowed;
    opacity: 0.7;
  }

  /* Terminate the wrapper (#22): full-width danger button at the pane bottom,
     filled to read as the most destructive action in the pane. */
  .terminate {
    margin-top: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.5rem;
    border: 1px solid var(--c-error);
    border-radius: 0.35rem;
    background: color-mix(in srgb, var(--c-error) 14%, var(--bg-card));
    color: var(--c-error);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }

  .terminate:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 24%, var(--bg-card));
  }

  .terminate:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Restore button (#22): same pane-bottom slot as terminate, constructive
     (waiting_input) tone rather than danger — it brings the agent back. */
  .restore {
    margin-top: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.5rem;
    border: 1px solid var(--c-waiting_input);
    border-radius: 0.35rem;
    background: color-mix(in srgb, var(--c-waiting_input) 14%, var(--bg-card));
    color: var(--c-waiting_input);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }

  .restore:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-waiting_input) 24%, var(--bg-card));
  }

  .restore:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .main {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Wrapper exists only to measure the input area's height (--composer-h), so
     the floating permission dock can rest just above it (#46). position:
     relative anchors the slash-command menu (#34) above the textarea. */
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Slash command menu (#34): floats just above the composer; the highlighted
     row tracks keyboard navigation, hover mirrors it. */
  .slash-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    width: min(20rem, 100%);
    max-height: 12rem;
    margin: 0 0 0.4rem;
    padding: 0.25rem;
    list-style: none;
    overflow-y: auto;
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 5;
  }

  .slash-menu li {
    margin: 0;
  }

  .slash-menu button {
    display: block;
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: none;
    border-radius: 0.25rem;
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
  }

  .slash-menu button.active,
  .slash-menu button:hover {
    background: color-mix(in srgb, var(--tone) 20%, var(--bg-card));
  }

  @media (max-width: 640px) {
    .detail {
      height: auto;
      min-height: calc(100vh - 4rem);
    }
    .body {
      flex-direction: column;
    }
    .status {
      flex: none;
    }
    .log {
      max-height: 60vh;
    }
  }

  .detail[data-state="sending"] { --tone: var(--c-sending); }
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
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    text-align: center;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--line);
  }

  /* Persona portrait (#16): fills the pane width with a subtle top light,
     like the grid cards; a state-coloured lamp sits in the corner. */
  .portrait {
    position: relative;
    width: 100%;
    display: flex;
    justify-content: center;
    padding: 0.8rem;
    border-radius: 0.5rem;
    background:
      radial-gradient(
        circle at 50% 0%,
        color-mix(in srgb, var(--tone) 14%, transparent),
        transparent 70%
      ),
      var(--bg-card);
  }

  .sprite {
    width: 100%;
    height: auto;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    animation: dissolve 0.35s ease-out;
  }

  /* Dissolve-in on state change (#43): the previous face/label is replaced
     via {#key}, so the new one fades up from transparent. prefers-reduced-
     motion shortens this to ~instant via the global rule in app.css. */
  @keyframes dissolve {
    from { opacity: 0; }
  }

  [data-state="disconnected"] .sprite {
    filter: grayscale(1);
    opacity: 0.45;
  }

  .face {
    width: 70%;
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: dissolve 0.35s ease-out;
  }

  /* State lamp on the portrait (#16): same shape/size as the connection
     dot, coloured by the agent's state via --tone. */
  .lamp {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    background: var(--tone);
    box-shadow: 0 0 6px var(--tone);
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
    animation: dissolve 0.35s ease-out;
  }

  .id {
    margin: 0.3rem 0 0;
    font-size: 0.7rem;
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  /* Claude Code status meta panel (#16): model / ctx / rate-limit meters. */
  .cc {
    margin: 0;
    padding-top: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    font-size: 0.7rem;
  }

  .cc-row {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .cc dt {
    color: var(--fg-dim);
    letter-spacing: 0.05em;
  }

  .cc dd {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .cc-model {
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  /* model / effort switch (#54): a small inline button after the value, with
     a popover listing the choices. */
  .cc-switchbox {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .cc-switchbox .cc-model {
    flex: 1;
    min-width: 0;
  }

  .cc-switch {
    flex: none;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--fg-dim);
    font: inherit;
    font-size: 0.62rem;
    cursor: pointer;
  }

  .cc-switch:hover {
    color: var(--fg);
    border-color: var(--tone);
  }

  .switch-menu {
    position: absolute;
    top: 100%;
    left: 0;
    width: max-content;
    min-width: 8rem;
    max-width: 16rem;
    max-height: 12rem;
    margin: 0.3rem 0 0;
    padding: 0.25rem;
    list-style: none;
    overflow-y: auto;
    background: var(--bg-card);
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 5;
  }

  .switch-menu li {
    margin: 0;
  }

  .switch-menu button {
    display: block;
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: none;
    border-radius: 0.25rem;
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
  }

  .switch-menu button[aria-selected="true"] {
    color: var(--tone);
  }

  .switch-menu button:hover {
    background: color-mix(in srgb, var(--tone) 20%, var(--bg-card));
  }

  /* Placeholder for a rate window the SDK has not surfaced yet (#16). */
  .cc-pending {
    font-size: 0.7rem;
    color: var(--fg-dim);
  }

  /* cwd can be a long absolute path; clip to one line keeping the tail (the
     project dir) visible, full value on hover. rtl+left-align truncates the
     start (`…/git/kaoiro`) rather than the more useful tail. */
  .cc-cwd {
    color: var(--fg);
    direction: rtl;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meter {
    width: 100%;
    height: 0.45rem;
    border-radius: 0.25rem;
    background: var(--bg);
    border: 1px solid var(--line);
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    background: var(--c-waiting_input);
  }

  .meter[data-status="allowed_warning"] .meter-fill {
    background: var(--c-tool_running);
  }

  .meter[data-status="rejected"] .meter-fill {
    background: var(--c-error);
  }

  .meter-val {
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  /* Raw token counts beside the ctx percentage (#55): dimmer and smaller so
     the percentage stays the primary read. */
  .meter-abs {
    margin-left: 0.3em;
    font-size: 0.85em;
    opacity: 0.8;
  }

  .log {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    overflow-y: auto;
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

  /* Rendered mermaid diagram (#42): centre it and keep the SVG responsive. */
  .msg :global(.mermaid-rendered) {
    margin: 0.5rem 0;
    text-align: center;
  }

  .msg :global(.mermaid-rendered svg) {
    max-width: 100%;
    height: auto;
  }

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

  /* Per-line wall-clock time (#38): small, dim, monospaced digits. */
  .ts {
    font-size: 0.62rem;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }

  .msg .ts {
    display: block;
    margin-top: 0.3rem;
    text-align: right;
    opacity: 0.8;
  }

  .turn-end .ts {
    margin-left: 0.5em;
  }

  /* Date divider between log lines whose calendar day differs (#38): a
     centred date label flanked by hairlines. */
  .day-divider {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0.6rem 0 0.2rem;
    color: var(--fg-dim);
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    font-variant-numeric: tabular-nums;
  }

  .day-divider::before,
  .day-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  /* Session cost on the turn boundary (#8). */
  .cost {
    margin-left: 0.5em;
    font-size: 0.68rem;
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
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

  /* tool_use <-> tool_result pairing (#40): hovering one highlights both, and
     the link badge jumps to (and flashes) the partner. */
  .tool.linked {
    border-color: var(--c-tool_running);
    background: color-mix(in srgb, var(--c-tool_running) 8%, transparent);
  }

  .tlink {
    margin-left: 0.4rem;
    padding: 0 0.3rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg);
    color: var(--c-tool_running);
    font: inherit;
    font-size: 0.62rem;
    cursor: pointer;
  }

  /* .flash is toggled from JS (jumpToTool), so mark it global to keep
     svelte-check from flagging it as an unused selector. */
  .tool:global(.flash) {
    animation: flash 1s ease-out;
  }

  @keyframes flash {
    from { background: color-mix(in srgb, var(--c-tool_running) 35%, transparent); }
  }

  .tool pre {
    margin: 0.4rem 0 0;
    max-height: 16rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--fg-dim);
  }

  /* Permission dock (#46): a transparent clip/anchor box that floats over the
     transcript. Open, it rests just above the composer at full width; folded
     (.min) it shrinks to a pill in the top-right corner. The 0.25s eased move
     is a transition on position + size; its two layers (.permission-full /
     .permission-pill) crossfade. --full-h (the open height, measured) lets the
     box animate its height between the panel and the pill. */
  .permission-dock {
    --pill-h: 2.4rem;
    --pill-w: 10rem;
    position: absolute;
    right: 0;
    bottom: calc(var(--composer-h, 0px) + 0.6rem);
    z-index: 2;
    width: 100%;
    height: var(--full-h, auto);
    overflow: hidden;
    transition:
      bottom 0.25s ease,
      width 0.25s ease,
      height 0.25s ease;
  }

  .permission-dock.min {
    bottom: calc(100% - var(--pill-h));
    width: var(--pill-w);
    height: var(--pill-h);
  }

  .permission-full {
    position: relative;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.45rem;
    background: var(--bg-card);
    font-size: 0.8rem;
    transition: opacity 0.25s ease;
  }

  .permission-dock.min .permission-full {
    opacity: 0;
    pointer-events: none;
  }

  /* Minimize affordance, tucked into the panel's top-right corner. */
  .permission-min {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    width: 1.4rem;
    height: 1.4rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg);
    color: var(--fg-dim);
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }

  /* Minimize glyph drawn as a bar (no ambiguous-width dash character). */
  .permission-min::before {
    content: "";
    width: 0.7rem;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
  }

  .permission-tool { margin: 0; padding-right: 1.6rem; color: var(--fg); }
  .permission-note { margin: 0.3rem 0 0; color: var(--fg-dim); }
  .permission-full details { margin-top: 0.35rem; color: var(--fg-dim); }

  .permission-full pre {
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

  /* ESC-equivalent (#51): sits above the composer when the agent is
     executing, styled like a warning action — visible but not alarming. */
  .interrupt {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--c-tool_running);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--c-tool_running);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .interrupt:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-tool_running) 14%, var(--bg-card));
  }

  .interrupt:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .interrupt-icon {
    font-size: 0.7em;
    line-height: 1;
  }

  /* Delete a disconnected agent (#14): occupies the interrupt button's slot
     (mutually exclusive states), styled as a muted destructive action. */
  .remove {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--c-error);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--c-error);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .remove:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-error) 14%, var(--bg-card));
  }

  .remove:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .remove-icon {
    font-size: 0.7em;
    line-height: 1;
  }

  /* Folded-state button: fills the dock (pill-sized when .min), crossfades
     with the panel, and carries a pulsing lamp so a pending decision stays
     noticeable in the corner. */
  .permission-pill {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.45rem;
    background: var(--bg-card);
    color: var(--c-waiting_permission);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }

  .permission-dock.min .permission-pill {
    opacity: 1;
    pointer-events: auto;
  }

  .permission-pill-lamp {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--c-waiting_permission);
    box-shadow: 0 0 6px var(--c-waiting_permission);
    animation: blink 1.2s ease-in-out infinite;
  }

  /* The fold/unfold move is a CSS transition, which the global reduced-motion
     rule in app.css (animations only) does not tame — shorten it here too. */
  @media (prefers-reduced-motion: reduce) {
    .permission-dock,
    .permission-full,
    .permission-pill {
      transition-duration: 0.01ms;
    }
  }

  .instruct {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .instruct textarea {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: 0.85rem;
    line-height: 1.4;
    resize: vertical;
  }

  /* Awaiting-response cue (#32): dark-yellow field while the agent is in the
     wrapper-issued `sending` state, until its first real turn state lands. */
  .instruct textarea.sending {
    background: color-mix(in srgb, var(--c-tool_running) 22%, var(--bg-card));
    border-color: var(--c-tool_running);
  }

  .sending-note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--c-tool_running);
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

  /* File picker (ADR-0025): the input itself is hidden, the label acts as
     the visible 📎 button so the composer row stays compact. */
  .attach {
    display: inline-flex;
    align-items: center;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg-card);
    cursor: pointer;
  }

  .attach input[type="file"] {
    display: none;
  }

  .staged {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.4rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg-card);
    font-size: 0.8rem;
  }

  .staged button {
    border: none;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85rem;
  }
</style>
