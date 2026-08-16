// Codex CLI startup orchestration. Kept outside cli.ts so tests can execute
// the same resume bind / initial telemetry path used in production.

import { makeStateChange } from "@kaoiro/agent-common";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import type { IaSidecar } from "@kaoiro/agent-common";
import type { CodexHost } from "./host.js";

export interface CodexStartupContext {
  config: WrapperConfig;
  prompt: string | undefined;
  resumeSessionId: string | undefined;
  host: Pick<CodexHost, "initializeRateLimits" | "statusExtSnapshot">;
  link: {
    setSessionId: (sessionId: string) => void;
    send: (envelope: Envelope) => void;
  };
  sidecar: Pick<IaSidecar, "bind">;
  printState: (envelope: Envelope) => void;
  now: () => string;
}

/**
 * Completes the transport-visible startup sequence before the host enters its
 * turn loop. Resume binding precedes the initial rollout read, and an
 * idle-wait announcement observes any snapshot that read found.
 */
export async function prepareCodexStartup(
  context: CodexStartupContext,
): Promise<void> {
  if (context.resumeSessionId !== undefined) {
    context.link.setSessionId(context.resumeSessionId);
    context.sidecar.bind(context.resumeSessionId);
  }
  await context.host.initializeRateLimits();
  if (context.prompt === undefined) {
    const idle = makeStateChange(
      context.config,
      "idle",
      context.now(),
      {},
      context.host.statusExtSnapshot(),
    );
    context.printState(idle);
    context.link.send(idle);
  }
}
