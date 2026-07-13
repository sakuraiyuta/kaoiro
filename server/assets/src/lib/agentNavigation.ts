/** Returns the adjacent id in the dashboard's displayed agent order.
 *  Navigation is cyclic; a lone or stale selection has no destination. */
export function adjacentAgentId(
  orderedIds: readonly string[],
  currentId: string,
  direction: -1 | 1,
): string | null {
  if (orderedIds.length <= 1) return null;
  const currentIndex = orderedIds.indexOf(currentId);
  if (currentIndex === -1) return null;
  const nextIndex =
    (currentIndex + direction + orderedIds.length) % orderedIds.length;
  return orderedIds[nextIndex] ?? null;
}
