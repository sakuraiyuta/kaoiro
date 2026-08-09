// Fixture envelopes + stub connection for the viewport-regression harness
// (phase-31 31-10). Pure data — no network, no Phoenix socket: the specs
// pin CSS/layout behaviour, not transport.
import type {
  Envelope,
  KaoiroConnection,
  PersonaManifest,
} from "../../src/lib/protocol";

function agent(
  agentId: string,
  personaId: string,
  name: string,
  state: string,
  ext?: Record<string, unknown>,
): Envelope {
  const env: Envelope = {
    version: "0",
    agent_id: agentId,
    persona: { id: personaId, name, sprite_set: personaId },
    ts: "2026-08-09T10:00:00Z",
    type: "state_change",
    state,
  };
  if (ext !== undefined) env.ext = ext;
  return env;
}

/** Baseline ext so the status pane renders its usual rows. */
function claudeExt(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "claude-sonnet-5",
    permission_mode: "auto",
    cwd: "/home/e2e/project",
    context: { used_percentage: 42, used_tokens: 84_000, max_tokens: 200_000 },
    rate_limits: {
      seven_day: { utilization: 0.17, resets_at: 4_102_444_800 },
    },
    session_capabilities: {
      supports_attachments: true,
      supports_user_input_dialog: true,
    },
    ...extra,
  };
}

export interface DetailScenario {
  /** Current-agent pending decision rendered as an in-flow dock. */
  pending?: "permission" | "question";
  /** Add a second agent in waiting_permission so the blindspot /
   *  handle-badge affordance renders. */
  attention?: boolean;
  /** 頭上リング (issue #180 follow-up, 2026-08-10, ふじ S1): mirrors
   *  LobbyHarness's own `taskRing` prop so a real-browser Playwright pass
   *  can pin `.task-ring` visibility/animation for AgentDetail across the
   *  responsive breakpoints, the way LobbyHarness already does for
   *  AgentCard. */
  taskRing?: boolean;
  /** 頭上リング back-button overlap regression (issue #180 follow-up
   *  round 2, 2026-08-10, workflow-review QUALITY finding): DetailHarness
   *  always mounted with manifest=null before this, so every T11 case
   *  exercised only TaskRing's smaller face-orbit radii — never the
   *  larger, more overlap-prone sprite-orbit radii the reported bug
   *  actually involved (あお's persona card in the master's screenshot
   *  resolves a sprite). Set true to supply a manifest with a resolved
   *  sprite for the "ao" persona so DetailHarness's spriteUrl is
   *  non-null. */
  sprite?: boolean;
}

/** Manifest with a resolved sprite for the "ao" persona, covering every
 *  state DetailScenario can put the agent in (idle default, plus the two
 *  `pending` states) — see `sprite` field doc above. */
export function detailManifest(scenario: DetailScenario): PersonaManifest | null {
  if (!scenario.sprite) return null;
  const sprite = { url: "/sprites/ao/idle.png", hash: "sha256:e2e-fixture" };
  return {
    version: "1",
    personas: {
      ao: {
        states: {
          idle: sprite,
          waiting_permission: sprite,
          waiting_question: sprite,
        },
      },
    },
  };
}

export function lobbyAgents(pending = false): Record<string, Envelope> {
  const ids = ["ao", "momo", "kuroe", "fuji"];
  return Object.fromEntries(
    ids.map((id, index) => [
      `host.${id}`,
      agent(
        `host.${id}`,
        id,
        id,
        pending && index === 1
          ? "waiting_permission"
          : index === 0
            ? "thinking"
            : "idle",
      ),
    ]),
  );
}

/** A couple of assistant rows so the timeline pane has content. */
export function lobbyLogs(): Record<string, Envelope[]> {
  return {
    "host.ao": [
      {
        version: "0",
        agent_id: "host.ao",
        ts: "2026-08-09T09:59:00Z",
        seq: 1,
        type: "log",
        state: "thinking",
        payload: { kind: "assistant", text: "e2e fixture reply" },
      },
    ],
  };
}

export function detailEnvelope(scenario: DetailScenario): Envelope {
  const extra: Record<string, unknown> = {};
  let state = "idle";
  if (scenario.pending === "permission") {
    state = "waiting_permission";
    extra.pending_permission = {
      request_id: "perm-e2e-1",
      tool_name: "Bash",
      input: { command: "echo e2e" },
    };
  } else if (scenario.pending === "question") {
    state = "waiting_question";
    extra.pending_question = {
      request_id: "q-e2e-1",
      questions: [
        {
          header: "Approach",
          question: "Which approach should we take?",
          multiSelect: false,
          options: [
            { label: "Option A", description: "the first way" },
            { label: "Option B", description: "the second way" },
          ],
        },
      ],
    };
  }
  return agent("host.ao", "ao", "ao", state, claudeExt(extra));
}

export function detailAgents(scenario: DetailScenario): Record<string, Envelope> {
  const agents: Record<string, Envelope> = {
    "host.ao": detailEnvelope(scenario),
  };
  if (scenario.attention) {
    agents["host.momo"] = agent("host.momo", "momo", "momo", "waiting_permission");
  }
  return agents;
}

export function detailLogs(): Envelope[] {
  return Array.from({ length: 30 }, (_, i) => ({
    version: "0",
    agent_id: "host.ao",
    ts: "2026-08-09T09:30:00Z",
    seq: i + 1,
    type: "log",
    state: "thinking",
    payload: { kind: "assistant", text: `fixture reply ${i + 1}` },
  }));
}

/** Every method resolves to an empty object: the harness only needs the
 *  affordances to render, never a real round-trip. */
export function stubConnection(): KaoiroConnection {
  return new Proxy(
    {},
    {
      get: () => async () => ({}),
    },
  ) as KaoiroConnection;
}

export function launchHosts() {
  return [
    {
      host_id: "e2e-host",
      personas: [
        { id: "ao", name: "ao", sprite_set: "ao" },
        { id: "momo", name: "momo", sprite_set: "momo" },
      ],
      cwd_allowlist: ["/home/e2e/project", "/home/e2e/other"],
    },
  ];
}
