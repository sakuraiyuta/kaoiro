import type * as acp from "@agentclientprotocol/sdk";
import {
  clipText, isFormattedInterAgentMessage, makeLog,
  type Envelope, type WrapperConfig,
} from "@kaoiro/agent-common";

const MAX_HISTORY = 200;

export class MuseHistoryCollector {
  readonly #config: WrapperConfig;
  readonly #sessionId: string;
  #logs: Envelope[] = [];
  #kind: "user" | "assistant" | undefined;
  #text = "";

  constructor(config: WrapperConfig, sessionId: string) {
    this.#config = config;
    this.#sessionId = sessionId;
  }

  update(notification: acp.SessionNotification): void {
    if (notification.sessionId !== this.#sessionId) return;
    const update = notification.update;
    const kind = update.sessionUpdate === "user_message_chunk" ? "user"
      : update.sessionUpdate === "agent_message_chunk" ? "assistant" : undefined;
    if (!kind) {
      if (update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update") this.#flush();
      return;
    }
    if (this.#kind !== kind) this.#flush();
    this.#kind = kind;
    if ((update.sessionUpdate === "user_message_chunk" ||
         update.sessionUpdate === "agent_message_chunk") &&
        update.content.type === "text") this.#text += update.content.text;
  }

  finish(): Envelope[] {
    this.#flush();
    return this.#logs;
  }

  #flush(): void {
    const kind = this.#kind;
    const text = this.#text;
    this.#kind = undefined;
    this.#text = "";
    if (!kind || !text.trim() ||
        (kind === "user" && isFormattedInterAgentMessage(text))) return;
    const clipped = clipText(text);
    const envelope = makeLog(this.#config, "idle", new Date().toISOString(), {
      kind, text: clipped.text, ...(clipped.truncated ? { truncated: true } : {}),
    });
    envelope.session_id = this.#sessionId;
    this.#logs.push(envelope);
    if (this.#logs.length > MAX_HISTORY) this.#logs.shift();
  }
}
