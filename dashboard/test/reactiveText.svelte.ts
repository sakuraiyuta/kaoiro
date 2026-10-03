// Test-only helper: a reactive props object for mount(UntrustedMarkdown). The
// .svelte.ts extension enables $state, so a test can change `text` from the
// outside and watch the mounted component follow it.
export function reactiveText(initial: string): { text: string } {
  const props = $state({ text: initial });
  return props;
}
