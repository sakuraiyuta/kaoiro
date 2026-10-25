import type { WorkCapacityDiagnostic } from "@kaoiro/protocol";
const scopes: Record<string, readonly string[]> = {
  work_max_records: ["store"],
  work_active_per_assignee: ["assignee"],
  work_nominated_per_principal: ["director", "assignee"],
  work_receipts_per_work_principal: ["work_principal"],
  work_receipts_per_principal: ["principal"],
  work_pending_transfers: ["holds", "transfers"],
  work_verdicts_per_work: ["work"],
  work_accepted_verdicts_per_work: ["work"],
  work_links_per_work: ["work"],
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseWorkCapacityDiagnostic(value: unknown): WorkCapacityDiagnostic | null {
  if (!object(value) || typeof value.limit !== "string" || typeof value.scope !== "string" ||
      !Object.hasOwn(scopes, value.limit) || !scopes[value.limit]?.includes(value.scope) ||
      !Number.isSafeInteger(value.maximum) || (value.maximum as number) <= 0) return null;
  return { limit: value.limit, scope: value.scope, maximum: value.maximum as number };
}
