import type { EngineModelInfo } from "@kaoiro/protocol";

const SNAPSHOT_1_1_26: readonly EngineModelInfo[] = [
  { value: "", display_name: "account default" },
  { value: "gemini-3.6-flash-high", display_name: "Gemini 3.6 Flash High" },
  { value: "gemini-3.6-flash-medium", display_name: "Gemini 3.6 Flash Medium" },
  { value: "gemini-3.6-flash-low", display_name: "Gemini 3.6 Flash Low" },
  { value: "gemini-3.1-pro-high", display_name: "Gemini 3.1 Pro High" },
  { value: "gemini-3.1-pro-low", display_name: "Gemini 3.1 Pro Low" },
  { value: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
  { value: "claude-opus-4-6-thinking", display_name: "Claude Opus 4.6 Thinking" },
  { value: "gpt-oss-120b-medium", display_name: "GPT-OSS 120B Medium" },
];

function copy(entries: readonly EngineModelInfo[]): EngineModelInfo[] {
  return entries.map((entry) => ({ ...entry }));
}

export function antigravityCatalogSnapshot(): EngineModelInfo[] {
  return copy(SNAPSHOT_1_1_26);
}

export function catalogFromAgyModels(slugs: readonly string[]): EngineModelInfo[] {
  const deduplicated = [...new Set(slugs.filter((slug) => slug !== ""))];
  return [
    { value: "", display_name: "account default" },
    ...deduplicated.map((value) => ({ value, display_name: value })),
  ];
}

const AGY_MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Parses `agy models` stdout. Progress belongs to stderr and is deliberately absent here. */
export function parseAgyModelsOutput(output: string): EngineModelInfo[] | null {
  const models = new Map<string, string>();
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const rawLine of lines) {
    if (rawLine === "") return null;
    const fields = rawLine.split("\t");
    if (fields.length > 2) return null;
    const slug = fields[0]!;
    if (!AGY_MODEL_SLUG.test(slug)) return null;
    const displayName = fields.length === 2 ? fields[1]! : slug;
    if (displayName === "") return null;
    if (!models.has(slug)) models.set(slug, displayName);
  }
  return models.size === 0
    ? null
    : [{ value: "", display_name: "account default" }, ...[...models].map(([value, display_name]) => ({ value, display_name }))];
}

export const ANTIGRAVITY_ENGINE = {
  id: "antigravity" as const,
  supportedModels: antigravityCatalogSnapshot,
};
