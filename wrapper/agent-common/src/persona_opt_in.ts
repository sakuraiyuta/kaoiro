export type PersonaOptInSource = "flag" | "persona_list" | "off";

/** Resolves a per-persona opt-in from a global flag and a persona list.
 *
 * - Only the exact flag value `"1"` enables it, whatever the list says.
 * - Otherwise the comma-separated list decides. Each item is trimmed and
 *   must match `^[A-Za-z0-9._-]+$`; one bad item (empty, glob, inner space)
 *   voids the whole list.
 * - The persona id must appear exactly, including case.
 *
 * See docs/reference/configuration/wrapper.md. */
export function personaOptInSource(
  personaId: string,
  flag: string | undefined,
  rawPersonas: string | undefined,
): PersonaOptInSource {
  if (flag === "1") return "flag";
  if (rawPersonas === undefined) return "off";
  const personas = rawPersonas.split(",").map(id => id.trim());
  if (!personas.every(id => /^[A-Za-z0-9._-]+$/.test(id))) return "off";
  return personas.includes(personaId) ? "persona_list" : "off";
}
