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

import type { Envelope, KaoiroConnection } from "../src/lib/protocol";

export interface ReactiveAgentDetailProps {
  envelope: Envelope;
  connection: KaoiroConnection;
  onClose: () => void;
}

export function makeReactiveAgentDetailProps(
  initial: ReactiveAgentDetailProps,
): ReactiveAgentDetailProps {
  const state = $state(initial);
  return state;
}
