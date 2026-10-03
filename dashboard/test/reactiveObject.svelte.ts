// Test-only helper: a reactive props object for mount(). The .svelte.ts
// extension enables $state, so a test can change a prop from the outside and
// watch the mounted component follow it.
export function reactiveObject<T extends object>(initial: T): T {
  const props = $state(initial);
  return props;
}
