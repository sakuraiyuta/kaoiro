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
  const personas = deliveryPersonaList(rawPersonas);
  return personas.includes(personaId) ? "persona_list" : "off";
}

export function deliveryPersonaList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const personas = raw.split(",").map(id => id.trim());
  return personas.every(id => /^[A-Za-z0-9._-]+$/.test(id)) ? [...new Set(personas)] : [];
}

/** The `flag` argument of `personaOptInSource` for a flag that may also be set
 *  in runner.config.json (issue #469). The variable wins whenever it is set
 *  and non-empty, passed through verbatim, so variable "0" beats config
 *  `true`. Otherwise config `true` is the global opt-in ("1"). Config `false`
 *  and absent are the same: no global opt-in, which never overrides a
 *  persona-list opt-in. */
export function flagArgument(
  variable: string | undefined,
  configValue: boolean | undefined,
): string | undefined {
  if (variable !== undefined && variable !== "") return variable;
  return configValue === true ? "1" : undefined;
}
