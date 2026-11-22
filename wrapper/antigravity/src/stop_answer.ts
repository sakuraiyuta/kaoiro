/** `agy` 1.5.14 honoured at most this many continuations per prompt, and the
 *  operator fixed the count there: the tenth is granted, the next request is
 *  answered stop. */
export const MAX_STOP_CONTINUATIONS = 10;

/** The reason text the measured runs used. Other texts that told the model
 *  how to wait did not help, so none is offered. */
export const STOP_CONTINUE_REASON =
  "A background command you started is still running. Do not end your turn yet: wait for it to finish, then reply with its result.";

export interface StopRequest {
  conversationId: string;
  terminationReason: unknown;
  fullyIdle: unknown;
}

/** What the host knows when a Stop hook request arrives. */
export interface StopContext {
  /** The session ID the generation is attached to; a request from any other
   *  conversation comes from a subagent's own loop. */
  sessionId: string | undefined;
  /** Whether the prompt's window is open. */
  windowOpen: boolean;
  /** Whether a stop cause is latched for the input. */
  stopLatched: boolean;
  /** Continuations already granted for this prompt. */
  granted: number;
}

export type StopAnswer =
  | { decision: "continue"; reason: string; counted: true }
  | { decision: "stop"; counted: false };

const stop: StopAnswer = { decision: "stop", counted: false };

/** Keeps the prompt open only while `agy` reports background work for the
 *  generation's own session. The caller counts an answer with `counted`. */
export function answerStop(request: StopRequest, context: StopContext): StopAnswer {
  if (request.conversationId !== context.sessionId) return stop;
  if (!context.windowOpen || context.stopLatched) return stop;
  if (request.terminationReason !== "NO_TOOL_CALL") return stop;
  if (request.fullyIdle !== false) return stop;
  if (context.granted >= MAX_STOP_CONTINUATIONS) return stop;
  return { decision: "continue", reason: STOP_CONTINUE_REASON, counted: true };
}
