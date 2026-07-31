import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/** Model entry shape shared by the optimistic bootstrap catalog and the
 * authoritative SDK supportedModels() projection. */
export interface SupportedModel {
  value: string;
  display_name: string;
  description: string;
  effort_levels?: EffortLevel[];
  /** Canonical wire model ID this entry resolves to, mirrored from the SDK's
   * ModelInfo.resolvedModel. Read-only metadata; absent = unknown. */
  resolved_model?: string;
}

const FULL_EFFORT = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/**
 * Minimum-floor bootstrap (ADR-0037 F1). Only the `default` alias — which
 * SDK resolves to the account's recommended model at init time — is exposed
 * before init, so LaunchDialog and a fresh idle AgentDetail always have a
 * safe choice. The SDK's account-aware catalog replaces this after init via
 * AgentHost.#refreshSupportedModels(). Naming a specific model / generation
 * here would rot with each Anthropic release, which is why F1 dropped the
 * pre-init full listing.
 */
const BOOTSTRAP: readonly SupportedModel[] = [
  {
    value: "default",
    display_name: "Default (recommended)",
    description: "Account-recommended model · resolved after session start",
    effort_levels: [...FULL_EFFORT],
  },
];

/** Return a defensive copy because envelope consumers may retain or mutate
 * arrays independently of the adapter's startup catalog. */
export function claudeBootstrapCatalog(): SupportedModel[] {
  return BOOTSTRAP.map((model) => ({
    ...model,
    ...(model.effort_levels === undefined
      ? {}
      : { effort_levels: [...model.effort_levels] }),
  }));
}
