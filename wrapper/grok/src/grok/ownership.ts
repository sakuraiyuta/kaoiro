/**
 * Which Grok prompt owns an update, a permission request or a token reading.
 *
 * The wrapper names every prompt it sends (`_meta.promptId`), and only that
 * id is the operator's turn. Grok starts other prompts on its own
 * (`task-completed-*`, `notifications-*`, `interject-fallback-*`, and kinds
 * not seen yet), so anything not provably own is foreign. A permission
 * request carries no prompt id; it is matched through the `tool_call` with
 * the same `toolCallId`.
 */
export class PromptOwnership {
  #own: string | undefined;
  #running: string | undefined;
  readonly #calls = new Map<string, string | null>();
  readonly #refused = new Set<string>();
  #reading: { prompt: string | undefined; tokens: number } | undefined;

  /** The id of the operator's prompt in flight, if any. */
  get own(): string | undefined {
    return this.#own;
  }

  /** The prompt `_x.ai/queue/changed` last reported as running. */
  get running(): string | undefined {
    return this.#running;
  }

  begin(id: string): void {
    this.#own = id;
  }

  end(): void {
    this.#own = undefined;
  }

  setRunning(id: string | undefined): void {
    this.#running = id;
  }

  isOwn(id: string | undefined): boolean {
    return id !== undefined && id === this.#own;
  }

  /** The prompt an update belongs to: its own id, else the running one. */
  promptOf(explicit: string | undefined): string | undefined {
    return explicit ?? this.#running;
  }

  /**
   * Records the prompt of a `tool_call` update that carries one. A second,
   * different prompt for the same call makes it ownerless for good, so a
   * later own `tool_call` cannot claim a call another prompt made.
   */
  recordToolCall(toolCallId: string, promptId: string): void {
    const known = this.#calls.get(toolCallId);
    if (known === undefined) this.#calls.set(toolCallId, promptId);
    else if (known !== promptId) this.#calls.set(toolCallId, null);
  }

  /** Whether a permission request for this call may reach the operator. */
  permissionIsOwn(toolCallId: string): boolean {
    if (this.#refused.has(toolCallId)) return false;
    const prompt = this.#calls.get(toolCallId);
    return prompt !== undefined && prompt !== null && this.isOwn(prompt);
  }

  /** A refused call stays refused, whatever arrives for it later. */
  refuse(toolCallId: string): void {
    this.#refused.add(toolCallId);
  }

  /** A `response_completed` reading, held until its `turn_completed`. */
  recordReading(tokens: number): void {
    this.#reading = { prompt: this.#running, tokens };
  }

  /**
   * The reading for the prompt `turn_completed` closed, or undefined when
   * the reading was taken while another prompt (or none) was running.
   */
  takeReading(completed: string): number | undefined {
    const reading = this.#reading;
    this.#reading = undefined;
    return reading?.prompt === completed ? reading.tokens : undefined;
  }
}
