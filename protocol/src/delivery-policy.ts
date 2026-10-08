export type DeliveryPolicy = "on" | "off";

export interface SetDeliveryPolicyRequest {
  version: "0";
  agent_id: string;
  policy: DeliveryPolicy;
  expected_revision: number;
}

export interface DeliveryPolicyMessage {
  version: "0";
  revision: number;
  policy: DeliveryPolicy;
}

export interface DeliveryPolicyApplied {
  version: "0";
  revision: number;
}

export interface DeliveryPolicyJoin {
  delivery_policy?: "v1";
}

export interface DeliveryPolicyView {
  policy: DeliveryPolicy | "unknown";
  revision?: number;
  applied_revision?: number;
  confirmed: boolean;
  pending: boolean;
  wrapper_support: boolean;
}

export interface DeliveryPolicyChanged {
  version: "0";
  agent_id: string;
  delivery_policy: DeliveryPolicyView;
}

export interface DeliveryPolicyWriteAccepted {
  revision: number;
  status: "pending";
}

export interface DeliveryPolicySpawnRequest {
  delivery_policy?: DeliveryPolicy;
}

export type InFlightDefaults = Partial<Record<"claude-code" | "codex" | "antigravity", boolean>>;
