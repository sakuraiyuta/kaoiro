// Question broker — bridges the AskUserQuestion branch of canUseTool to the
// client's structured-question dialog (protocol.md / ADR-0027). Question-side
// twin of PermissionBroker: decide() sends a question_request envelope (initial
// notification) AND fires onPendingChange so the host stamps the authoritative
// pending state onto state_change.ext.pending_question. The promise is held
// until a relayed question_response resolves it, or the shared PendingRegistry
// times out / closes it (deny by cancellation, matching the permission path).

import { randomUUID } from "node:crypto";
import type { QuestionResponseMessage } from "@kaoiro/wrapper-core";
import { PendingRegistry } from "./pending.js";
import { makeQuestionRequest } from "./state.js";
import type {
  Envelope,
  PendingQuestionExt,
  Question,
  WrapperConfig,
} from "./types.js";

/** An operator's answer to an AskUserQuestion (ADR-0027). `cancelled` denies
 *  the tool; otherwise `answers` (keyed by question text) is returned to the
 *  engine as the tool's structured answer. */
export interface QuestionDecision {
  cancelled: boolean;
  answers?: Record<string, string>;
}

export type { QuestionResponseMessage } from "@kaoiro/wrapper-core";

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

    // Send the legacy question_request notification FIRST, then notify the
    // host so its authoritative state_change(waiting_question) — carrying
    // ext.pending_question (ADR-0027 F3) — is the LAST non-reply envelope the
    // dashboard renders. Order matters for engines whose host emits that
    // state_change synchronously inside onPendingChange (the codex adapter):
    // if question_request went out after it, the ext-less notification would
    // clobber the dashboard's rendered state and the dialog would not show.
    // The Claude adapter only stamps here and emits its state_change later
    // (host.#askUserQuestion's #apply after decide() runs), so this order is
    // equivalent for it.
    this.#options.send(
      makeQuestionRequest(this.#options.config, ts, payload),
    );
    this.#options.onPendingChange?.(pending);

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
