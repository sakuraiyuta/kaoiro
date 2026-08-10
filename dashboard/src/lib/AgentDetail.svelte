<script lang="ts">
  import { tick, untrack } from "svelte";
  import BottomSheet from "./BottomSheet.svelte";
  import { conversationEntryKey } from "./conversationTimeline";
  import { expressionFor, spriteUrlFor } from "./expression";
  import { StatusQueue } from "./statusDisplay.svelte";
  import { renderMarkdown, renderMermaidIn } from "./markdown";
  import TaskRing from "./TaskRing.svelte";
  import { randomUUID } from "./uuid";
  import {
    engineFrom,
    errorSubtypeLabel,
    findPrecedingUserPrompt,
    formatAgentLabel,
    hostIdFromAgentId,
    interAgentMessageOf,
    logOf,
    modelsFrom,
    modelSourceFrom,
    modelSwitchStateFrom,
    pendingPermissionFrom,
    pendingQuestionFrom,
    permissionFrom,
    PERMISSION_MODE_AXES,
    resultOf,
    resumeDriftFrom,
    RUNNING_STATES,
    sessionCapabilitiesFrom,
    shouldInterceptAsSessionReset,
    STOP_SAFE_STATES,
    userInputDialogAvailability,
  } from "./protocol";
  import type {
    Envelope,
    KaoiroConnection,
    PersonaManifest,
    RunnerSessions,
    SessionResetMode,
  } from "./protocol";

  let {
    envelope,
    logs = [],
    agents = {},
    connection = null,
    manifest = null,
    sessions = null,
    resetMode = null,
    origin = null,
    scrollToEntryKey = null,
    activeTaskCount = 0,
    onClose,
    onSelectAgent,
  }: {
    envelope: Envelope;
    logs?: Envelope[];
    agents?: Record<string, Envelope>;
    connection?: KaoiroConnection | null;
    manifest?: PersonaManifest | null;
    /** Latest resume-candidate enumeration reply (App.svelte holds the
     *  singleton). The picker filters to entries whose host_id + cwd match
     *  this agent, so a stale enumerate for another selection cannot leak in
     *  (same guard shape as LaunchDialog). */
    sessions?: RunnerSessions | null;
    /** phase-17 17-9: the mode being reset when a session_reset is in
     *  flight for this agent ("new" | "clear"), else null. Sourced from
     *  App.svelte's sessionResets state, cleared on completed / failed. */
    resetMode?: SessionResetMode | null;
    /** Viewport centre of the originating tile, for the expand anim (#36). */
    origin?: { x: number; y: number } | null;
    /** Stable identity of the timeline row that opened this detail. It is
     * deliberately a key rather than an envelope so server-synthetic IA can
     * target the recipient pane even though its producer is `server`. */
    scrollToEntryKey?: string | null;
    /** Count of subagent/workflow tasks currently active under this agent
     *  (ADR-0019/0047/0048, issue #180 follow-up 2026-08-10). Drives the
     *  頭上リング (overhead ring) the same way AgentCard's does — on/off
     *  only, no numeric display. The caller (App.svelte) is responsible
     *  for zeroing this for a disconnected/directory-only envelope (a
     *  disconnected agent cannot have an active subagent, and a stale
     *  `tasks` entry must not leak through — クロエ 2026-08-10); this
     *  component does not re-derive that guard itself. */
    activeTaskCount?: number;
    onClose: () => void;
    /** Switch the detail view to another agent (clicked peer link in an
     *  inter-agent message bubble). Omitted = peer name renders as static
     *  text, no navigation. */
    onSelectAgent?: (agentId: string) => void;
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
  // The detail is reused (not re-keyed) when the operator switches agents, so
  // the display queue would otherwise crossfade the previous agent's state onto
  // the next one. On an agent switch, snap straight to the new agent's state
  // (reset) instead of pushing it through the lag queue; only feed same-agent
  // updates through push().
  let displayAgent = untrack(() => envelope.agent_id);
  $effect(() => {
    const state = envelope.state;
    const agentId = envelope.agent_id;
    if (displayAgent !== agentId) {
      displayAgent = agentId;
      display.reset(state);
    } else {
      display.push(state);
    }
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
  // AskUserQuestion (ADR-0027): structured dialog from ext.pending_question,
  // the authoritative source (same pattern as pending_permission).
  const question = $derived(pendingQuestionFrom(envelope));
  // While a permission or question dialog is open, pin the status display so a
  // follow-up `tool_running` etc. can't overwrite the lamp/label (#82).
  $effect(() => {
    if (permission) display.hold("waiting_permission");
    else if (question) display.hold("waiting_question");
    else display.unhold();
  });

  // Per-question working state, reset when a new question (request_id) arrives.
  let qId = $state<string | null>(null);
  let qPicks = $state<string[][]>([]); // chosen option labels, per question
  let qOther = $state<string[]>([]); // free-text "Other", per question
  $effect(() => {
    const q = question;
    if (!q) return;
    if (untrack(() => qId) !== q.request_id) {
      qId = q.request_id;
      qPicks = q.questions.map(() => []);
      qOther = q.questions.map(() => "");
    }
  });

  // The answer for one question, keyed by question text at submit time. Free
  // text ("Other") overrides the radio choice for single-select; multiSelect
  // joins the chosen labels (plus any free text) with ", " (ADR-0027).
  function questionAnswer(i: number): string {
    const other = qOther[i]?.trim() ?? "";
    const picks = qPicks[i] ?? [];
    if (question?.questions[i]?.multiSelect) {
      return [...picks, ...(other ? [other] : [])].join(", ");
    }
    return other || picks[0] || "";
  }

  const questionReady = $derived(
    !!question && question.questions.every((_q, i) => questionAnswer(i) !== ""),
  );

  function pickSingle(i: number, label: string): void {
    qPicks[i] = [label];
    qOther[i] = ""; // radio and free text are mutually exclusive
  }
  function toggleMulti(i: number, label: string, checked: boolean): void {
    const set = new Set(qPicks[i] ?? []);
    if (checked) set.add(label);
    else set.delete(label);
    qPicks[i] = [...set];
  }

  function answerQuestion(): void {
    if (!connection || !question || !questionReady) return;
    const rid = question.request_id;
    const answers: Record<string, string> = {};
    question.questions.forEach((q, i) => {
      answers[q.question] = questionAnswer(i);
    });
    void run(() =>
      connection.sendQuestionResponse(envelope.agent_id, rid, answers),
    );
  }
  function cancelQuestion(): void {
    if (!connection || !question) return;
    void run(() =>
      connection.sendQuestionResponse(
        envelope.agent_id,
        question.request_id,
        {},
        true,
      ),
    );
  }

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

  /** Render a resume-drift field value for display (phase-15 D8). Fields
   *  carry strings / booleans / enums, and `undefined` means the field
   *  was not set on that side of the compare — render it as a distinct
   *  marker so "empty → workspace-write" reads differently from
   *  "read-only → workspace-write". */
  function fmtDriftValue(v: unknown): string {
    if (v === undefined || v === null) return "(未設定)";
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
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
  // Browser/Node timers clamp a delay above signed int32 to 1ms. Keep a long
  // reset as finite slices instead; every wake re-evaluates the raw deadline.
  const MAX_TIMER_DELAY_MS = 2_147_483_647;

  interface RateRow {
    key: string;
    label: string;
    pct: number | null;
    reset: string | null;
    status: string | undefined;
    resetComplete: boolean;
  }

  function resetAtMs(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value;
  }

  function nextRateReset(raw: unknown, now: number): number | null {
    if (typeof raw !== "object" || raw === null) return null;
    let next: number | null = null;
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const at = resetAtMs((value as Record<string, unknown>).resets_at);
      if (at !== null && at >= now && (next === null || at < next)) next = at;
    }
    return next;
  }

  /** Build display rows from ext.rate_limits, in a stable window order. The
   *  weekly `seven_day` window is always emitted (with a null pct = "awaiting
   *  data" placeholder) so its absence reads as pending, not a missing
   *  feature; other windows appear only once the SDK surfaces them. */
  function buildRateRows(raw: unknown, now: number): RateRow[] {
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
            resetComplete: false,
          });
        }
        continue;
      }
      const resetsAt = resetAtMs(win.resets_at);
      // rate_limits is a last-turn snapshot. Once its reset has passed, its
      // utilization / status describe the old window and must not be rendered
      // as live usage. Equality deliberately remains live: the contract is
      // strictly "past", which also makes the clock boundary deterministic.
      const resetComplete = resetsAt !== null && resetsAt < now;
      rows.push({
        key,
        label: RATE_LABELS[key],
        pct: resetComplete ? 0 : pctNorm(win.utilization),
        reset: resetComplete ? null : fmtReset(win.resets_at),
        status: resetComplete
          ? "allowed"
          : typeof win.status === "string"
            ? win.status
            : undefined,
        resetComplete,
      });
    }
    return rows;
  }

  /** #164 supplements utilization from /usage, so pct is now populated even
   *  for status="allowed" — pct and reset must render together, not as an
   *  either/or fallback, or the reset time a heavy user needs disappears
   *  whenever pct is available. */
  function rateValueLabel(row: RateRow): string {
    if (row.resetComplete) return "リセット済み";
    const parts: string[] = [];
    if (row.pct !== null) parts.push(`${row.pct}%`);
    if (row.reset !== null) parts.push(`リセット ${row.reset}`);
    return parts.length > 0 ? parts.join(" ・ ") : "?";
  }

  const ccModel = $derived(
    typeof envelope.ext?.model === "string" ? envelope.ext.model : null,
  );
  const ccCwd = $derived(
    typeof envelope.ext?.cwd === "string" ? envelope.ext.cwd : null,
  );
  // Claude Code permission mode + fast mode (#57). Show the raw enum values
  // (default / plan / bypassPermissions / etc.; off / cooldown / on) — the
  // panel is operator-only (ext is stripped for viewers), so a terse label
  // matches the cwd line above.
  const ccPermissionMode = $derived(
    typeof envelope.ext?.permission_mode === "string"
      ? envelope.ext.permission_mode
      : null,
  );
  const ccFastMode = $derived(
    typeof envelope.ext?.fast_mode === "string"
      ? envelope.ext.fast_mode
      : null,
  );
  // Engine + two-axis permission posture (ADR-0032 F4a / ADR-0033 F1). The
  // badge renders engine-neutrally from ext.permission; the mode SWITCHER
  // stays Claude-only — codex permission is launch-fixed (ADR-0033 F3).
  const agentEngine = $derived(engineFrom(envelope));
  const permAxes = $derived(permissionFrom(envelope));
  const isCodexAgent = $derived(agentEngine === "codex");
  // Codex OS sandbox の network 軸 (ADR-0033 F3, issue #118)。protocol の
  // ResolvedSnapshotExt に沿って ext.effective.network_access を defensive に
  // 読む。engine gate を derive に埋め込む (藤 R1): 他 wrapper が誤って
  // boolean を stamp しても template gate だけでは hasCcStatus 経路で panel
  // 開扉に効いてしまうため、非 Codex は最初から null に fail-closed。
  // typeof boolean gate で false は落とさない。snapshot.ts
  // effectiveStatusEnvelopeFields は network_access を top-level には展開せず
  // effective 配下にのみ入れるため、effective 経路のみを読む。
  const effectiveNetworkAccess = $derived.by(() => {
    if (!isCodexAgent) return null;
    const raw = envelope.ext?.effective;
    if (typeof raw !== "object" || raw === null) return null;
    const value = (raw as Record<string, unknown>).network_access;
    return typeof value === "boolean" ? value : null;
  });
  // ADR-0014 F1 addendum (phase-15 D8): the resume-launch drift entries the
  // wrapper stamped when this launch's effective values differ from the
  // resumed session's snapshot. null on a fresh spawn (nothing to compare),
  // empty array on a clean resume, non-empty when at least one field drifted.
  const resumeDrift = $derived(resumeDriftFrom(envelope));
  // ADR-0032 F4bc addendum (phase-15 D1): "account default" labelling is
  // driven by ext.model_source === "default", NOT by engine name. Any engine
  // whose wrapper reports the SDK's own default hits this branch — including
  // Claude when no explicit pick was made — so the label survives future
  // engines the dashboard hasn't been taught about.
  const modelSource = $derived(modelSourceFrom(envelope));
  const isAccountDefault = $derived(modelSource === "default");
  const ccContext = $derived(
    envelope.ext?.context as Record<string, unknown> | undefined,
  );
  const ctxPct = $derived(pctClamp(ccContext?.used_percentage));
  // Real token counts behind the ctx meter (#55): the percentage alone hides
  // how much room is left. Both come from the same SDK usage object.
  const ctxUsed = $derived(numOrNull(ccContext?.used_tokens));
  const ctxMax = $derived(numOrNull(ccContext?.max_tokens));
  // Capability gating for the ctx row (ADR-0040 phase-21). Tri-state, in
  // strict fail-closed order — a null/malformed caps envelope, or a wrapper
  // that predates supports_context_usage, MUST NOT render "未対応" (that
  // would misinform operators during rolling upgrade). engine 名分岐禁止 —
  // capability だけを見る (ADR-0034 F3):
  //   undefined  → capability を知らない旧 wrapper: ctx 行を非表示
  //   false      → adapter が非対応を宣言: 「未対応」表示
  //   true       → adapter は stamp する意思がある: value 到着で meter、
  //                未到着なら「取得中」placeholder

  let rateClock = $state(Date.now());
  $effect(() => {
    const rawRateLimits = envelope.ext?.rate_limits;
    // Depend on the timer tick so a crossed deadline re-arms this effect for
    // the next window. Date.now() is sampled anew for every envelope too, so
    // a new snapshot received after a long idle never uses an old clock.
    rateClock;
    const now = Date.now();
    const next = nextRateReset(rawRateLimits, now);
    if (next === null) return;
    // The contract is strictly "past", so wake one millisecond after an exact
    // reset boundary. Updating rateClock re-arms this effect for the next
    // window without needing a perpetual ticker.
    const timer = window.setTimeout(() => {
      rateClock = Date.now();
    }, Math.min(Math.max(0, next - now) + 1, MAX_TIMER_DELAY_MS));
    return () => window.clearTimeout(timer);
  });
  const ccRateRows = $derived.by(() => {
    rateClock;
    return buildRateRows(envelope.ext?.rate_limits, Date.now());
  });
  // Selectable models + per-model effort levels for the switch dialogs (#54).
  // Operator-only: ext is stripped for viewers (#46), so these stay empty and
  // the switch controls never render for non-operators.
  const models = $derived(modelsFrom(envelope));
  /** Resolves a status key against the catalog. A value-exact hit always
   *  wins alone; canonical fallback returns every non-empty resolved_model
   *  match so callers can fail closed over their shared effort domain. */
  function findCatalogEntries(key: string | null | undefined) {
    if (key === null || key === undefined) return [];
    const exact = models.find((m) => m.value === key);
    if (exact !== undefined) return [exact];
    return models.filter(
      (m) =>
        typeof m.resolved_model === "string" &&
        m.resolved_model.length > 0 &&
        m.resolved_model === key,
    );
  }
  /** A one-row exact match keeps that row's order. Canonical multi-match
   *  exposes only the intersection, and a missing effort_levels fails closed. */
  function effortLevelsForCatalogEntries(
    entries: readonly { effort_levels?: string[] }[],
  ): string[] {
    const first = entries[0];
    if (first === undefined || first.effort_levels === undefined) return [];
    if (entries.length === 1) return [...first.effort_levels];
    if (entries.some((entry) => entry.effort_levels === undefined)) return [];
    return first.effort_levels.filter((level) =>
      entries.slice(1).every((entry) => entry.effort_levels?.includes(level)),
    );
  }
  // Effort choices belong to the active (or pending) model. Offering a union
  // would permit an invalid model/effort pair and invite the silent downgrade
  // ADR-0035 explicitly forbids.
  const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  const effortLevels = $derived.by(() => {
    // Phase-23 dogfood 再回帰対策 (藤 修正版方針 5 + G1): three-tier lookup。
    //
    // 1) **concrete catalog hit** — pending / ccModel を value 完全一致で
    //    先に探し、無いときだけ resolved_model の全matchを取る。exactなら
    //    そのrow、canonical複数matchならeffort_levelsのintersection
    //    (1件でも欠落なら[])。Tier 2へfallbackしない。
    // 2) **exact miss / key 未報告** で real `value="default"` entry あり
    //    → その effort_levels (欠落なら [])。Claude bootstrap の default
    //    entry は engine が宣言した account-default effort domain。
    //    synthetic (ローカル合成) との違いは engine 側 supportedModels()
    //    に含まれる正式 alias で model 切替 menu に出しても意味を持つ点。
    // 3) **key 未報告 (null/undefined)** かつ real default 無しの場合のみ
    //    → models 全 entry の effort_levels の intersection を first entry
    //    の順で返す (1 件でも欠落あれば [])。
    // 4) **concrete key があるが exact miss + real default 無し**
    //    (藤 G1) → [] fail-closed。unknown/future/stale concrete model が
    //    catalog 候補のいずれかである保証がなく、intersection に fallback
    //    すると「現在 model に必ず valid」を主張できないため、安全側で
    //    button を非表示にする。
    //
    // union は不採用 (invalid pair 提示に相当し ADR-0035 silent downgrade
    // 禁止に反する)。synthetic default entry も不採用 (setModel("default")
    // 明示送信の責務汚染)。engine 名分岐禁止 — models 配列と key の
    // 有無だけで判定する。
    const key = pendingModel?.value ?? ccModel;
    const hasConcreteKey = key !== null && key !== undefined;
    // Tier 1: value exact, then all canonical resolved_model matches
    if (hasConcreteKey) {
      const activeModels = findCatalogEntries(key);
      if (activeModels.length > 0) {
        const seen = new Set(effortLevelsForCatalogEntries(activeModels));
        return EFFORT_ORDER.filter((l) => seen.has(l));
      }
    }
    // Tier 2: real default alias entry
    const realDefault = models.find((m) => m.value === "default");
    if (realDefault !== undefined) {
      const seen = new Set(realDefault.effort_levels ?? []);
      return EFFORT_ORDER.filter((l) => seen.has(l));
    }
    // Tier 4 (藤 G1): concrete key で exact miss かつ real default 無し
    // → [] fail-closed (intersection にフォールバックしない)
    if (hasConcreteKey) return [];
    // Tier 3: key 未報告のみ intersection fail-closed
    if (models.length === 0) return [];
    const first = models[0];
    if (first === undefined || first.effort_levels === undefined) return [];
    const rest = models.slice(1);
    const common = new Set(
      first.effort_levels.filter((lvl) =>
        rest.every(
          (m) =>
            m.effort_levels !== undefined && m.effort_levels.includes(lvl),
        ),
      ),
    );
    return EFFORT_ORDER.filter((l) => common.has(l));
  });

  // The always-present seven_day placeholder (pct null) must not, by itself,
  // open the panel for a non-Claude-Code agent — require real meta or a rate
  // window that actually has data. Also open it when switch choices exist, so
  // the model / effort switch rows render even if ext.models lands before
  // ext.model (the list is a separate one-shot fetch, host #statusExt).
  const hasCcStatus = $derived(
    ccModel !== null ||
      ccCwd !== null ||
      ccPermissionMode !== null ||
      ccFastMode !== null ||
      ctxPct !== null ||
      effectiveNetworkAccess !== null ||
      ccRateRows.some((r) => r.pct !== null) ||
      models.length > 0 ||
      // Operator can always pick a permission mode (#58), even before init
      // lands ext.permission_mode — keep the panel open so the dropdown is
      // reachable without waiting for the first turn.
      connection !== null,
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

  // #184: render only the most recent LOG_WINDOW_SIZE entries by default.
  // `logs` (full history, App.svelte's memory) is unchanged; only the DOM
  // render is windowed here. Unbounded per-entry DOM (markdown HTML +
  // mermaid SVG) made the composer's in-flow layout (e.g. the slash-menu
  // insertion) scale with total history length, degrading input latency.
  // 200 is a round number comfortably above a screenful while keeping DOM
  // growth bounded.
  //
  // ふじ round-1 must-fix M1: the window MUST be a stable absolute start
  // index, not a "keep last N" count — a count re-derives its start from
  // `logs.length` on every render, so an expanded/jumped-to state silently
  // un-expands the moment a new envelope appends.
  //
  // ふじ round-2 must-fix M1: a frozen window needs to know WHY it froze.
  // A reading-freeze (operator scrolled away mid-read, or jumped to a
  // target) is incidental — once they return to the bottom it should
  // resume tracking the tail, or a long-lived session mid-read once slowly
  // regrows to the full unbounded render the fix was meant to remove. An
  // explicit "show all" click is a deliberate request and must NOT
  // silently collapse back. `frozenWindow`: null = track the tail
  // dynamically (last LOG_WINDOW_SIZE); non-null = a fixed absolute start
  // appends cannot move, tagged with which of the two reasons froze it.
  // `anchorLength` (ふじ round-3 S1) is the most recently CONFIRMED
  // `logs.length` for a reading-freeze — a reading-freeze is stale not only
  // once its `start` falls out of bounds but on any shrink relative to this
  // anchor (history clear/reset can reorganize a transcript without
  // necessarily pushing `start` past the new length). While this agent is
  // actively being viewed, the scroll $effect refreshes `anchorLength` on
  // every legitimate append (ふじ round-4 S1), so a live "freeze at 1000 ->
  // append to 1050 -> shrink to 1020" sequence is still caught even though
  // 1020 is above the ORIGINAL freeze point. Known gap: a background agent
  // whose logs shrink-then-regrow (or get replaced at the same length)
  // while it is NOT the active view cannot be detected this way — only a
  // stable entry-key check at the frozen boundary would catch that, which
  // is a larger change than a length count; see the shrink-invalidation
  // check in the scroll $effect for both paths.
  const LOG_WINDOW_SIZE = 200;
  let frozenWindow = $state<
    | {
        start: number;
        mode: "reading-frozen" | "explicit-expanded";
        anchorLength: number;
      }
    | null
  >(null);
  const effectiveWindowStart = $derived(
    frozenWindow !== null
      ? Math.min(frozenWindow.start, logs.length)
      : Math.max(0, logs.length - LOG_WINDOW_SIZE),
  );
  const visibleLogs = $derived(logs.slice(effectiveWindowStart));
  const hiddenLogCount = $derived(effectiveWindowStart);

  // Expand the window to include `absoluteIndex` (a `logs[]` index) if it is
  // currently hidden, else no-op. Shared by the timeline jump (#122) and the
  // tool_use/tool_result partner jump (#40, ふじ round-1 S1) so both use the
  // same "expand -> tick -> query DOM" sequence instead of duplicating it.
  // A jump target is a reading-freeze (see frozenWindow above) — it reverts
  // once the operator scrolls back to the bottom.
  //
  // ふじ round-4 should-fix S2: `effectiveWindowStart` reads `frozenWindow`,
  // so calling this from inside the main scroll $effect (the #122 path)
  // registered `frozenWindow` as one of THAT effect's tracked dependencies
  // whenever a timeline target was pending — an unrelated later write to
  // `frozenWindow` (e.g. handleLogScroll) could then re-trigger the whole
  // effect and double-run its renderMermaidIn/scroll continuation before
  // `handledTimelineScrollTarget` had a chance to settle. untrack here for
  // the same reason the effect's own shrink-guard read is untracked.
  function ensureIndexVisible(absoluteIndex: number): void {
    const start = untrack(() => effectiveWindowStart);
    if (absoluteIndex >= 0 && absoluteIndex < start) {
      frozenWindow = {
        start: absoluteIndex,
        mode: "reading-frozen",
        anchorLength: logs.length,
      };
    }
  }

  // Reveal the remaining (earlier) history at once (fixed start=0, stable
  // under further appends — M1). Captures scroll height before the DOM
  // grows, re-renders mermaid diagrams newly in view (round-1 must-fix M3 —
  // the main $effect below only renders diagrams for the CURRENT logs.length
  // dependency, which does not change here), then restores the visual
  // offset against the POST-mermaid height so the prepend does not jump the
  // viewport (#184). Kept independent of the pin/restore $effect below
  // (different trigger, no shared state write).
  //
  // ふじ round-2 must-fix M3: capture the agent this click was for and
  // re-check it after every await. AgentDetail is a single reused instance
  // (props change, it does not remount) — if the operator switches agents
  // mid-flight, `logEl`/`envelope.agent_id` now belong to a DIFFERENT
  // agent, and applying this scroll delta / writing scrollMemory under the
  // CURRENT agent_id would corrupt that other agent's state.
  async function showEarlierLogs(): Promise<void> {
    const el = logEl;
    const agentId = envelope.agent_id;
    if (!el) return;
    const prevScrollHeight = el.scrollHeight;
    const prevScrollTop = el.scrollTop;
    frozenWindow = { start: 0, mode: "explicit-expanded", anchorLength: logs.length };
    await tick();
    if (logEl !== el || envelope.agent_id !== agentId) return;
    try {
      await renderMermaidIn(el);
    } catch (error) {
      console.error("mermaid render failed", error);
    }
    if (logEl !== el || envelope.agent_id !== agentId) return;
    el.scrollTop = prevScrollTop + (el.scrollHeight - prevScrollHeight);
    // ふじ round-1 must-fix M2: unlike a scroll-driven freeze (handled inside
    // handleLogScroll), this expansion has no scroll event of its own to
    // persist it — without this, switching agents right after clicking
    // "show all" (before any manual scroll) would restore `frozenWindow:
    // null` and silently re-collapse to the tail.
    scrollMemory.set(agentId, {
      top: el.scrollTop,
      stick: stickToBottom,
      frozenWindow,
    });
  }

  // Blind-spot: other agents needing attention while this detail hides the
  // grid (ADR-0012 F8). Colour follows the most urgent: error first.
  const attention = $derived(
    Object.values(agents).filter(
      (e) =>
        e.agent_id !== envelope.agent_id &&
        (e.state === "error" ||
          e.state === "waiting_permission" ||
          e.state === "waiting_question"),
    ),
  );
  const attentionTone = $derived(
    attention.some((e) => e.state === "error")
      ? "error"
      : attention.some((e) => e.state === "waiting_permission")
        ? "waiting_permission"
        : "waiting_question",
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
  // progress (0..1) is updated by uploadFile's onProgress so the chip can
  // show a mini bar for the in-flight upload; 0 means not yet started.
  type StagedEntry = { id: string; file: File; progress: number };
  let stagedFiles = $state<StagedEntry[]>([]);
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

  // Retry button (#128 round 2 must-fix 3): in-flight guard for the per-turn
  // retry button. Keyed by conversationEntryKey(env) so multiple errored
  // turns can each show their own button in independent states. Matches the
  // uploading/interrupting/stopping pattern elsewhere in this file.
  let retryingKeys = $state<ReadonlySet<string>>(new Set());
  async function retryPrompt(
    entryKey: string,
    agentId: string,
    text: string,
  ): Promise<void> {
    if (retryingKeys.has(entryKey) || !connection) return;
    retryingKeys = new Set([...retryingKeys, entryKey]);
    try {
      await connection.sendInstruction(agentId, text);
    } catch (err) {
      // 送信失敗 (forbidden / unknown_agent / timeout): 現状 AgentDetail に
      // toast 機構がないので console.warn。sendInstruction reject は
      // instruction_rejected server push とは別経路 (server ack 失敗のみ)。
      console.warn("retry failed:", err);
    } finally {
      const next = new Set(retryingKeys);
      next.delete(entryKey);
      retryingKeys = next;
    }
  }

  // Restore is offered for any disconnected agent (#22, ADR-0014); it sits
  // in the terminate button's slot (the two never show at once — terminate
  // is hidden once disconnected). The server fills the resume session_id
  // from its SessionPointer, so we no longer gate on client-side session_id;
  // a missing pointer is surfaced via spawnError (ADR-0030 D8).
  const canRestore = $derived(envelope.state === "disconnected");
  let restoring = $state(false);

  // Resume-swap picker (ADR-0014): offered for both live and disconnected
  // agents. cwd is resolved server-side from the SessionPointer (seeded at
  // spawn), so the button no longer waits on envelope.ext.cwd — a live agent
  // whose wrapper has not yet emitted ext still enumerates. The existing
  // "復帰" button (one-shot, latest session) is kept for disconnected agents
  // as the quick path; this picker is the "pick a specific session" path.
  const canResumeSession = $derived(connection !== null);
  let resumePickerOpen = $state(false);
  let resuming = $state(false);
  // Error message from the last enumerate attempt (e.g. no_session for an
  // agent whose SessionPointer never recorded a cwd — a wrapper that joined
  // without being spawned through this server). Cleared on a new attempt.
  let resumeError = $state<string | null>(null);
  // The agent_id whose candidates the current `sessions` singleton refers
  // to. host_id alone is not enough: two agents on the same host share it,
  // so a stale reply from a previous picker open on agent A could otherwise
  // appear in agent B's list — the operator would then click a session that
  // belongs to A's cwd, not B's. This tightens the filter so a reply is
  // shown ONLY if it was requested for the currently-viewed agent.
  let resumeReplyAgentId = $state<string | null>(null);
  const resumeCandidates = $derived.by(() => {
    if (!sessions) return [];
    if (resumeReplyAgentId !== envelope.agent_id) return [];
    if (sessions.host_id !== hostIdFromAgentId(envelope.agent_id)) return [];
    return sessions.sessions;
  });
  // Re-fetch candidates whenever the picker opens; the reply lands on
  // App.svelte via onSessions and flows back through the `sessions` prop.
  // Track which agent the reply belongs to and surface rejection reasons
  // (no_session for an agent with no SessionPointer cwd, etc.).
  $effect(() => {
    if (!resumePickerOpen || !connection) return;
    const requestedAgentId = envelope.agent_id;
    // The previous reply is not for this request until the fresh one lands;
    // resumeReplyAgentId is bumped only on success below.
    resumeReplyAgentId = null;
    resumeError = null;
    void connection.enumerateAgentSessions(requestedAgentId).then(
      () => {
        // Only claim the singleton reply if we're still viewing the same
        // agent (the operator may have switched away mid-flight).
        if (envelope.agent_id === requestedAgentId) {
          resumeReplyAgentId = requestedAgentId;
        }
      },
      (err) => {
        if (envelope.agent_id === requestedAgentId) {
          resumeError =
            err instanceof Error ? err.message : "候補を取得できませんでした。";
        }
      },
    );
  });
  // Close the picker + drop stale reply attribution on agent switch (the
  // component is reused, not re-keyed).
  let resumePickerAgentId = untrack(() => envelope.agent_id);
  $effect(() => {
    if (envelope.agent_id !== resumePickerAgentId) {
      resumePickerAgentId = envelope.agent_id;
      resumePickerOpen = false;
      resumeReplyAgentId = null;
      resumeError = null;
    }
  });

  // Collapsed state of the permission / question docks (#46, #78). Both sit
  // in-flow and push the log up rather than overlaying it; collapsing swaps the
  // full panel for a one-line bar so the operator can reclaim log height when a
  // small screen or large text zoom makes the pushed-up log too short to read.
  // A fresh request (new request_id) always re-expands, so a pending decision
  // is never hidden by a stale collapsed state from an earlier one.
  let permMinimized = $state(false);
  let questionMinimized = $state(false);
  $effect(() => {
    void permission?.request_id;
    permMinimized = false;
  });
  $effect(() => {
    void question?.request_id;
    questionMinimized = false;
  });

  // --- model / effort switch (#54) ------------------------------------------
  // Popover state for the two switch buttons. selectedEffort is the operator's
  // last pick this session: the SDK does not report the active effort, so it
  // cannot be read off ext like the model (ext.model). It is client-side and
  // shows "既定" until the operator first chooses one.
  let modelMenuOpen = $state(false);
  let effortMenuOpen = $state(false);
  let permMenuOpen = $state(false);
  let selectedEffort = $state<string | null>(null);
  // Closed enum of SDK permission modes (#58). Keep the order issue-spec
  // friendly: default (safest) first, bypass last.
  const PERMISSION_MODE_VALUES = [
    "default",
    "acceptEdits",
    "plan",
    "dontAsk",
    "auto",
    "bypassPermissions",
  ] as const;
  // Optimistic perm label shown the instant the operator picks: ext.permission_mode
  // (the authoritative SDK echo) catches up after the SDKStatusMessage, so this
  // bridges the gap. Cleared once ext changes, on agent switch, or on dispose.
  let pendingPerm = $state<string | null>(null);
  let lastCcPerm = untrack(() => ccPermissionMode);
  $effect(() => {
    if (ccPermissionMode !== lastCcPerm) {
      lastCcPerm = ccPermissionMode;
      pendingPerm = null;
    }
  });
  const permLabel = $derived(pendingPerm ?? ccPermissionMode);
  // The label the switcher button actually shows: "default" is the SDK's own
  // fallback when no mode has been reported yet (ext.permission_mode absent).
  // Task 15-10 pins the two-axis annotation onto the SELECTED label, so the
  // guard must key off the label that renders — not raw permLabel, which
  // would suppress the badge for that first-frame default case.
  const displayPermLabel = $derived(permLabel ?? "default");
  // ADR-0034 F1/F3: session-level capability advertise. Consumers here are
  // fail-closed — a null / absent capability envelope disables the feature
  // rather than defaulting to "permitted". Both adapters currently advertise
  // unconditional true; the judge for user_input_dialog is future-proofing
  // for D5 (Free plan / user_input_modes) without another UI rewrite.
  const sessionCaps = $derived(sessionCapabilitiesFrom(envelope));
  const switchState = $derived(modelSwitchStateFrom(envelope));
  const modelSwitchSupported = $derived(
    sessionCaps?.supports_model_switch === true,
  );
  const effortSwitchSupported = $derived(
    sessionCaps?.supports_effort_switch === true,
  );
  const attachmentTypes = $derived(sessionCaps?.attachment_types);
  const attachmentsSupported = $derived(
    sessionCaps?.supports_attachments === true &&
      (attachmentTypes === undefined || attachmentTypes.length > 0),
  );
  const imagesOnlyAttachments = $derived(
    attachmentTypes !== undefined &&
      attachmentTypes.length === 1 &&
      attachmentTypes[0] === "image",
  );
  const attachmentAccept = $derived(
    attachmentTypes === undefined
      ? "image/png,image/jpeg,image/webp,image/gif,text/*,application/json,application/xml,application/yaml,application/x-yaml,application/javascript,application/typescript,application/sql,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "image/*",
  );
  const dialogAvailability = $derived(
    userInputDialogAvailability(sessionCaps, displayPermLabel),
  );
  // Handle lamp for the status sheet (phase-31 31-6): while the sheet is
  // open the in-flow permission/question docks sit behind it, so the
  // current agent's pending decision must stay noticeable on the handle
  // (responsive-layout.md MUST). Mirrors the dock render gates.
  const sheetPendingTone = $derived(
    permission
      ? "waiting_permission"
      : question && dialogAvailability !== "unsupported"
        ? "waiting_question"
        : null,
  );
  // Optimistic model selection shown the instant the operator switches:
  // ext.model (which may be the authoritative resolved id) only catches up
  // a turn later, so without this the model row stays on the old value until
  // the next reply (#54). Cleared once ext.model actually changes, or on
  // agent switch.
  let pendingModel = $state<{ value: string; label: string } | null>(null);
  let lastCcModel = untrack(() => ccModel);
  $effect(() => {
    if (ccModel !== lastCcModel) {
      lastCcModel = ccModel;
      pendingModel = null;
    }
  });
  const modelCatalogKey = $derived(pendingModel?.value ?? ccModel);
  const activeModels = $derived.by(() => findCatalogEntries(modelCatalogKey));
  // A unique canonical match can name its alias. Multiple aliases resolving
  // to one canonical ID are intentionally ambiguous, so render raw key and
  // leave every menu row unselected.
  const activeModel = $derived(
    activeModels.length === 1 ? activeModels[0] : undefined,
  );
  const resolvedModel = $derived(
    typeof activeModel?.resolved_model === "string" &&
      activeModel.resolved_model.length > 0
      ? activeModel.resolved_model
      : null,
  );
  // New catalog metadata exposes the selectable alias as primary and its
  // canonical ID as supporting context. Without that metadata retain the
  // established friendly pending label (notably Codex's `pending: Sol`).
  const modelPrimary = $derived(
    resolvedModel !== null
      ? activeModel?.value ?? modelCatalogKey
      : pendingModel?.label ?? activeModel?.value ?? modelCatalogKey,
  );
  const effectiveEffort = $derived.by(() => {
    const raw = envelope.ext?.effective;
    if (typeof raw !== "object" || raw === null) return null;
    const value = (raw as Record<string, unknown>).effort;
    return typeof value === "string" ? value : null;
  });
  let pendingEffort = $state<string | null>(null);
  let switchNotice = $state<{ tone: "info" | "error"; text: string } | null>(null);
  let lastEffectiveEffort = untrack(() => effectiveEffort);
  $effect(() => {
    if (effectiveEffort !== lastEffectiveEffort) {
      lastEffectiveEffort = effectiveEffort;
      pendingEffort = null;
      selectedEffort = effectiveEffort;
    }
  });
  let sawEffortReset = false;
  $effect(() => {
    const reset = switchState.effort_reset;
    if (reset && !sawEffortReset) {
      selectedEffort = null;
      pendingEffort = null;
      switchNotice = {
        tone: "info",
        text: "新モデルで元の effort が使えないため既定へ戻しました",
      };
    }
    sawEffortReset = reset;
  });
  // Catalog fetch cap indicator (ADR-0037 F6, phase-18-6/18-10). Persistent
  // state — the wrapper stays on the floor default until refresh_models
  // succeeds — so read it once and route it to two surfaces with different
  // lifetimes: (a) a persistent class on the ↻ button so the operator sees
  // "still broken" even after switchNotice is cleared by an unrelated click,
  // and (b) a rising-edge transient toast via switchNotice for the "just
  // now hit the cap" alert. Losing (a) is what an rising-edge-only design
  // would do: click ↻ → notice cleared → retry fails → tracker=true still,
  // no re-fire → operator sees nothing on the moment they most need it.
  // Defensive engine gate: host derive is Claude-only, but a bug (or a
  // future adapter) accidentally stamping models_error on a codex envelope
  // must NOT surface a Claude-specific message on the codex UI.
  const modelsError = $derived(
    envelope.ext?.models_error === true && agentEngine === "claude-code",
  );
  let sawModelsError = false;
  $effect(() => {
    if (modelsError && !sawModelsError) {
      switchNotice = {
        tone: "error",
        text: "モデル一覧の取得に繰り返し失敗しています。切替 button 隣の ↻ から再取得を試みてください",
      };
    }
    sawModelsError = modelsError;
  });
  // Reset the popovers + the optimistic picks when the detail switches to a
  // different agent (the component is reused, not re-keyed, in App.svelte).
  let switchAgentId = untrack(() => envelope.agent_id);
  $effect(() => {
    if (envelope.agent_id !== switchAgentId) {
      switchAgentId = envelope.agent_id;
      selectedEffort = null;
      pendingEffort = null;
      switchNotice = null;
      pendingModel = null;
      pendingPerm = null;
      modelMenuOpen = false;
      effortMenuOpen = false;
      permMenuOpen = false;
    }
  });
  // Close all popovers on a click outside any switch box.
  $effect(() => {
    if (!modelMenuOpen && !effortMenuOpen && !permMenuOpen) return;
    function onDocClick(event: MouseEvent): void {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".cc-switchbox")) {
        modelMenuOpen = false;
        effortMenuOpen = false;
        permMenuOpen = false;
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });

  function toggleModelMenu(): void {
    effortMenuOpen = false;
    permMenuOpen = false;
    modelMenuOpen = !modelMenuOpen;
  }
  function toggleEffortMenu(): void {
    modelMenuOpen = false;
    permMenuOpen = false;
    effortMenuOpen = !effortMenuOpen;
  }
  function togglePermMenu(): void {
    modelMenuOpen = false;
    effortMenuOpen = false;
    permMenuOpen = !permMenuOpen;
  }
  let refreshingModels = $state(false);
  function refreshModels(): void {
    if (!connection) return;
    if (refreshingModels) return;
    // ADR-0039 F9 v2 = 藤 review D2a: the returned promise now resolves
    // ONLY when the wrapper's paired refresh_models_result envelope
    // arrives, not on the mere server ack. That means:
    //  - the button loading stays up until the actual refresh completes,
    //    matching what the user just observed happen (or fail);
    //  - a failure surfaces `result.reason` verbatim rather than an ack
    //    error, letting the operator see WHY the wrapper's probe failed.
    // The wrapper also emits a state_change with fresh ext.models BEFORE
    // this promise settles, so the same AgentDetail's model/effort switch
    // repopulates without waiting for a natural state transition — which
    // is exactly what fresh-idle wrappers otherwise never trigger.
    refreshingModels = true;
    switchNotice = null;
    void run(async () => {
      try {
        const result = await connection.refreshModels(envelope.agent_id);
        if (!result.ok) {
          switchNotice = {
            tone: "error",
            text: `モデル一覧の再取得に失敗: ${result.reason ?? "unknown"}`,
          };
        }
      } catch (error) {
        // Reject path covers server ack failure / transport disconnect /
        // client-side timeout — surfaced the same as an ok=false result.
        switchNotice = {
          tone: "error",
          text: `モデル一覧の再取得に失敗: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        refreshingModels = false;
      }
    });
  }
  function chooseModel(value: string): void {
    modelMenuOpen = false;
    if (!connection) return;
    if (value === activeModel?.value) return;
    // Reflect the alias immediately while the authoritative ext.model catches
    // up; the value sent to the wrapper remains this catalog alias.
    const choice = findCatalogEntries(value)[0];
    pendingModel = { value, label: choice?.display_name ?? value };
    switchNotice = null;
    void run(async () => {
      try {
        await connection.setModel(envelope.agent_id, value);
      } catch (error) {
        pendingModel = null;
        throw error;
      }
    });
  }
  function chooseEffort(level: string): void {
    effortMenuOpen = false;
    if (!connection) return;
    if (level === effectiveEffort) return;
    pendingEffort = level;
    switchNotice = null;
    void run(async () => {
      try {
        await connection.setEffort(envelope.agent_id, level);
      } catch (error) {
        pendingEffort = null;
        throw error;
      }
    });
  }
  // Host-advertised pending/error metadata is authoritative. Local optimistic
  // state only bridges the channel round trip after the operator clicks.
  $effect(() => {
    if (switchState.pending_model !== null) {
      const choice = findCatalogEntries(switchState.pending_model)[0];
      pendingModel = {
        value: switchState.pending_model,
        label: choice?.display_name ?? switchState.pending_model,
      };
    }
    if (switchState.pending_effort !== null) {
      pendingEffort = switchState.pending_effort;
    }
    const failure = switchState.switch_error;
    if (failure !== null) {
      pendingModel = null;
      pendingEffort = null;
      // ADR-0037 F8 (phase-18-7 / 18-10): the persist-alias fallback is not
      // an operator-initiated switch failure — the wrapper silently swapped
      // a stale persisted alias for the SDK default at startup. Frame it as
      // an info-level notice so operators do not read "action required"
      // into an automatic safe recovery. tone:"error" stays for genuine
      // switch failures (turn_failed etc.).
      if (failure.reason === "persist_alias_unknown") {
        switchNotice = {
          tone: "info",
          text: `保存されていた ${failure.requested} は現在の catalog にないので default で開始しました`,
        };
      } else {
        const rollbackTarget =
          failure.rolled_back_to ??
          (failure.kind === "model" ? ccModel : effectiveEffort);
        switchNotice = {
          tone: "error",
          text: `${failure.kind === "model" ? "モデル" : "effort"}切替に失敗: ${failure.requested} は実効に反映されていません (reason: ${failure.reason})。${rollbackTarget ? `旧値 ${rollbackTarget} に` : "最後に成功した値に"}戻しました`,
        };
      }
    }
  });
  function choosePermissionMode(value: string): void {
    permMenuOpen = false;
    if (!connection) return;
    // bypassPermissions is a 2-step pick (#58 issue body): confirm before
    // sending so a misclick never silently turns off every tool guard. The
    // SDK additionally requires the wrapper to have been started with
    // allowDangerouslySkipPermissions:true; a wrapper started without it
    // rejects mid-session bypass — that surfaces as the usual run() error
    // path, no special handling here.
    if (value === "bypassPermissions") {
      const ok = window.confirm(
        "bypassPermissions: 全ツール許可を即時バイパスします。続行しますか?",
      );
      if (!ok) return;
    }
    pendingPerm = value;
    void run(() => connection.setPermissionMode(envelope.agent_id, value));
  }
  // tool_use_id under the pointer, so its tool_use and tool_result both
  // highlight while hovered (#40).
  let hoveredTool = $state<string | null>(null);
  let logEl = $state<HTMLDivElement | null>(null);
  const TIMELINE_SCROLL_TOP_GAP_PX = 24;
  // A target near the end needs temporary scrollable room below it; otherwise
  // the browser clamps at the transcript's bottom and cannot place it 24px
  // below the top edge. This is reset for ordinary detail navigation.
  let timelineScrollTailPx = $state(0);
  let handledTimelineScrollTarget: string | null = null;

  function resetTimelineScrollTail(): void {
    timelineScrollTailPx = 0;
    logEl?.style.setProperty("--timeline-scroll-tail", "0px");
  }

  async function scrollToTimelineEntry(targetKey: string): Promise<boolean> {
    if (!logEl) return false;
    const findEntry = (): HTMLElement | undefined =>
      [...logEl!.querySelectorAll<HTMLElement>("[data-envelope-key]")].find(
        (candidate) => candidate.dataset.envelopeKey === targetKey,
      );
    const entry = findEntry();
    if (!entry) {
      // clear/reset can remove a previously selected target. Do not leave
      // its temporary scroll room behind on the next ordinary transcript.
      resetTimelineScrollTail();
      return false;
    }

    // Start from natural content height. A previous near-tail target may have
    // left temporary padding in place; including it would under/over-estimate
    // the next target's needed tail.
    resetTimelineScrollTail();
    const entryTop =
      entry.getBoundingClientRect().top - logEl.getBoundingClientRect().top +
      logEl.scrollTop;
    const desiredTop = Math.max(0, entryTop - TIMELINE_SCROLL_TOP_GAP_PX);
    const naturalMaxTop = Math.max(0, logEl.scrollHeight - logEl.clientHeight);
    // Existing content below the row already supplies some scroll range;
    // append only the shortfall rather than a whole viewport for every row.
    const tailPx = Math.max(0, desiredTop - naturalMaxTop);
    timelineScrollTailPx = tailPx;
    // Svelte の次の DOM flush を待たず、padding を即時反映して末尾行でも
    // scroll range を確保する。state も同時に更新するので以後の re-render
    // では同じ値が維持される。
    logEl.style.setProperty("--timeline-scroll-tail", `${tailPx}px`);
    const settledEntry = findEntry();
    if (!settledEntry) return false;
    const top = Math.max(
      0,
      settledEntry.getBoundingClientRect().top - logEl.getBoundingClientRect().top +
        logEl.scrollTop -
        TIMELINE_SCROLL_TOP_GAP_PX,
    );
    logEl.scrollTo({ top, behavior: "smooth" });
    stickToBottom = false;
    scrollMemory.set(envelope.agent_id, { top, stick: false, frozenWindow });
    return true;
  }

  // Pin-to-bottom intent: true while the operator is reading the tail of
  // the log, false once they scroll up to inspect earlier output. The
  // auto-scroll effect honours this so a reply landing mid-read no longer
  // yanks the viewport away. Initial true so an empty log starts pinned.
  let stickToBottom = $state(true);
  const STICK_THRESHOLD_PX = 8;

  // Per-agent scroll memory: the detail is reused across agents, so without
  // this the log's scroll position (and pin intent) would carry over to the
  // next agent. Keyed by agent_id, updated on every scroll and restored on
  // switch. Plain Map (not $state) — it is read/written imperatively, never
  // rendered. `scrollAgent` tracks which agent the log currently reflects so
  // the auto-scroll effect can tell a switch from a same-agent log update.
  // `frozenWindow` travels with top/stick (ふじ round-1 must-fix M2):
  // without it, switching back to an agent with >200 entries restores a raw
  // pixel `top` against a freshly-collapsed 200-entry window, which the
  // browser silently clamps to a smaller max scrollTop — landing near the
  // bottom instead of the remembered position.
  const scrollMemory = new Map<
    string,
    {
      top: number;
      stick: boolean;
      frozenWindow:
        | {
            start: number;
            mode: "reading-frozen" | "explicit-expanded";
            anchorLength: number;
          }
        | null;
    }
  >();
  let scrollAgent = untrack(() => envelope.agent_id);

  function handleLogScroll(): void {
    if (!logEl) return;
    const distance = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
    stickToBottom = distance <= STICK_THRESHOLD_PX;
    if (stickToBottom) {
      // ふじ round-2 must-fix M1: only a reading-freeze (incidental — the
      // operator scrolled away to read, or jumped to a target) reverts to
      // the tail once they return to the bottom. An explicit "show all" is
      // a deliberate request and must not silently collapse back.
      if (frozenWindow?.mode === "reading-frozen") {
        frozenWindow = null;
      }
    } else if (frozenWindow === null) {
      // ふじ round-1 must-fix M2 (2nd half): once the operator scrolls away
      // from the tail to read older entries, freeze the window at its
      // current boundary. Left dynamic, a streaming append would keep
      // advancing `effectiveWindowStart` and silently evict the very rows
      // they are reading, with no scroll compensation (unlike the explicit
      // showEarlierLogs expand, which does compensate).
      frozenWindow = {
        start: effectiveWindowStart,
        mode: "reading-frozen",
        anchorLength: logs.length,
      };
    }
    scrollMemory.set(envelope.agent_id, {
      top: logEl.scrollTop,
      stick: stickToBottom,
      frozenWindow,
    });
  }

  // Render any new mermaid diagrams (#42), then position the transcript. On a
  // same-agent log update, keep it pinned to the latest line IF the operator
  // was already at the bottom (stickToBottom). On an agent switch, restore that
  // agent's remembered scroll position instead (#…), defaulting an unseen agent
  // to the bottom. (Diagrams change the scroll height, so scroll after.)
  $effect(() => {
    void logs.length;
    const agentId = envelope.agent_id;
    const switching = scrollAgent !== agentId;
    // ふじ round-1 must-fix M2: restore the incoming agent's remembered
    // window state BEFORE the timeline-target check below, so that check
    // (and scrollTop restoration further down) sees the right starting
    // point rather than a window still reflecting the outgoing agent. An
    // unseen agent (no memory) starts fresh (null = tail).
    const mem = switching ? scrollMemory.get(agentId) : undefined;
    // ふじ round-2 must-fix M2 / round-3 M1+S1: history clear/reset
    // (App.svelte onHistoryCleared / onHistoryReset) can SHRINK `logs` — or
    // replace it with a shorter transcript — either for the agent being
    // viewed live, or for an agent whose remembered `mem` we are about to
    // restore. A reading-freeze anchored to a `logs.length` that has since
    // DECREASED is stale even when its `start` still happens to be a valid
    // index (a shrink can reorganize content, not just truncate the tail),
    // so compare against `anchorLength` rather than only bounds-checking
    // `start`. `frozenWindow` is read via untrack: this effect must fire on
    // logs.length / agent_id changes only — reading it tracked made
    // showEarlierLogs's own state write re-trigger this effect too, firing
    // renderMermaidIn a second time for the same click (round-3 M2). An
    // explicit "show all" (start=0) is exempt: it stays valid at any
    // length, including 0.
    const candidateFrozenWindow = switching
      ? (mem?.frozenWindow ?? null)
      : untrack(() => frozenWindow);
    const shrinkInvalidated =
      candidateFrozenWindow !== null &&
      candidateFrozenWindow.mode === "reading-frozen" &&
      logs.length < candidateFrozenWindow.anchorLength;
    if (switching) {
      // A shrink-invalidated mem entry must not resurrect its stale
      // `stick`/`top` either (handled below via `effectiveMem`) — drop it
      // here so a LATER switch back cannot reuse the same stale data.
      if (shrinkInvalidated) scrollMemory.delete(agentId);
      frozenWindow = shrinkInvalidated ? null : candidateFrozenWindow;
    } else if (shrinkInvalidated) {
      // ふじ round-4 must-fix M1: a shrink invalidates the WINDOW, but a
      // reading-freeze also carries a logical "not at the bottom" pin
      // (`stickToBottom`) that a length-only reset does not touch — left
      // false, no future append for this agent auto-follows, even though
      // the window looks like a fresh tail. Treat this exactly like the
      // switching path's `effectiveMem = undefined`: a shrink starts the
      // agent over, defaulting to pinned.
      frozenWindow = null;
      scrollMemory.delete(agentId);
      stickToBottom = true;
    } else if (
      candidateFrozenWindow !== null &&
      candidateFrozenWindow.mode === "reading-frozen" &&
      logs.length > candidateFrozenWindow.anchorLength
    ) {
      // ふじ round-4 should-fix S1: `anchorLength` is fixed at freeze time,
      // so a live "freeze at 1000 -> append to 1050 -> shrink to 1020"
      // sequence went undetected (1020 is still >= the ORIGINAL anchor
      // 1000, even though it IS a shrink from the 1050 this agent actually
      // reached). Refreshing the anchor on every legitimate append means
      // the next shrink check compares against the most recently confirmed
      // length, not the stale original one. This still cannot catch a
      // same-length (or grown) CONTENT replacement while this agent is not
      // being viewed — that would need a stable entry-key check at the
      // frozen boundary, not just a length count; accepted as a known gap
      // for the switching-restore path (see the `mem` comment above).
      frozenWindow = { ...candidateFrozenWindow, anchorLength: logs.length };
    }
    const timelineTarget = scrollToEntryKey;
    if (timelineTarget === null) {
      resetTimelineScrollTail();
      handledTimelineScrollTarget = null;
    }
    const timelineTargetPresent =
      timelineTarget !== null &&
      logs.some((entry) => conversationEntryKey(entry) === timelineTarget);
    if (timelineTarget !== null && !timelineTargetPresent) {
      // history clear/reset can replace a handled row with a same-length
      // transcript. Check membership, not only `logs.length`, so its old
      // tail padding cannot survive that replacement.
      resetTimelineScrollTail();
      handledTimelineScrollTarget = null;
    }
    const shouldScrollTimelineTarget =
      timelineTarget !== null &&
      timelineTargetPresent &&
      timelineTarget !== handledTimelineScrollTarget;
    if (shouldScrollTimelineTarget) {
      // #184: the target row must be in the rendered window before
      // scrollToTimelineEntry can find it via data-envelope-key. Expand
      // synchronously so Svelte flushes the wider window before the tick()
      // below queries the DOM.
      const targetIndex = logs.findIndex(
        (entry) => conversationEntryKey(entry) === timelineTarget,
      );
      ensureIndexVisible(targetIndex);
    }
    // Snapshot synchronously BEFORE the new logs commit: once Svelte renders
    // the new envelopes, scrollHeight grows and a fresh "at the bottom"
    // measurement no longer reflects the operator's prior intent. untrack
    // also prevents this effect from re-firing on every user scroll.
    let shouldStick = untrack(() => stickToBottom);
    let restoreTop: number | null = null;
    if (switching) {
      scrollAgent = agentId;
      // Adopt the incoming agent's pin intent (unseen agent => bottom), and
      // restore its exact offset when it was parked away from the bottom.
      // Its window was already restored above, so a non-stick `mem.top`
      // lands inside a DOM sized to match (not silently clamped by a
      // freshly-collapsed 200-entry window — M2). ふじ round-3 M1: a
      // shrink-invalidated `mem` is treated as fully absent here too — its
      // `stick: false` predates the shrink and would otherwise stick around
      // forever, silently blocking auto-follow on every future arrival for
      // this agent even though the window itself was correctly reset.
      const effectiveMem = shrinkInvalidated ? undefined : mem;
      shouldStick = effectiveMem ? effectiveMem.stick : true;
      stickToBottom = shouldStick;
      restoreTop = effectiveMem && !effectiveMem.stick ? effectiveMem.top : null;
    }
    void tick().then(async () => {
      if (!logEl) return;
      try {
        await renderMermaidIn(logEl);
      } catch (error) {
        console.error("mermaid render failed", error);
      }
      // The component may have unmounted during the await; re-check logEl.
      if (!logEl) return;
      // #122: timeline click has an explicit reading target. Do this before
      // the ordinary pin/restore path so its smooth scroll cannot be
      // overwritten by the default "latest message" position. If history has
      // not arrived yet, leave the target pending; the next logs update tries
      // again with the same envelope identity.
      if (
        shouldScrollTimelineTarget &&
        timelineTarget !== null &&
        (await scrollToTimelineEntry(timelineTarget))
      ) {
        handledTimelineScrollTarget = timelineTarget;
        return;
      }
      if (restoreTop === null && !shouldStick) return;
      // The composer reflows one frame late (e.g. stagedFiles clearing on
      // send), and an in-flow permission/question dock appearing or clearing
      // also resizes .log via flex. Double rAF lets layout settle before the
      // final scroll — otherwise scrollTop=scrollHeight lands a few pixels
      // short of the true bottom (the failure that prompted scrollIntoView
      // previously).
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      if (!logEl) return;
      logEl.scrollTop = restoreTop !== null ? restoreTop : logEl.scrollHeight;
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
    // phase-17 17-8 (ADR-0036 F1): exact `/new`・`/clear` + no attachments
    // + capability=on for the requested mode → route to session_reset
    // control event, not send_instruction. Anything else (引数付き /
    // attachment 付き / capability 未 stamp) falls through as normal.
    // Attachment presence is decided here (stagedFiles is the caller's
    // truth) and the helper is only asked about text + capability.
    const resetTarget =
      stagedFiles.length === 0
        ? shouldInterceptAsSessionReset(text, undefined, sessionCaps)
        : null;
    if (resetTarget !== null) {
      void run(async () => {
        await connection!.sendSessionReset(envelope.agent_id, resetTarget);
        instruction = "";
      });
      return;
    }
    const entries = stagedFiles;
    void run(async () => {
      // Force pin-to-bottom for the user's own send: even if they were
      // scrolled up reading earlier output, hitting send signals intent
      // to see their own line (and the agent's reply) land. The auto-
      // scroll $effect picks this up when the WS echo arrives.
      stickToBottom = true;
      const attachmentIds: string[] = [];
      if (entries.length > 0) {
        // Uploads run sequentially: parallel push would interleave many
        // attach_chunk frames in flight at once, which can exceed the
        // server's transport in-flight cap (file-upload spec). The
        // wall-clock cost is small for the 5 MB / 10-file phase ceiling.
        uploading = true;
        try {
          for (const entry of entries) {
            const uploadId = await connection.uploadFile(
              envelope.agent_id,
              entry.file,
              (uploaded, total) => {
                entry.progress = uploaded / total;
              },
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
      // Scroll-to-bottom is handled by the logs-change $effect above:
      // when the server echoes the user envelope back, the effect sees
      // stickToBottom=true (forced at the start of this send) and runs
      // a layout-settled scrollTop assignment.
    });
  }

  // Shared append path for the file picker AND the drop zone. A fresh
  // interaction clears any stale overflow error from a prior round so the
  // operator does not see a misleading message that no longer applies.
  // Append rather than replace, so successive picker opens / drops build
  // up one tray. The cap is the spec value; any overflow is dropped with
  // a hint so the operator knows not all were staged. The wrapper enforces
  // the same cap server-side and rejects with count_over.
  function addStagedFiles(picked: File[]): void {
    actionError = "";
    // Fail-closed on unsupported sessions (ADR-0034 F1/F3, task 15-15):
    // paste / drop can reach this without going through the disabled attach
    // button, so guard here at the single choke point instead of at each
    // entry. Silent drop when picked is empty (a no-op D&D) — only surface
    // the message when the operator actually tried to stage something.
    if (!attachmentsSupported) {
      if (picked.length > 0) {
        actionError = "このセッションでは添付は未対応です";
      }
      return;
    }
    const allowed = attachmentTypes;
    const accepted = allowed === undefined
      ? picked
      : picked.filter((file) => allowed.includes("image") && file.type.startsWith("image/"));
    const rejectedByType = picked.length - accepted.length;
    if (rejectedByType > 0) {
      actionError = imagesOnlyAttachments
        ? "このセッションでは画像のみ添付できます"
        : "このセッションではこの種類の添付は未対応です";
    }
    const next: StagedEntry[] = [...stagedFiles];
    let dropped = 0;
    for (const f of accepted) {
      if (next.length >= MAX_STAGED) {
        dropped++;
        continue;
      }
      next.push({ id: randomUUID(), file: f, progress: 0 });
    }
    stagedFiles = next;
    if (dropped > 0) {
      actionError = `添付は ${MAX_STAGED} 件まで(${dropped} 件は無視されました)`;
    }
  }

  function onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    addStagedFiles(Array.from(input.files ?? []));
    // The native input's FileList is consumed on read; clearing the
    // value here lets the operator re-pick the same file later if they
    // remove it with ✕ first.
    if (stagedFileInput !== null) stagedFileInput.value = "";
  }

  function removeStagedFile(index: number): void {
    stagedFiles = stagedFiles.filter((_, i) => i !== index);
  }

  // --- D&D drop zone (file-upload spec / ADR-0025 Stage C "i") --------------
  // Scoped to the composer area so a drop on one agent's transcript cannot
  // bleed across to another agent (the spec calls out "複数 agent 間で
  // 曖昧にならない"). The spec also says client は規範を持たない — so we do
  // Type restrictions are capability-derived in addStagedFiles(), so picker,
  // drop, and paste all share the same fail-closed image-only guard.
  let dropActive = $state(false);
  // dragenter / dragleave fire for every child crossing too, so a single
  // boolean would flicker. Counter pattern keeps the highlight stable
  // until the cursor truly leaves the composer.
  let dragDepth = 0;

  // dataTransfer.types is the standardised way to peek at the drag payload
  // BEFORE drop completes (browsers gate the files[] list until then for
  // security). "Files" indicates a file drag from the OS / another tab;
  // selecting text on the page also fires drag events, so we filter.
  function isFileDrag(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (const t of types) if (t === "Files") return true;
    return false;
  }

  function onDragEnter(event: DragEvent): void {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth++;
    dropActive = true;
  }

  function onDragLeave(event: DragEvent): void {
    if (dragDepth === 0) return;
    dragDepth--;
    if (dragDepth === 0) dropActive = false;
  }

  function onDragOver(event: DragEvent): void {
    if (!isFileDrag(event)) return;
    // preventDefault on dragover is what tells the browser this element
    // is a valid drop target — without it the drop never fires.
    event.preventDefault();
  }

  function onDrop(event: DragEvent): void {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropActive = false;
    const picked = Array.from(event.dataTransfer?.files ?? []);
    if (picked.length === 0) return;
    addStagedFiles(picked);
  }

  // Paste handler for the instruction textarea (#86): screenshot / file
  // clipboard contents stage as attachments instead of pasting their text.
  // Discrimination rule (issue confirmed 2026-06-27): if clipboardData
  // carries any File (either clipboardData.files or items where
  // kind==='file'), intercept; otherwise let the browser's default paste
  // happen so normal text / rich-text paste keeps working.
  //
  // files-first / items-fallback (NOT union): Chrome on Windows publishes
  // the same image via BOTH files[] and items[] — often as multiple OS
  // clipboard formats (CF_BITMAP / CF_DIB / image/png) surfaced as separate
  // items entries. A union double-counts because getAsFile() returns a
  // fresh File instance per call, so identity-based dedup cannot collapse
  // them. Firefox image paste does the opposite (items only, files empty).
  // Prefer files when present; fall back to items only when files is empty.
  function onInstructionPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!data) return;
    const fromFiles = Array.from(data.files ?? []);
    const files: File[] = fromFiles.length > 0
      ? fromFiles
      : Array.from(data.items ?? [])
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    event.preventDefault();
    addStagedFiles(files);
  }

  // --- Slash command completion (#34) ---------------------------------------
  // Commands the SDK reported at session init, surfaced via ext. Viewers never
  // see the menu: #46 strips ext for non-operators, so slashCommands is empty.
  let slashTextarea = $state<HTMLTextAreaElement | null>(null);
  let slashIndex = $state(0);
  const slashCommands = $derived.by(() => {
    const raw = envelope.ext?.slash_commands;
    const engineCommands = Array.isArray(raw)
      ? raw.filter((c): c is string => typeof c === "string")
      : [];
    // phase-17 17-8 (ADR-0036 F5): merge kaoiro-local `/new`・`/clear`
    // into the completion pool only when the session advertises support
    // for that mode. Fail-closed on absent / false / conditional-off
    // sessions — the same rule as the send-time intercept, so what
    // appears in the menu matches what the intercept will actually take.
    const localCommands: string[] = [];
    for (const mode of ["new", "clear"] as const) {
      if (shouldInterceptAsSessionReset(`/${mode}`, undefined, sessionCaps) === mode) {
        localCommands.push(mode);
      }
    }
    // De-dupe against engine-reported commands (Claude reports "clear"
    // in its own slash pool; we let the kaoiro-local intercept take
    // precedence per ADR-0036 F5 by keeping our copy first).
    for (const cmd of engineCommands) {
      if (!localCommands.includes(cmd)) localCommands.push(cmd);
    }
    return localCommands;
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
  // its tool_result and vice versa, matched by tool_use_id. ふじ round-1
  // must-fix S1: the partner can be outside the current render window
  // (#184) — expand to its absolute index (the same helper #122 uses)
  // before querying the DOM, or a partner beyond the window silently no-ops.
  async function jumpToTool(
    event: MouseEvent,
    id: string,
    fromKind: string,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation(); // don't toggle the <details> we live inside
    if (!logEl) return;
    const toKind = fromKind === "tool_use" ? "tool_result" : "tool_use";
    const targetIndex = logs.findIndex((entry) => {
      const log = logOf(entry);
      return log?.tool_use_id === id && log?.kind === toKind;
    });
    ensureIndexVisible(targetIndex);
    await tick();
    if (!logEl) return;
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
      `オフラインのエージェント「${name}」を完全に削除します。` +
        `保存された persona / session ポインタ / permission_mode も破棄され、` +
        `以後この agent_id は復元できなくなります。よろしいですか?`,
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

  // Swap the agent to a different session (ADR-0014, resume-swap). For a
  // live agent this cycles the wrapper — mid-work state is lost — so warn
  // first unless it's already idle/done/waiting_input (mirrors stopAgent's
  // gate). Disconnected has no work to lose; skip the confirm.
  function chooseResumeSession(sessionId: string): void {
    if (!connection || resuming || sessionId === "") return;
    if (
      envelope.state !== "disconnected" &&
      !STOP_SAFE_STATES.has(envelope.state)
    ) {
      const liveLabel = expressionFor(envelope.state).label;
      const ok = window.confirm(
        `「${name}」は${liveLabel}です。セッションを切り替えると進行中の作業は失われる可能性があります。続行しますか?`,
      );
      if (!ok) return;
    }
    resumePickerOpen = false;
    void run(async () => {
      resuming = true;
      try {
        await connection.resumeSession(envelope.agent_id, sessionId);
      } finally {
        resuming = false;
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
    <!-- tablet 幅以下では status がボトムシートへ退避する (ADR-0052 F2)。
         desktop では BottomSheet が display:contents になり、aside は従来
         どおり .body の左カラムとして並ぶ (DOM は全サイズ共通 — F6)。
         handle のバッジは blindspot と同じ「一覧へ戻す」を実行する (F3)。
         aside 以下の中身は既存インデントのまま (構造ラップの diff を
         最小に保つ — .status-scroll 導入時と同じ扱い)。 -->
    <BottomSheet
      mode="tablet"
      label="ステータス"
      attentionCount={attention.length}
      {attentionTone}
      onAttention={onClose}
      pendingTone={sheetPendingTone}
    >
    <aside class="status">
      <header class="head">
        <div class="portrait">
          {#key display.shown}
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
          {#if activeTaskCount > 0}
            <!-- 頭上リング (issue #180 follow-up, 2026-08-10 — マスター
                 指摘: AgentCard にはあるが AgentDetail には無かった。
                 実装は TaskRing.svelte(AgentCard と共有)。{#key} の外に
                 置き、state 遷移の影響を受けず単独で回り続ける。
                 .portrait は幅が可変(デスクトップは .status の flex 比率、
                 tablet 以下は max-width: 8rem)なので、軌道半径は rem
                 固定ではなく cqw で .portrait 自身の幅に追随させる(クロエ
                 2026-08-10、.portrait に container-type: inline-size を
                 付与)。cqw の比率換算は sprite 25cqw/9cqw(AgentCard の
                 2rem/8rem, 0.72rem/8rem をそのまま換算)、face
                 17.5cqw/6.3cqw(AgentCard の face は sprite とは別サイズ
                 の 5.4rem 要素なので、face 自身の寸法比 rx=1.35rem/5.4rem
                 =25%・ry=0.49rem/5.4rem≈9.074% を .portrait 幅の 70%
                 (AgentDetail の face 比率)に掛けて導出、ふじ round1
                 N1)。`cqw` は query container の CONTENT box 基準
                 (W3C css-contain-3 仕様 + 実 Chromium で実測検証済み、
                 2026-08-10)なので、`.sprite`(width: 100%、同じく
                 content box 基準)と同じ基準で揃っており、上記比率換算
                 に border-box(padding 込み)とのズレは無い(クロエ
                 round2 で懸念提起 → 検証の結果、対応不要と判明)。

                 min(…, Xrem) キャップ (マスター実機確認 2026-08-10):
                 デスクトップは `.status` が幅可変(flex: 0 0 20%)なので
                 .portrait の実測幅が 8rem を大きく超えることがあり、cqw
                 だけだと軌道が AgentCard の想定サイズより肥大して
                 「グリッドへ戻る」ボタンにまで到達してしまうことを実機
                 確認で発見。AgentCard の絶対値(sprite: 2rem/0.72rem、
                 face: 1.35rem/0.49rem — 既に視認確認済みの既知良好サイズ)
                 を上限にキャップする: 8rem 以下の狭い .portrait では cqw
                 値の方が小さいので従来どおり比例縮小、8rem を超える
                 デスクトップでは rem 値で頭打ちになり AgentCard と同じ
                 絶対サイズに収まる。

                 それでもキャップ後の実測でわずかにはみ出しが残ったため
                 (.portrait の padding が AgentCard の .card ほど広くない
                 ため — 実測で .bar まで 2px しか余裕が無かった)、
                 topOffset="6%" で頭上退避のアンカーを AgentCard 既定の
                 -2% より下げ、リング全体を少し下(顔寄り)へシフトした
                 (顔に多少かかるのは許容、マスター了承済み)。1600px 幅の
                 実測(e2e T11)で .bar から box-shadow の 6px ブラー込みで
                 余裕を確認済み。 -->
            <TaskRing
              faceOrbit={!spriteUrl}
              orbitRx={spriteUrl ? "min(25cqw, 2rem)" : "min(17.5cqw, 1.35rem)"}
              orbitRy={spriteUrl ? "min(9cqw, 0.72rem)" : "min(6.3cqw, 0.49rem)"}
              topOffset="6%"
            />
          {/if}
          <span class="lamp" title={expression.label}></span>
        </div>
        <div class="meta">
          <h2>{name}</h2>
          {#key display.shown}
            <p class="state">{expression.label}</p>
          {/key}
          <!-- name は h2 で既出なので、 id ペインは bare id のままにする
               (name(id) の二重表示は冗長)。一方 inter-agent bubble の peer
               は name(id) 表記でクリック可能、 spawn トーストも name(id)。 -->
          <p class="id">{envelope.agent_id}</p>
        </div>
      </header>

      <!-- Everything below the identity header scrolls inside .status-scroll so
           a too-tall left column scrolls in place instead of growing .detail
           and pushing the whole page (and the log/composer) up. The header
           above stays pinned. (Inner content is intentionally left at its
           original indentation to keep this a 2-line structural wrap.) -->
      <div class="status-scroll">
      {#if hasCcStatus}
        <!-- Claude Code status meta (#16): mirrors the local statusline's
             model / ctx / 5h / 7d segments for this agent. -->
        <dl class="cc">
          {#if connection || modelPrimary || isAccountDefault}
            <div class="cc-row">
              <dt>model</dt>
              <dd>
                <div class="cc-switchbox">
                  <span class="cc-model">
                    {#if pendingModel}pending:{" "}{/if}{#if modelPrimary}{modelPrimary}{#if resolvedModel && resolvedModel !== modelPrimary}<span class="cc-model-resolved">{resolvedModel}</span>{/if}{:else if isAccountDefault}アカウント既定{:else}<span class="cc-pending">確認待ち</span>{/if}
                  </span>
                  {#if connection && modelSwitchSupported && models.length > 0}
                    <button
                      type="button"
                      class="cc-switch"
                      aria-haspopup="listbox"
                      aria-expanded={modelMenuOpen}
                      title="モデルを切替"
                      onclick={toggleModelMenu}
                    >切替</button>
                  {/if}
                  {#if connection && agentEngine === "claude-code"}
                    <button
                      type="button"
                      class="cc-refresh"
                      class:cc-refresh-error={modelsError}
                      aria-label="モデル一覧を再取得"
                      title={modelsError
                        ? "モデル一覧の取得に失敗中。クリックで再取得"
                        : "モデル一覧を再取得"}
                      disabled={refreshingModels}
                      onclick={refreshModels}
                    >↻</button>
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
                            aria-selected={activeModel?.value === m.value}
                            title={m.description}
                            onclick={() => chooseModel(m.value)}
                          >{m.display_name}{#if m.resolved_model}{" "}({m.value} → {m.resolved_model}){/if}</button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </dd>
            </div>
          {/if}
          {#if connection || effectiveEffort !== null || selectedEffort !== null || pendingEffort !== null}
            <!-- #113: display and switch capability are separated so a
                 non-switchable engine still shows its effective effort
                 read-only. Row renders when there is either an operator
                 (connection) or a value to show; the switch button is
                 gated by capability only. -->
            <div class="cc-row">
              <dt>effort</dt>
              <dd>
                <div class="cc-switchbox">
                  <span class="cc-model">
                    {pendingEffort ? `pending: ${pendingEffort}` : selectedEffort ?? effectiveEffort ?? "既定"}
                  </span>
                  {#if connection && effortSwitchSupported && effortLevels.length > 0}
                    <button
                      type="button"
                      class="cc-switch"
                      aria-haspopup="listbox"
                      aria-expanded={effortMenuOpen}
                      title="effort を切替"
                      onclick={toggleEffortMenu}
                    >切替</button>
                  {/if}
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
          {#if switchNotice}
            <div class="cc-row switch-notice" class:error={switchNotice.tone === "error"}>
              <dt>switch</dt>
              <dd>{switchNotice.text}</dd>
            </div>
          {/if}
          {#if ccCwd}
            <div class="cc-row">
              <dt>cwd</dt>
              <dd class="cc-cwd" title={ccCwd}>{ccCwd}</dd>
            </div>
          {/if}
          {#if agentEngine}
            <div class="cc-row">
              <dt>engine</dt>
              <dd>{agentEngine}</dd>
            </div>
          {/if}
          {#if resumeDrift && resumeDrift.length > 0}
            <!-- ADR-0014 F1 addendum (phase-15 D8): resume drift warning.
                 Fires only on the resume path (fresh spawn omits the field
                 entirely; empty array means clean resume). One entry per
                 differing field, showing (prev → now). -->
            <div class="cc-row">
              <dt>resume</dt>
              <dd>
                <span
                  class="drift-badge"
                  title="resume 前後で resolved 設定が変わりました"
                >
                  {#each resumeDrift as d (d.field)}
                    <span class="drift-entry">
                      {d.field}: {fmtDriftValue(d.prev)} → {fmtDriftValue(d.now)}
                    </span>
                  {/each}
                </span>
              </dd>
            </div>
          {/if}
          {#if !isCodexAgent && (ccPermissionMode || connection)}
            <!-- 作業意図 (mode, ADR-0033 F4 追補): the operator's intent
                 expressed as the Claude permission_mode enum. Codex is
                 launch-fixed (ADR-0033 F3) so no picker here. -->
            <div class="cc-row">
              <dt>作業意図</dt>
              <dd>
                {#if connection}
                  <div class="cc-switchbox cc-perm-switchbox">
                    <button
                      type="button"
                      class="cc-switch cc-perm-switch"
                      aria-haspopup="listbox"
                      aria-expanded={permMenuOpen}
                      onclick={togglePermMenu}
                    >
                      {displayPermLabel}
                      {#if PERMISSION_MODE_AXES[displayPermLabel]}
                        <!-- Pin the two-axis reading on the selected label
                             too, not only on the dropdown candidates
                             (phase-15 D2 / task 15-10). -->
                        <span class="axes-hint">
                          書込: {PERMISSION_MODE_AXES[displayPermLabel].sandbox} /
                          承認: {PERMISSION_MODE_AXES[displayPermLabel].approval}
                        </span>
                      {/if}
                    </button>
                    {#if permMenuOpen}
                      <ul
                        class="switch-menu"
                        role="listbox"
                        aria-label="permission mode 候補"
                      >
                        {#each PERMISSION_MODE_VALUES as mode (mode)}
                          <li>
                            <button
                              type="button"
                              role="option"
                              aria-selected={permLabel === mode}
                              onclick={() => choosePermissionMode(mode)}
                            >
                              {mode}
                              {#if PERMISSION_MODE_AXES[mode]}
                                <span class="axes-hint">
                                  書込: {PERMISSION_MODE_AXES[mode].sandbox} /
                                  承認: {PERMISSION_MODE_AXES[mode].approval}
                                </span>
                              {/if}
                            </button>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                {:else}
                  {ccPermissionMode}
                {/if}
              </dd>
            </div>
          {/if}
          {#if permAxes}
            <!-- 実効書込範囲 (sandbox × approval, ADR-0033 F1/F4): engine-
                 neutral two-axis posture. Codex approval is host-fixed to
                 "never" (ADR-0033 F3, tracked in codex-exec-approval-upstream)
                 so we badge it as such for phase-15 D2 / task 15-11. -->
            <div class="cc-row">
              <dt>実効書込範囲</dt>
              <dd>
                <span class="axes-badge">
                  書込: {permAxes.sandbox} /
                  承認: {permAxes.approval}{#if isCodexAgent}<span
                    class="axes-hostfixed"
                    title="upstream 制約 (codex-exec-approval-upstream)"
                  > (host-fixed)</span>{/if}
                </span>
              </dd>
            </div>
          {/if}
          {#if isCodexAgent && effectiveNetworkAccess !== null}
            <!-- Codex OS sandbox の network 軸 (ADR-0033 F3, issue #118):
                 workspace-write sandbox 内での network 許可 toggle。protocol の
                 ResolvedSnapshotExt / ext.effective.network_access と直結で
                 raw boolean を表示。他 engine は stamp しない (typeof gate と
                 isCodexAgent の二重防御)。 -->
            <div class="cc-row">
              <dt>network_access</dt>
              <dd>{effectiveNetworkAccess}</dd>
            </div>
          {/if}
          {#if ccFastMode}
            <div class="cc-row">
              <dt>fast</dt>
              <dd>{ccFastMode}</dd>
            </div>
          {/if}
          {#if sessionCaps?.supports_context_usage === true}
            <!-- capability=true: adapter が stamp する意思あり。値到着で
                 meter、未到着で「取得中」placeholder (ADR-0040 phase-21) -->
            <div class="cc-row">
              <dt>ctx</dt>
              <dd>
                {#if ctxPct === null}
                  <span class="cc-pending">取得中</span>
                {:else}
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
                {/if}
              </dd>
            </div>
          {:else if sessionCaps?.supports_context_usage === false}
            <!-- capability=false: adapter が非対応を宣言 (現状 Codex)。
                 UI は engine 名を見ずこの capability だけで判定
                 (ADR-0034 F3、ADR-0040) -->
            <div class="cc-row">
              <dt>ctx</dt>
              <dd>
                <span class="cc-pending">未対応</span>
              </dd>
            </div>
          {/if}
          <!-- undefined (absent field/caps): 旧 wrapper の rolling upgrade。
               ctx 行そのものを非表示にする — absent を「未対応」扱いにすると
               capability を知らない旧 wrapper で誤誘導になる (M-B) -->

          {#each ccRateRows as r (r.key)}
            <div class="cc-row">
              <dt>{r.label}</dt>
              <dd>
                {#if r.key === "seven_day" && r.pct === null && r.reset === null}
                  <span class="cc-pending">まだ情報がありません</span>
                {:else}
                  <div
                    class="meter"
                    data-status={r.status}
                    title={r.reset ? "リセット " + r.reset : undefined}
                  >
                    <div class="meter-fill" style:width="{r.pct ?? 0}%"></div>
                  </div>
                  <!-- Claude API は status="allowed" (安全圏) では utilization を
                       送らず reset 時刻と status のみを push することがある。
                       ヘビーユーザは reset 時刻を見て次の枠再開を計画するので、
                       hover tooltip ではなく inline に表示する。#164 で /usage
                       から utilization を補完するようになり pct が常時入るように
                       なったため、pct と reset は排他ではなく併記する(pct も
                       reset も無い真の未受信状態のみ "?" にフォールバック)。 -->
                  <span class="meter-val">{rateValueLabel(r)}</span>
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

      {#if connection && canResumeSession}
        <!-- Swap to another session under the same cwd (ADR-0014,
             resume-swap): a live agent's cwd rides ext.cwd, so the picker
             only opens here. Inline candidate list (no modal) — same shape
             as the switch popovers above; disabled while a swap is in
             flight so a double-click cannot double-cycle the wrapper. -->
        <div class="resume-switch">
          <button
            type="button"
            class="resume-swap"
            disabled={resuming}
            aria-haspopup="listbox"
            aria-expanded={resumePickerOpen}
            title="このエージェントを別のセッションから再開する"
            onclick={() => (resumePickerOpen = !resumePickerOpen)}
          >
            {resuming ? "切替中…" : "別のセッションから再開…"}
          </button>
          {#if resumePickerOpen}
            <ul class="resume-menu" role="listbox" aria-label="セッション候補">
              {#if resumeError}
                <li class="empty" role="alert">
                  候補を取得できませんでした ({resumeError})
                </li>
              {:else if resumeCandidates.length === 0}
                <li class="empty">この cwd に再開可能なセッションはありません。</li>
              {:else}
                {#each resumeCandidates as s (s.session_id)}
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={envelope.session_id === s.session_id}
                      title={s.mtime ?? undefined}
                      onclick={() => chooseResumeSession(s.session_id)}
                    >
                      {s.summary ?? s.session_id}{s.mtime
                        ? ` — ${s.mtime}`
                        : ""}
                    </button>
                  </li>
                {/each}
              {/if}
            </ul>
          {/if}
        </div>
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
      </div>
    </aside>
    </BottomSheet>

    <div class="main">
      <div
        class="log"
        bind:this={logEl}
        onscroll={handleLogScroll}
        style={`--timeline-scroll-tail: ${timelineScrollTailPx}px`}
      >
        {#if logs.length === 0}
          <p class="empty">まだ返答はありません。</p>
        {/if}
        {#if hiddenLogCount > 0}
          <!-- #184: render window — only the tail is DOM'd by default. -->
          <button type="button" class="load-earlier" onclick={showEarlierLogs}>
            以前のログを表示 ({hiddenLogCount} 件)
          </button>
        {/if}
        {#each visibleLogs as env, i (env.ts + ":" + (env.seq ?? (effectiveWindowStart + i)))}
          {@const absoluteIndex = effectiveWindowStart + i}
          {@const log = logOf(env)}
          {@const res = resultOf(env)}
          {@const iam = interAgentMessageOf(env)}
          {@const time = formatTime(env.ts)}
          {@const dateLabel = i === 0 ? formatDate(env.ts) : dayDividers.get(absoluteIndex)}
          <div
            class="transcript-entry"
            data-envelope-key={conversationEntryKey(env)}
          >
            {#if dateLabel}
              <div class="day-divider"><span>{dateLabel}</span></div>
            {/if}
            {#if env.type === "session_boundary"}
            <!-- phase-17 17-7 (ADR-0036 F3): session boundary marker. The
                 operator payload carries mode / request_id /
                 previous_session_id / to_session_id; the viewer sees only
                 mode (server sanitize in AgentsChannel.handle_out). Render
                 as a lightweight divider that makes the between-sessions
                 gap visible in the transcript. -->
            {@const bpayload = (env.payload ?? {}) as {
              mode?: string;
              previous_session_id?: string;
              to_session_id?: string | null;
              request_id?: string;
            }}
            <div class="session-boundary">
              <span class="label"
                >── {bpayload.mode === "clear"
                  ? "セッションを消去して新規開始"
                  : "新セッション開始"} ──</span>
              {#if bpayload.request_id}
                <span
                  class="marker-ids"
                  title={`request_id: ${bpayload.request_id}\nfrom: ${
                    bpayload.previous_session_id ?? "(none)"
                  }\nto: ${bpayload.to_session_id ?? "(pending)"}`}
                >
                  {bpayload.request_id.slice(0, 8)}
                </span>
              {/if}
              <time class="ts" datetime={env.ts}>{time}</time>
            </div>
          {:else if iam}
            <!-- inter_agent_message (protocol-inter-agent, phase-8): the same
                 envelope rides on both sender and receiver transcripts; the
                 direction is decided here against the viewer's selected agent.
                 Body is untrusted text — render through DOMPurify (#30) via
                 renderMarkdown so a malicious agent cannot inject HTML.
                 outgoing=true → 自分が送った side (ピンク tone);
                 outgoing=false → ピアから受け取った side (紫 tone). -->
            {@const outgoing = env.agent_id === envelope.agent_id}
            {@const peer = outgoing ? iam.to : env.agent_id}
            <div
              class="msg inter-agent"
              class:outgoing
              class:incoming={!outgoing}
              data-kind={iam.kind}
              data-cid={iam.conversation_id}
            >
              <p class="inter-agent-head">
                {#if outgoing}
                  <span class="arrow" aria-hidden="true">→</span>
                  to
                {:else}
                  <span class="arrow" aria-hidden="true">←</span>
                  from
                {/if}
                {#if onSelectAgent && peer !== "server"}
                  <button
                    type="button"
                    class="peer-link"
                    title="{peer} の詳細を開く"
                    onclick={() => onSelectAgent?.(peer)}
                  >{formatAgentLabel(agents, peer)}</button>
                {:else}
                  <code>{formatAgentLabel(agents, peer)}</code>
                {/if}
                <span class="kind">{iam.kind}</span>
                <span class="cid" title="conversation_id">cid:{iam.conversation_id.slice(0, 8)}</span>
                <span class="turn">t{iam.turn_number}</span>
              </p>
              {@html renderMarkdown(iam.body)}
              <time class="ts" datetime={env.ts}>{time}</time>
            </div>
          {:else if log?.kind === "user"}
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
          {:else if log?.kind === "system"}
            <!-- Session-level event observed by the wrapper (phase-28 A1 /
                 #168): context compaction, conversation reset. Wrapper-
                 authored text, so plain-text rendering — no markdown. -->
            <p class="sysline">
              {log.text ?? ""}
              <time class="ts" datetime={env.ts}>{time}</time>
            </p>
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
            {@const errLabel = res.is_error
              ? errorSubtypeLabel(res.error_subtype)
              : null}
            {@const retryText = res.is_error
              ? findPrecedingUserPrompt(logs, absoluteIndex)
              : null}
            <!-- The reply text already shows as the final assistant log; the
                 result only marks the turn boundary, not a duplicate (#29).
                 On error, issue #127: subtype label (max_turns 等) と SDK 由来
                 detail (errors[] / stop_reason) を併記して原因特定を可能に。
                 issue #128: 直前の user プロンプトを findPrecedingUserPrompt で
                 拾って再送ボタンを表示 (slash command と null は button 非表示)。 -->
            <p class="turn-end" class:error={res.is_error}>
              {res.is_error
                ? errLabel
                  ? `エラーで終了 (${errLabel})`
                  : "エラーで終了"
                : "応答完了"}
              {#if cost !== null}
                <span
                  class="cost"
                  title="API 標準単価での推定値。Claude サブスク利用時は実課金額ではありません(従量 API キー利用時のみ実コストに近い)。セッション開始からの累計。"
                  >累計 ~${cost.toFixed(4)}</span>
              {/if}
              {#if res.is_error && retryText !== null && !retryText.startsWith("/") && connection}
                {@const entryKey = conversationEntryKey(env)}
                {@const isRetrying = retryingKeys.has(entryKey)}
                <button
                  type="button"
                  class="retry"
                  disabled={isRetrying}
                  title="このプロンプトを新規 instruction として再送します (テキストのみ。元の添付ファイルは含まれません)"
                  onclick={() => {
                    void retryPrompt(entryKey, env.agent_id, retryText);
                  }}>{isRetrying ? "再送中…" : "再送"}</button>
              {/if}
              <time class="ts" datetime={env.ts}>{time}</time>
            </p>
            {#if res.is_error && res.error_detail}
              <p class="turn-end-detail">{res.error_detail}</p>
            {/if}
            {/if}
          </div>
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
            title="オフラインエージェントを台帳ごと削除"
          >
            <span class="remove-icon" aria-hidden="true">✕</span>
            {deleting ? "削除中…" : "削除"}
          </button>
        {/if}

        {#if permission}
          <!-- Permission dock (#46): sits in-flow between the transcript and
               the composer, pushing the log up rather than overlaying it, so
               the context stays visible while the operator decides. Collapses
               to a one-line bar to reclaim log height when needed. -->
          {#if permMinimized}
            <button
              type="button"
              class="dock-bar dock-bar-perm"
              title="許可ダイアログを展開"
              onclick={() => (permMinimized = false)}
            >
              <span class="dock-bar-lamp"></span>
              許可待ち(クリックで展開)
            </button>
          {:else}
            <div class="permission-dock">
              <!-- .dock-min lives OUTSIDE .permission-scroll (same shell +
                   scroll-child shape as the question dock) so the short
                   height cap (31-8) can scroll the content without carrying
                   the minimize button out of view. -->
              <button
                class="dock-min"
                type="button"
                title="最小化"
                aria-label="許可ダイアログを最小化"
                onclick={() => (permMinimized = true)}></button>
              <div class="permission-scroll">
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
            </div>
          {/if}
        {/if}

        {#if question && dialogAvailability !== "unsupported"}
          <!-- Question dock (#78, ADR-0027): AskUserQuestion's structured
               choices — radios for single-select, checkboxes for multiSelect,
               plus a free-text "Other" per question. In-flow like the
               permission dock, so it pushes the log up instead of overlaying
               it; scrolls internally when the choices are tall, and collapses
               to a one-line bar to reclaim log height when needed.
               Guarded by session_capabilities.supports_user_input_dialog
               (ADR-0034 F1/F3, phase-15 15-16): defensive — the adapter
               should not have stamped a pending_question if dialog is
               unsupported, but we drop the dock rather than render an
               unusable UI if it did. -->
          {#if questionMinimized}
            <button
              type="button"
              class="dock-bar dock-bar-question"
              title="質問ダイアログを展開"
              onclick={() => (questionMinimized = false)}
            >
              <span class="dock-bar-lamp"></span>
              回答待ち(クリックで展開)
            </button>
          {:else}
            <div class="question-dock">
              <!-- .dock-min lives OUTSIDE .question-scroll so the scrollable
                   choices do not carry the minimize button out of view when a
                   tall AskUserQuestion overflows the cap. -->
              <button
                class="dock-min"
                type="button"
                title="最小化"
                aria-label="質問ダイアログを最小化"
                onclick={() => (questionMinimized = true)}></button>
              <div class="question-scroll">
                <p class="question-title">回答を選んでください</p>
                {#each question.questions as q, i (i)}
                  <fieldset class="question-item">
                    <legend>{q.header}</legend>
                    <p class="question-q">{q.question}</p>
                    {#each q.options as opt (opt.label)}
                      <label class="question-option">
                        {#if q.multiSelect}
                          <input
                            type="checkbox"
                            checked={qPicks[i]?.includes(opt.label) ?? false}
                            onchange={(e) =>
                              toggleMulti(i, opt.label, e.currentTarget.checked)}
                          />
                        {:else}
                          <input
                            type="radio"
                            name={`q-${i}`}
                            checked={qPicks[i]?.[0] === opt.label}
                            onchange={() => pickSingle(i, opt.label)}
                          />
                        {/if}
                        <span class="question-label">{opt.label}</span>
                        <span class="question-desc">{opt.description}</span>
                        {#if opt.preview}
                          <pre class="question-preview">{opt.preview}</pre>
                        {/if}
                      </label>
                    {/each}
                    <label class="question-other">
                      <span>Other</span>
                      <input
                        type="text"
                        placeholder="自由記述"
                        value={qOther[i] ?? ""}
                        oninput={(e) => (qOther[i] = e.currentTarget.value)}
                      />
                    </label>
                  </fieldset>
                {/each}
                <div class="question-actions">
                  <button class="answer" disabled={!questionReady} onclick={answerQuestion}>
                    回答
                  </button>
                  <button class="cancel" onclick={cancelQuestion}>キャンセル</button>
                </div>
              </div>
            </div>
          {/if}
        {/if}

        {#if dialogAvailability === "conditional-off"}
          <!-- ADR-0034 F3 (phase-15 15-16): proactive hint when the adapter
               advertises supports_user_input_dialog with a user_input_modes
               list that excludes the current mode. Both adapters currently
               advertise unconditional true so this stays inert; wired for
               D5 (Free/Go plan) future without another UI rewrite. -->
          <p class="caps-hint">
            現在の作業意図では質問に応答できません
            (session_capabilities.user_input_modes)
          </p>
        {/if}
        <div
          class="composer"
          role="region"
          aria-label="指示入力 + 添付"
          class:drop-active={dropActive}
          ondragenter={onDragEnter}
          ondragleave={onDragLeave}
          ondragover={onDragOver}
          ondrop={onDrop}>
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
          {#if resetMode}
            <p class="reset-progress" role="status" aria-live="polite">
              新しいsessionを開始中…(mode: {resetMode})
            </p>
          {/if}
          <form class="instruct" onsubmit={sendInstruction}>
            <textarea
              class:sending={display.shown === "sending"}
              placeholder={resetMode
                ? "session reset 中は入力できません"
                : "指示を送る…(Ctrl+Enter で送信、/ でコマンド候補、ドラッグドロップ・ペーストで画像等ファイル送信)"}
              bind:value={instruction}
              bind:this={slashTextarea}
              onkeydown={onInstructionKeydown}
              onpaste={onInstructionPaste}
              rows="2"
              aria-label="instruction for {name}"
              disabled={resetMode !== null}
            ></textarea>
            <!-- ADR-0034 F1/F3 (phase-15 15-15): attach button gated on the
                 wrapper's advertised supports_attachments. Fail-closed: a
                 session that has not stamped session_capabilities is treated
                 the same as one that stamped false. -->
            <label
              class="attach"
              class:attach-disabled={!attachmentsSupported}
              title={attachmentsSupported
                ? (imagesOnlyAttachments ? "画像を添付(複数可)" : "ファイル添付(画像 / テキスト / コード / PDF / Office、複数可)")
                : "このセッションでは未対応"}
            >
              <input
                type="file"
                accept={attachmentAccept}
                multiple
                onchange={onFilePicked}
                bind:this={stagedFileInput}
                disabled={!attachmentsSupported}
              />
              <span>📎</span>
            </label>
            <button
              type="submit"
              disabled={uploading ||
                resetMode !== null ||
                (instruction.trim() === "" && stagedFiles.length === 0)}
              >{uploading ? "送信中…" : "送信"}</button
            >
          </form>

          {#if stagedFiles.length > 0}
            <div class="tray">
              <span class="tray-count">添付 {stagedFiles.length}/{MAX_STAGED}</span>
              <ul class="tray-list">
                {#each stagedFiles as entry, i (entry.id)}
                  <li class="staged">
                    <span class="staged-name"
                      title="{entry.file.name} ({(entry.file.size / 1024).toFixed(1)} KB)"
                      >{entry.file.type.startsWith("image/") ? "🖼" : "📄"} {entry.file.name} ({(
                        entry.file.size / 1024
                      ).toFixed(1)} KB)</span>
                    <button
                      type="button"
                      onclick={() => removeStagedFile(i)}
                      aria-label="添付を解除">✕</button>
                    {#if entry.progress > 0}
                      <div
                        class="staged-bar"
                        role="progressbar"
                        aria-label="アップロード進捗"
                        aria-valuenow={Math.round(entry.progress * 100)}
                        aria-valuemin="0"
                        aria-valuemax="100">
                        <div
                          class="staged-bar-fill"
                          style:width="{entry.progress * 100}%"></div>
                      </div>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

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
    /* Column layout with min-height:0 lets .status-scroll shrink and scroll
       instead of the aside growing .detail past the viewport (#37 follow-up).
       Without min-height:0 the default min-height:auto keeps the aside at its
       content height, which is what pushed the whole page. */
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Identity header stays pinned; only .status-scroll below it scrolls. */
  .status-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* Stop the inner scroll from chaining to the page once it bottoms out. */
    overscroll-behavior: contain;
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
    font-size: var(--fs-body-sm);
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
    font-size: var(--fs-body-sm);
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
    font-size: var(--fs-body-sm);
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

  /* Resume-swap picker (ADR-0014): a full-width trigger + an inline
     candidate list below it, matching the pane-bottom action buttons above.
     position: relative anchors the popover to the button so the pane
     scroll doesn't detach them. */
  .resume-switch {
    position: relative;
    margin-top: 0.5rem;
  }

  .resume-swap {
    width: 100%;
    padding: 0.45rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-body-sm);
    cursor: pointer;
  }

  .resume-swap:hover:not(:disabled) {
    border-color: var(--fg-dim);
  }

  .resume-swap:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .resume-menu {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0.2rem;
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
  }

  .resume-menu li.empty {
    padding: 0.4rem 0.5rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .resume-menu button {
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-body-sm);
    text-align: left;
    cursor: pointer;
    border-radius: 0.25rem;
  }

  .resume-menu button:hover {
    background: color-mix(in srgb, var(--fg-dim) 12%, transparent);
  }

  .resume-menu button[aria-selected="true"] {
    color: var(--c-waiting_input);
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

  /* position: relative anchors the slash-command menu (#34) above the
     textarea. */
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    border-radius: 0.5rem;
    /* file-upload spec / ADR-0025 Stage C "i": the composer doubles as the
       D&D drop zone for one agent; the highlight stays scoped to this
       AgentDetail so a drop cannot bleed across agents. */
    transition: outline-color 0.12s ease-out, background 0.12s ease-out;
    outline: 2px dashed transparent;
    outline-offset: 4px;
  }

  .composer.drop-active {
    outline-color: var(--c-thinking);
    background: color-mix(in srgb, var(--c-thinking) 8%, transparent);
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
    font-size: var(--fs-body-sm);
    text-align: left;
    cursor: pointer;
  }

  .slash-menu button.active,
  .slash-menu button:hover {
    background: color-mix(in srgb, var(--tone) 20%, var(--bg-card));
  }

  /* tablet 幅以下 (ADR-0052 F2): .status はボトムシートの panel (flex
     column, 最大高 60dvh) を埋める。旧 640px query の縦積み (外側スクロール
     と二重化して会話ログへ到達できない問題) はこの退避で置き換えた。
     .detail の height:100% と composer の bottom 固定は全サイズ共通のまま。 */
  @media (max-width: 1198px) {
    /* Inside the sheet, .status ITSELF becomes the single scroll owner and
       the identity header scrolls WITH the content — the desktop split
       (pinned .head + scrolling .status-scroll) leaves .status-scroll an
       effective height of 0 on landscape phones (844x390 → panel 234px vs
       .head 181px; クロエ外部レビュー M1 実測), making every status
       control unreachable. Flipping the owner is the reachability doc's
       sanctioned alternative (「…か、その逆にする」) and works at any
       panel height. */
    .status {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }

    .status-scroll {
      flex: none;
      min-height: auto;
      overflow-y: visible;
      overscroll-behavior: auto;
    }

    /* The sheet panel is viewport-wide; uncapped, the width-100% portrait
       (sized for the 20% desktop sidebar) would dominate the panel. */
    .portrait {
      max-width: 8rem;
      margin-inline: auto;
    }

    .head {
      padding-bottom: 0.6rem;
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
    font-size: var(--fs-body-sm);
    cursor: pointer;
  }

  .blindspot {
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--c-waiting_permission);
    font: inherit;
    font-size: var(--fs-body-sm);
    cursor: pointer;
    animation: blink 1.2s ease-in-out infinite;
  }

  .blindspot[data-tone="error"] {
    border-color: var(--c-error);
    color: var(--c-error);
  }

  .blindspot[data-tone="waiting_question"] {
    border-color: var(--c-waiting_question);
    color: var(--c-waiting_question);
  }

  @keyframes blink {
    50% { opacity: 0.45; }
  }

  .head {
    /* Pinned: does not shrink, so only .status-scroll below it scrolls. */
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    text-align: center;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--line);
  }

  /* Persona portrait (#16): fills the pane width with a subtle top light,
     like the grid cards; a state-coloured lamp sits in the corner.
     `container-type: inline-size` (issue #180 follow-up, 2026-08-10):
     lets the 頭上リング (TaskRing, absolutely positioned inside this
     element) size its orbit in `cqw` — relative to THIS element's own
     resolved width, which varies (`.status`'s flex share on desktop,
     `max-width: 8rem` on tablet-and-below, see the media query above) —
     rather than a fixed rem that would only look right at one width.
     `.portrait`'s own box size is set entirely by its parent/media rules
     above (`width: 100%` / `max-width`), never by its children's
     intrinsic size, so establishing size containment here does not
     change how `.portrait` itself is laid out. */
  .portrait {
    position: relative;
    width: 100%;
    display: flex;
    justify-content: center;
    padding: 0.8rem;
    border-radius: 0.5rem;
    container-type: inline-size;
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
    position: relative;
    width: 70%;
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tone) 28%, var(--bg-card));
    border: 2px solid var(--tone);
    box-shadow: 0 0 18px color-mix(in srgb, var(--tone) 35%, transparent);
    animation: dissolve 0.35s ease-out;
  }

  /* CSS face features for sprite-less personas (#35). Sized in % of the
     face so they scale with the responsive portrait, not as fixed rem
     (the rem values that work on the AgentCard tile look like specks on
     this larger detail circle). Per-state rules mirror AgentCard.svelte
     so the lobby tile and the detail view never drift on what each state
     looks like; keep the two in sync when a state expression changes. */
  .eye {
    position: absolute;
    top: 38%;
    width: 10%;
    height: 10%;
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
    width: 26%;
    height: 12%;
    border-bottom: 3px solid var(--fg);
    border-radius: 0 0 50% 50% / 0 0 100% 100%;
  }

  [data-state="idle"] .mouth {
    width: 17%;
    height: 0;
    border-radius: 0;
  }

  [data-state="thinking"] .eye {
    top: 30%;
    height: 5%;
    border-radius: 50% 50% 0 0;
  }

  [data-state="thinking"] .mouth {
    width: 9%;
    height: 9%;
    border: 3px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="thinking"] .face {
    animation: dissolve 0.35s ease-out, sway 2.4s ease-in-out infinite;
  }

  @keyframes sway {
    50% { rotate: 4deg; }
  }

  [data-state="tool_running"] .eye {
    height: 6%;
    border-radius: 6%;
  }

  [data-state="tool_running"] .mouth {
    width: 20%;
    height: 0;
    border-radius: 0;
  }

  [data-state="waiting_permission"] .eye {
    width: 14%;
    height: 14%;
    box-shadow: inset 0 0 0 3px var(--tone);
  }

  [data-state="waiting_permission"] .mouth {
    width: 8%;
    height: 10%;
    border: 3px solid var(--fg);
    border-radius: 50%;
  }

  [data-state="waiting_permission"] .face {
    animation: dissolve 0.35s ease-out, hop 1.1s ease-in-out infinite;
  }

  @keyframes hop {
    20% { translate: 0 -4%; }
    40% { translate: 0 0; }
  }

  [data-state="waiting_input"] .mouth {
    width: 30%;
  }

  [data-state="done"] .eye {
    height: 6%;
    border-radius: 0 0 50% 50%;
    background: transparent;
    border-bottom: 3px solid var(--fg);
  }

  [data-state="done"] .mouth {
    width: 33%;
    height: 15%;
  }

  [data-state="error"] .eye {
    border-radius: 0;
    background:
      linear-gradient(45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%),
      linear-gradient(-45deg, transparent 42%, var(--fg) 42% 58%, transparent 58%);
  }

  [data-state="error"] .mouth {
    border-bottom: none;
    border-top: 3px solid var(--fg);
    border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  }

  [data-state="disconnected"] .face {
    opacity: 0.45;
    box-shadow: none;
  }

  [data-state="disconnected"] .eye {
    height: 2%;
    border-radius: 0;
  }

  [data-state="disconnected"] .mouth {
    width: 17%;
    height: 0;
    border-radius: 0;
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
    font-size: var(--fs-h1);
    color: var(--fg);
  }

  .state {
    margin: 0.2rem 0 0;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--tone);
    animation: dissolve 0.35s ease-out;
  }

  .id {
    margin: 0.3rem 0 0;
    font-size: var(--fs-metadata);
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
    font-size: var(--fs-metadata);
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

  .cc-model-resolved {
    display: block;
    color: var(--muted);
    font-size: 0.82em;
  }

  .switch-notice dd {
    color: var(--c-info, var(--fg-dim));
    line-height: 1.45;
  }

  .switch-notice.error dd {
    color: var(--c-error);
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

  .cc-perm-switchbox {
    min-width: 0;
  }

  .cc-switch.cc-perm-switch {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    white-space: normal;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .cc-switch {
    flex: none;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--fg-dim);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .cc-switch:hover {
    color: var(--fg);
    border-color: var(--tone);
  }

  /* Sibling of .cc-switch (phase-18-9): match the visual weight so the row
   * reads as one control group. Icon-only 常時提供 button (ADR-0037 F6). */
  .cc-refresh {
    flex: none;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg-card);
    color: var(--fg-dim);
    font: inherit;
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .cc-refresh:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--tone);
  }

  .cc-refresh:disabled {
    cursor: progress;
    opacity: 0.5;
  }

  /* Persistent indicator for the catalog-fetch cap (ADR-0037 F6, phase-18-10).
   * switchNotice only shows once on the rising edge and gets cleared by
   * unrelated clicks; this class stays as long as ext.models_error is true,
   * so the operator can still see "catalog is broken" after retrying and
   * failing. The tone matches the file's other error surfaces (switchNotice
   * error tone / permission_denied badges). */
  .cc-refresh-error {
    color: var(--danger, #c62828);
    border-color: var(--danger, #c62828);
  }

  .cc-refresh-error:hover:not(:disabled) {
    color: var(--danger, #c62828);
    border-color: var(--danger, #c62828);
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
    font-size: var(--fs-body-sm);
    text-align: left;
    cursor: pointer;
  }

  .axes-badge {
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .axes-hint {
    display: block;
    font-size: 0.72rem;
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }

  /* Codex "承認: never" annotation (phase-15 D2 / task 15-11): dimmer than
     the axis value itself so the badge reads primarily as "never" with
     the reason surfaced inline. */
  .axes-hostfixed {
    color: var(--fg-dim);
    font-size: 0.85em;
  }

  /* Resume drift badge (ADR-0014 F1 addendum, phase-15 D8 / task 15-9):
     amber tone (shared with tool_running) so the operator notices resolved
     settings changed on resume without treating it as an error. */
  .drift-badge {
    display: block;
    font-size: var(--fs-body-sm);
    color: var(--c-tool_running);
  }

  .drift-entry {
    display: block;
    font-variant-numeric: tabular-nums;
  }

  .switch-menu button[aria-selected="true"] {
    color: var(--tone);
  }

  .switch-menu button:hover {
    background: color-mix(in srgb, var(--tone) 20%, var(--bg-card));
  }

  /* Placeholder for a rate window the SDK has not surfaced yet (#16). */
  .cc-pending {
    font-size: var(--fs-metadata);
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
    font-size: 0.85em; /* em-relative to parent meter; do not tokenize */
    opacity: 0.8;
  }

  .log {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 0 0.4rem var(--timeline-scroll-tail, 0) 0;
    scroll-padding-top: 24px;
  }

  /* #122: Each envelope exposes a stable DOM anchor for timeline navigation.
     Keep the former direct-child rhythm by putting the date divider and its
     envelope body in the same small flex group. */
  .transcript-entry {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 0.6rem;
    scroll-margin-top: 24px;
  }

  .empty {
    color: var(--fg-dim);
    font-size: var(--fs-body);
  }

  .load-earlier {
    align-self: center;
    margin: 0.2rem 0 0.6rem;
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--fg-dim);
    font-size: var(--fs-caption);
    cursor: pointer;
  }

  .load-earlier:hover {
    color: var(--fg);
    border-color: var(--tone);
  }

  .load-earlier:focus-visible {
    color: var(--fg);
    border-color: var(--tone);
    background: color-mix(in srgb, var(--tone) 10%, var(--bg-card));
    outline: none;
  }

  .msg {
    margin: 0;
    padding: 0.6rem 0.8rem;
    border-radius: 0.5rem;
    font-size: var(--fs-body);
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

  /* Markdown table (#81): draw cell borders so columns read cleanly, and
     lift the header row with a darker fill + centred text. --bg is the
     same tone `pre` uses inside .msg, so tables sit at the same visual
     depth as code blocks against the bubble's --bg-card ground. */
  .msg :global(table) {
    margin: 0.4rem 0;
    border-collapse: collapse;
  }

  .msg :global(th),
  .msg :global(td) {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--line);
  }

  .msg :global(th) {
    text-align: center;
    background: var(--bg);
    font-weight: 600;
  }

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

  /* Session-level wrapper notice (phase-28 A1 / #168): deliberately not a
     .msg bubble — it is neither party speaking, so it reads as a dim
     centred rule-like line between the surrounding turns. */
  .sysline {
    margin: 0;
    align-self: center;
    color: var(--fg-dim);
    font-size: var(--fs-body-sm);
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

  /* Inter-agent message bubble (protocol-inter-agent, phase-8): a tinted
     border + small header line carrying direction (→ to / ← from), kind,
     short conversation_id, and turn number so the operator can follow a
     multi-turn discussion across both transcripts. `--iam-tone` swaps by
     direction so 送信 (→ to, ピンク) and 受信 (← from, 紫) stay visually
     distinct in the transcript. */
  .msg.inter-agent {
    --iam-tone: var(--c-tool_running);
    background: color-mix(in srgb, var(--iam-tone) 12%, var(--bg-card));
    border: 1px solid var(--iam-tone);
    color: var(--fg);
  }

  .msg.inter-agent.outgoing {
    --iam-tone: var(--c-error); /* ピンク系 (#f08498) を流用 — to */
  }

  .msg.inter-agent.incoming {
    --iam-tone: var(--c-waiting_permission); /* 紫系 (#c9a2f5) を流用 — from */
  }

  .inter-agent-head {
    margin: 0 0 0.3rem;
    font-size: var(--fs-metadata);
    color: var(--fg-dim);
    letter-spacing: 0.02em;
  }

  .inter-agent-head .arrow {
    font-weight: 700;
    margin-right: 0.2em;
    color: var(--iam-tone);
  }

  /* Peer name in the inter-agent bubble header (name(id) + clickable).
     Styled like an inline link so the operator can tell it's interactive
     without a heavy button look. */
  .inter-agent-head .peer-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--iam-tone);
    text-decoration: underline;
    text-decoration-style: dotted;
    cursor: pointer;
  }

  .inter-agent-head .peer-link:hover,
  .inter-agent-head .peer-link:focus-visible {
    text-decoration-style: solid;
    outline: none;
  }

  .inter-agent-head .kind {
    margin-left: 0.6em;
    padding: 0 0.4em;
    border: 1px solid var(--line);
    border-radius: 0.3em;
    text-transform: uppercase;
    font-size: var(--fs-caption);
  }

  .inter-agent-head .cid,
  .inter-agent-head .turn {
    margin-left: 0.5em;
    font-variant-numeric: tabular-nums;
    font-size: var(--fs-caption);
  }

  .turn-end {
    margin: 0.2rem 0;
    text-align: center;
    font-size: var(--fs-metadata);
    letter-spacing: 0.1em;
    color: var(--c-done);
  }

  .turn-end.error {
    color: var(--c-error);
  }

  /* Error detail line (issue #127): shows SDK errors[] / stop_reason under
     the turn-end when an error terminated the turn. Same tone as turn-end
     but wraps normally instead of being centred. */
  .turn-end-detail {
    margin: 0 1rem 0.4rem;
    text-align: center;
    font-size: var(--fs-metadata);
    color: var(--c-error);
    opacity: 0.85;
    word-break: break-word;
  }

  /* Retry button (issue #128): inline on the error turn-end line, subtle
     to avoid overshadowing the primary composer. */
  .turn-end .retry {
    margin-left: 0.5em;
    padding: 0 0.5em;
    font-size: var(--fs-metadata);
    color: var(--c-accent, currentColor);
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 3px;
    cursor: pointer;
    line-height: 1.4;
  }

  .turn-end .retry:hover {
    background: rgba(128, 128, 128, 0.1);
  }

  /* Per-line wall-clock time (#38): small, dim, monospaced digits. */
  .ts {
    font-size: var(--fs-caption);
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
    font-size: var(--fs-caption);
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

  /* phase-17 17-9: session boundary marker in the transcript. Same
     visual language as day-divider but with a distinct label + optional
     request_id hint (operator tooltip only; viewer sees mode alone). */
  .session-boundary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    margin: 0.8rem 0;
    padding: 0.25rem 0;
    color: var(--fg-dim);
    font-size: var(--fs-caption);
    letter-spacing: 0.05em;
    font-variant-numeric: tabular-nums;
  }
  .session-boundary .marker-ids {
    color: var(--fg-dim);
    font-family: monospace;
    font-size: var(--fs-metadata);
    opacity: 0.7;
  }

  /* phase-17 17-9: reset-in-flight banner above the composer. Non-modal,
     unobtrusive; the textarea disable + placeholder swap carries the
     interaction gate, this just tells the operator why. */
  .reset-progress {
    margin: 0.4rem 0 0;
    padding: 0.35rem 0.6rem;
    background: var(--surface-dim, rgba(0, 0, 0, 0.05));
    color: var(--fg-dim);
    font-size: var(--fs-caption);
    border-radius: 4px;
    text-align: center;
  }

  /* Session cost on the turn boundary (#8). */
  .cost {
    margin-left: 0.5em;
    font-size: var(--fs-metadata);
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }

  .tool {
    font-size: var(--fs-body-sm);
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
    font-size: var(--fs-caption);
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

  /* Permission dock (#46): an in-flow panel between the transcript and the
     composer. It pushes the log up (which stays scrollable, just shorter)
     rather than overlaying it, so the operator keeps the context in view
     while deciding — the reason the earlier floating dock needed a minimize
     button at all. Bordered in the waiting_permission hue. */
  .permission-dock {
    position: relative;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--c-waiting_permission);
    border-radius: 0.45rem;
    background: var(--bg-card);
    font-size: var(--fs-body-sm);
  }

  /* Scrolling flex child (same shape as .question-scroll): carries the
     shell's former padding so the short-height cap (31-8) scrolls the
     content while .dock-min stays pinned to the shell. */
  .permission-scroll {
    min-height: 0;
    overflow: auto;
    padding: 0.7rem 0.8rem;
  }

  /* padding-right leaves room for the absolute .dock-min button. */
  .permission-tool { margin: 0; padding-right: 1.6rem; color: var(--fg); }
  .permission-note { margin: 0.3rem 0 0; color: var(--fg-dim); }
  .permission-dock details { margin-top: 0.35rem; color: var(--fg-dim); }

  .permission-dock pre {
    margin: 0.3rem 0 0;
    max-height: 10rem;
    overflow: auto;
    font-size: var(--fs-metadata);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Collapse affordance shared by both docks (#46, #78). .dock-min sits in the
     expanded panel's top-right corner; clicking it swaps the panel for the
     in-flow .dock-bar, which reclaims log height and expands again on click. */
  .dock-min {
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
  .dock-min::before {
    content: "";
    width: 0.7rem;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
  }

  .dock-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--dock-accent);
    border-radius: 0.45rem;
    background: var(--bg-card);
    color: var(--dock-accent);
    font: inherit;
    font-size: var(--fs-body-sm);
    text-align: left;
    cursor: pointer;
  }

  .dock-bar-perm { --dock-accent: var(--c-waiting_permission); }
  .dock-bar-question { --dock-accent: var(--c-waiting_question); }

  .dock-bar-lamp {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--dock-accent);
    box-shadow: 0 0 6px var(--dock-accent);
    animation: blink 1.2s ease-in-out infinite;
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
    font-size: var(--fs-body-sm);
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

  /* Question dock (#78, ADR-0027): in-flow like the permission dock, pushing
     the log up rather than overlaying it. Caps at 60% of the conversation
     column and scrolls internally so a tall AskUserQuestion never crowds the
     log out entirely. Bordered in the waiting_question hue. */
  /* The dock is a non-scrolling flex shell capped at 60% of the conversation
     column; .question-scroll is the flex child that actually scrolls. Keeping
     the cap + scroll off the dock itself lets the absolute .dock-min stay
     pinned to the dock (not the scrolled content) so it never scrolls away. */
  .question-dock {
    position: relative;
    display: flex;
    flex-direction: column;
    max-height: 60%;
    border: 1px solid var(--c-waiting_question);
    border-radius: 0.45rem;
    background: var(--bg-card);
    font-size: var(--fs-body-sm);
  }

  .question-scroll {
    min-height: 0;
    overflow: auto;
    padding: 0.7rem 0.8rem;
  }

  /* padding-right leaves room for the absolute .dock-min button. */
  .question-title {
    margin: 0 0 0.5rem;
    padding-right: 1.6rem;
    color: var(--c-waiting_question);
  }

  .question-item {
    margin: 0 0 0.6rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
  }

  .question-item legend {
    padding: 0 0.3rem;
    color: var(--fg-dim);
    font-size: var(--fs-metadata);
  }

  .question-q {
    margin: 0 0 0.4rem;
    color: var(--fg);
  }

  .question-option {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0 0.5rem;
    margin: 0.35rem 0;
    cursor: pointer;
  }

  .question-option > input {
    grid-column: 1;
    grid-row: 1;
    align-self: start;
    margin-top: 0.15rem;
  }

  .question-label {
    grid-column: 2;
    grid-row: 1;
    color: var(--fg);
    font-weight: 600;
  }

  .question-desc {
    grid-column: 2;
    grid-row: 2;
    color: var(--fg-dim);
    font-size: var(--fs-metadata);
  }

  .question-preview {
    grid-column: 2;
    grid-row: 3;
    margin: 0.2rem 0 0;
    max-height: 8rem;
    overflow: auto;
    font-size: var(--fs-micro);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--fg-dim);
  }

  .question-other {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.4rem;
    color: var(--fg-dim);
    font-size: var(--fs-metadata);
  }

  .question-other input {
    flex: 1;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-body-sm);
  }

  .question-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }

  .question-actions button {
    flex: 1;
    padding: 0.35rem 0;
    border: 1px solid var(--line);
    border-radius: 0.35rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-body-sm);
    cursor: pointer;
  }

  .question-actions .answer {
    border-color: var(--c-done);
    color: var(--c-done);
  }

  .question-actions .answer:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .question-actions .cancel {
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
    font-size: var(--fs-body-sm);
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
    font-size: 0.7em; /* em-relative to parent button; do not tokenize */
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
    font-size: var(--fs-body-sm);
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
    font-size: 0.7em; /* em-relative to parent button; do not tokenize */
    line-height: 1;
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
    font-size: var(--fs-input);
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
    font-size: var(--fs-body-sm);
    color: var(--c-tool_running);
  }

  .instruct button {
    padding: 0.5rem 1rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg-card);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-body);
    cursor: pointer;
  }

  .instruct button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .action-error {
    margin: 0;
    font-size: var(--fs-body-sm);
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

  /* Disabled attach button (phase-15 15-15): the session_capabilities
     advertise supports_attachments=false (or is absent, fail-closed).
     Muted look and default cursor so it reads as unavailable; the tooltip
     ("このセッションでは未対応") carries the reason. */
  .attach-disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Composer capability hint (phase-15 15-16): fires only when the
     wrapper advertises supports_user_input_dialog=true with a
     user_input_modes list that excludes the current mode. Dim by default
     — informational, not an error. */
  .caps-hint {
    margin: 0 0 0.4rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  /* Staged-attachment tray (file-upload spec / ADR-0025 F12 "to-send tray"):
     chips wrap onto multiple rows so 10 staged files (the spec cap) stay
     visible without pushing the composer off-screen. The count header
     mirrors MAX_STAGED so the operator sees how close they are to the cap. */
  .tray {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.4rem;
  }

  .tray-count {
    font-size: var(--fs-metadata);
    color: var(--fg-dim);
  }

  .tray-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .staged {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 0.3rem;
    background: var(--bg-card);
    font-size: var(--fs-body-sm);
    max-width: 100%;
    overflow: hidden;
  }

  .staged-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 18rem;
  }

  .staged button {
    border: none;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font-size: var(--fs-body);
  }

  /* Per-upload progress bar (file-upload spec / ADR-0025 Stage C "g"): thin
     strip at the bottom edge of the chip, fed by uploadFile's onProgress
     callback. Only rendered while a transfer is in flight (progress > 0). */
  .staged-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: color-mix(in srgb, var(--c-thinking) 18%, transparent);
  }

  .staged-bar-fill {
    height: 100%;
    background: var(--c-thinking);
    transition: width 0.15s ease-out;
  }

  /* short (max-height 500px, ADR-0052 F8): 縦方向の圧縮のみ。composer は
     初期 1 行高でフォーカス時に拡張、dock 類は高さ上限 + 内部スクロール。
     dock の展開状態は変えない — 新しい request_id ごとに折りたたみを解除
     する契約 (pending を古い折りたたみで隠さない) を viewport 依存の初期
     状態で壊さないため。横レイアウトとシート最大高も不変。 */
  @media (max-height: 500px) {
    /* :placeholder-shown scopes the 1-line compression to an EMPTY
       composer — typed multi-line text must not get hidden the moment
       focus moves to the send button (クロエ外部レビュー N6). */
    .instruct textarea:placeholder-shown:not(:focus) {
      height: 2.8em;
      min-height: 0;
    }

    .permission-dock,
    .question-dock {
      max-block-size: 45%;
    }
  }
</style>
