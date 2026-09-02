// Phase 18-12 A1 harness: creates a reactive props object for mount(AgentDetail).
// Test-only helper; .svelte.ts extension enables $state runes in what would
// otherwise be a plain .ts file, so vitest can drive reactivity from the
// outside. `mount()` treats the returned proxy as reactive props — updating
// `props.envelope = newEnv` re-runs downstream $effect chains inside the
// mounted component, which is what the sawModelsError rising-edge tracker
// (AgentDetail.svelte L697-712) needs to observe a false→true→false→true
// toggle within a single component instance.
//
// This is the piece ふじ (18-10 監督) flagged as the way to close the
// toggle-re-fire gap that plain mount() with a static props object cannot
// exercise.

import type {
  Envelope,
  HostInfo,
  KaoiroConnection,
  RunnerSessions,
} from "../src/lib/protocol";

export interface ReactiveAgentDetailProps {
  envelope: Envelope;
  connection: KaoiroConnection;
  onClose: () => void;
  /** issue #197 段階3 unit B: optional so existing callers (model/effort
   *  switch harness) are unaffected. */
  onRename?: (name: string) => Promise<void>;
}

export function makeReactiveAgentDetailProps(
  initial: ReactiveAgentDetailProps,
): ReactiveAgentDetailProps {
  const state = $state(initial);
  return state;
}

/** Test-only reactive props for #122 scroll-target lifecycle checks. */
export interface ReactiveTimelineDetailProps {
  envelope: Envelope;
  logs: Envelope[];
  agents: Record<string, Envelope>;
  scrollToEntryKey: string | null;
  onClose: () => void;
}

export function makeReactiveTimelineDetailProps(
  initial: ReactiveTimelineDetailProps,
): ReactiveTimelineDetailProps {
  const state = $state(initial);
  return state;
}

// Phase 20 (ADR-0039): reactive wrapper for LaunchDialog props so an
// integration test can rotate `hosts[i].engines[].models` in-place and pin
// that the auto-refresh $effect does NOT re-fire on catalog-only rotations
// (see engineCatalogRefresh.integration.test.ts 藤 review 3-1).
export interface ReactiveLaunchDialogProps {
  hosts: HostInfo[];
  connection: KaoiroConnection;
  sessions: RunnerSessions | null;
  onClose: () => void;
}

export function makeReactiveLaunchDialogProps(
  initial: ReactiveLaunchDialogProps,
): ReactiveLaunchDialogProps {
  const state = $state(initial);
  return state;
}

// issue #276 review follow-up (ふじ round2 B2): reactive wrapper for
// SettingsDrawer props so an integration test can flip `connection`
// truthy -> undefined -> truthy on a MOUNTED instance, the transition a
// static props object cannot exercise (mount() only sets props once).
export interface ReactiveSettingsDrawerProps {
  onClose: () => void;
  // Explicit `| undefined` (not `?`) so a test can flip this field to
  // undefined post-mount under `exactOptionalPropertyTypes: true`.
  connection: KaoiroConnection | undefined;
}

export function makeReactiveSettingsDrawerProps(
  initial: ReactiveSettingsDrawerProps,
): ReactiveSettingsDrawerProps {
  const state = $state(initial);
  return state;
}
