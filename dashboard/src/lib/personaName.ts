import type { DirectoryEntry, Envelope, Persona } from "./protocol";

/** Resolve live identity first, then the restart-surviving directory. The
 *  directory fallback is needed for durable history that names an agent no
 *  longer present in the live map. A live agent always has a concrete persona,
 *  including the `default` persona, so the fallback does not replace live
 *  identity. The "directory-only IA" case in
 *  `responseTimeline.integration.test.ts` pins this fallback. Do not "fix" or
 *  remove it as part of issue #234 work in App.svelte, AgentCard, or AgentDetail.
 *  Unknown or unresolved ids stay visible as their raw id. */
export function personaForAgent(
  agentId: string,
  agents: Record<string, Envelope>,
  directory?: Record<string, DirectoryEntry>,
): Persona | DirectoryEntry["persona"] | undefined {
  return agents[agentId]?.persona ?? directory?.[agentId]?.persona;
}

export function personaName(
  agentId: string,
  agents: Record<string, Envelope>,
  directory?: Record<string, DirectoryEntry>,
): string {
  return personaForAgent(agentId, agents, directory)?.name ?? agentId;
}
