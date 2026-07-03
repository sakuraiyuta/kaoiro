// Question broker — bridges the AskUserQuestion branch of canUseTool to the
// client's structured-question dialog (protocol.md / ADR-0027). Question-side
// twin of PermissionBroker: decide() sends a question_request envelope (initial
// notification) AND fires onPendingChange so the host stamps the authoritative
// pending state onto state_change.ext.pending_question. The promise is held
// until a relayed question_response resolves it, or the shared PendingRegistry
// times out / closes it (deny by cancellation, matching the permission path).

import { randomUUID } from "node:crypto";
import type { QuestionDecision } from "./host.js";
import { PendingRegistry } from "./pending.js";
import { makeQuestionRequest } from "./state.js";
import type {
  Envelope,
  PendingQuestionExt,
  Question,
  WrapperConfig,
} from "./types.js";

/** A client's answer relayed by the server (protocol.md question_response). */
export interface QuestionResponseMessage {
  request_id: string;
  /** Selected answers keyed by question text; ignored when cancelled. */
  answers: Record<string, string>;
  /** true = the operator dismissed the dialog (deny). */
  cancelled?: boolean;
}

export interface QuestionBrokerOptions {
  config: WrapperConfig;
  /** Envelope sink, normally ServerLink#send. */
  send: (envelope: Envelope) => void;
  /** Fires synchronously inside decide() before the Promise is returned, so
   *  the host can stamp ext.pending_question onto the next state_change
   *  (ADR-0027 F3, mirrors PermissionBroker). Fires again with null on
   *  resolve / timeout / close. */
  onPendingChange?: (pending: PendingQuestionExt | null) => void;
  /** Overrides config.permission_timeout_ms (tests). Undefined inherits
   *  config; config undefined = no timeout (SDK default, ADR-0022 F6). */
  timeoutMs?: number;
  /** ISO-8601 timestamp source; injectable for tests. */
  now?: () => string;
  /** request_id source; injectable for tests. */
  newId?: () => string;
}

export class QuestionBroker {
  readonly #options: QuestionBrokerOptions;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #registry: PendingRegistry<QuestionDecision>;

  constructor(options: QuestionBrokerOptions) {
    this.#options = options;
    const configured =
      options.timeoutMs ?? options.config.permission_timeout_ms;
    const timeoutMs = configured === undefined ? null : configured;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId = options.newId ?? randomUUID;
    this.#registry = new PendingRegistry<QuestionDecision>(timeoutMs);
  }

  /** Compatible with AgentHostOptions#decideQuestion. */
  decide(questions: Question[]): Promise<QuestionDecision> {
    const requestId = this.#newId();
    const ts = this.#now();
    const payload: Record<string, unknown> = {
      request_id: requestId,
      questions,
    };
    const pending: PendingQuestionExt = {
      request_id: requestId,
      questions,
      ts,
    };

    // Notify host SYNCHRONOUSLY so the next state_change carries
    // ext.pending_question (ADR-0027 F3), before the legacy envelope.
    this.#options.onPendingChange?.(pending);
    this.#options.send(
      makeQuestionRequest(this.#options.config, ts, payload),
    );

    return new Promise((resolve) => {
      const settle = (decision: QuestionDecision): void => {
        this.#options.onPendingChange?.(null);
        resolve(decision);
      };
      // Timeout / close deny by cancellation, matching the permission path.
      this.#registry.add(requestId, settle, () => ({ cancelled: true }));
    });
  }

  /** Resolves a pending question; late/unknown request_ids are ignored. */
  resolve(response: QuestionResponseMessage): void {
    const resolved: QuestionDecision =
      response.cancelled === true
        ? { cancelled: true }
        : { cancelled: false, answers: response.answers };
    this.#registry.resolve(response.request_id, resolved);
  }

  /** Cancels all in-flight questions (wrapper shutdown). */
  close(): void {
    this.#registry.closeAll({ cancelled: true });
  }
}
