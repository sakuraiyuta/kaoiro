import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/** Model entry shape shared by the optimistic bootstrap catalog and the
 * authoritative SDK supportedModels() projection. */
export interface SupportedModel {
  value: string;
  display_name: string;
  description: string;
  effort_levels?: EffortLevel[];
}

const FULL_EFFORT = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

const SONNET_EFFORT = [
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly EffortLevel[];

/**
 * Optimistic startup snapshot from SDK 0.3.187 supportedModels(), verified
 * on 2026-07-13. The SDK's account-aware catalog replaces this after init;
 * this snapshot exists so LaunchDialog and a fresh idle AgentDetail can pick
 * the first turn's model / effort before that initialization is possible.
 */
const BOOTSTRAP: readonly SupportedModel[] = [
  {
    value: "default",
    display_name: "Default (recommended)",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
    effort_levels: [...FULL_EFFORT],
  },
  {
    value: "opus[1m]",
    display_name: "Opus",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
    effort_levels: [...FULL_EFFORT],
  },
  {
    value: "claude-fable-5[1m]",
    display_name: "Fable",
    description:
      "Fable 5 · Most capable for your hardest and longest-running tasks · Uses your limits ~2× faster than Opus",
    effort_levels: [...FULL_EFFORT],
  },
  {
    value: "sonnet",
    display_name: "Sonnet",
    description: "Sonnet 4.6 · Efficient for routine tasks",
    effort_levels: [...SONNET_EFFORT],
  },
  {
    value: "sonnet[1m]",
    display_name: "Sonnet (1M context)",
    description: "Sonnet 4.6 with 1M context · Draws from usage credits",
    effort_levels: [...SONNET_EFFORT],
  },
  {
    value: "haiku",
    display_name: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
  {
    value: "claude-opus-4-7",
    display_name: "Opus 4.7",
    description: "Newer version available · select Opus for Opus 4.8",
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
