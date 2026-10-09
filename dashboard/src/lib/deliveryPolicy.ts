export type DeliveryPolicy = "on" | "off";
export interface DeliveryMechanisms {
  operator_early: "fold" | "steer" | "hook" | "none";
  inter_agent_early: "fold" | "steer" | "hook" | "none";
  inter_agent_yield: "tool_boundary" | "none";
}
export interface DeliveryPolicyView {
  policy: DeliveryPolicy | "unknown";
  revision?: number;
  applied_revision?: number;
  confirmed: boolean;
  pending: boolean;
  wrapper_support: boolean;
  mechanisms?: DeliveryMechanisms | undefined;
}
// Replace with the shared C3 type when issue 562 lands; see the runner-control contract.
export interface LaunchDeliveryPolicy {
  version: "v1";
  ceiling: boolean;
  mechanisms: DeliveryMechanisms;
  persona_overrides?: Record<string, DeliveryMechanisms>;
}
export interface DeliveryPolicyAccepted { revision: number; status: "pending" }
export const unknownDeliveryPolicy = (): DeliveryPolicyView => ({
  policy: "unknown", confirmed: false, pending: false, wrapper_support: false,
});
export const policyRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const policyObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseDeliveryMechanisms(value: unknown): DeliveryMechanisms | undefined {
  if (!policyObject(value)) return;
  const early = ["fold", "steer", "hook", "none"];
  if (typeof value.operator_early !== "string" || !early.includes(value.operator_early) || typeof value.inter_agent_early !== "string" || !early.includes(value.inter_agent_early) ||
      typeof value.inter_agent_yield !== "string" || !["tool_boundary", "none"].includes(value.inter_agent_yield)) return;
  return { operator_early: value.operator_early as DeliveryMechanisms["operator_early"],
    inter_agent_early: value.inter_agent_early as DeliveryMechanisms["inter_agent_early"],
    inter_agent_yield: value.inter_agent_yield as DeliveryMechanisms["inter_agent_yield"] };
}

export function parseDeliveryPolicy(value: unknown): DeliveryPolicyView {
  if (!policyObject(value) || typeof value.policy !== "string" || !["on", "off", "unknown"].includes(value.policy) ||
      typeof value.confirmed !== "boolean" || typeof value.pending !== "boolean" ||
      typeof value.wrapper_support !== "boolean" ||
      (value.policy !== "unknown" && !policyRevision(value.revision)) ||
      (value.applied_revision !== undefined && !policyRevision(value.applied_revision))) return unknownDeliveryPolicy();
  const known = value.policy !== "unknown";
  const confirmed = known && value.confirmed && !value.pending &&
    (!value.wrapper_support || value.applied_revision === value.revision);
  return { policy: value.policy as DeliveryPolicyView["policy"],
    ...(known ? { revision: value.revision as number } : {}),
    ...(policyRevision(value.applied_revision) ? { applied_revision: value.applied_revision } : {}),
    confirmed, pending: known && !confirmed, wrapper_support: value.wrapper_support,
    mechanisms: parseDeliveryMechanisms(value.mechanisms) };
}

export function parseLaunchDeliveryPolicy(value: unknown): LaunchDeliveryPolicy | undefined {
  if (!policyObject(value) || value.version !== "v1" || typeof value.ceiling !== "boolean") return;
  if (new TextEncoder().encode(JSON.stringify(value)).length > 8192) return;
  const mechanisms = parseDeliveryMechanisms(value.mechanisms);
  if (!mechanisms || (!value.ceiling && hasDeliveryMechanism(mechanisms))) return;
  const overrides: Record<string, DeliveryMechanisms> = Object.create(null);
  if (value.persona_overrides !== undefined) {
    if (!policyObject(value.persona_overrides) || Object.keys(value.persona_overrides).length > 64) return;
    for (const [id, raw] of Object.entries(value.persona_overrides)) {
      const modes = parseDeliveryMechanisms(raw);
      if (!/^[A-Za-z0-9._-]+$/.test(id) || !modes || (!value.ceiling && hasDeliveryMechanism(modes))) return;
      overrides[id] = modes;
    }
  }
  return { version: "v1", ceiling: value.ceiling, mechanisms, persona_overrides: overrides };
}

export function hasDeliveryMechanism(value: DeliveryMechanisms | undefined): boolean {
  return value !== undefined && (value.operator_early !== "none" ||
    value.inter_agent_early !== "none" || value.inter_agent_yield !== "none");
}

export function launchDeliveryDefault(defaults: unknown, engine: string): { policy: DeliveryPolicy; source: "host" | "fallback" | "unknown" } {
  if (defaults === undefined) return { policy: "on", source: "fallback" };
  if (!policyObject(defaults)) return { policy: "on", source: "unknown" };
  if (!Object.hasOwn(defaults, engine)) return { policy: "on", source: "fallback" };
  const value = defaults[engine];
  return typeof value === "boolean"
    ? { policy: value ? "on" : "off", source: "host" }
    : { policy: "on", source: "unknown" };
}

export class DeliveryPolicyError extends Error {
  constructor(public reason: string, public currentRevision?: number, public policy?: DeliveryPolicy,
    public uncertain = false) { super(reason); }
}

export function deliveryPolicyLabel(view: DeliveryPolicyView, ownerConnected: boolean): string {
  if (!ownerConnected) return "接続待ち";
  if (view.policy === "unknown") return "状態不明・通常配送";
  if (view.policy === "off") return `off（新しい割込配送を停止）${view.pending ? "・wrapper 確認待ち" : ""}`;
  if (!hasDeliveryMechanism(view.mechanisms)) return "非対応・通常配送のみ";
  if (!view.wrapper_support) return "実行中の切替は未対応";
  return view.confirmed && view.applied_revision === view.revision ? "on（確認済み）" : "確認待ち";
}
