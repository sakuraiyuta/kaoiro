import type { DeliveryPolicyApplied, DeliveryPolicyJoin, DeliveryPolicyMessage, DeliveryPolicySpawnRequest, InFlightDefaults, SetDeliveryPolicyRequest } from "./delivery-policy.js";
const set: SetDeliveryPolicyRequest = { version: "0", agent_id: "a", policy: "off", expected_revision: 0 };
const applied: DeliveryPolicyApplied = { version: "0", revision: 1 };
const message: DeliveryPolicyMessage = { version: "0", policy: "on", revision: 1 };
const join: DeliveryPolicyJoin = { delivery_policy: "v1" };
const spawn: DeliveryPolicySpawnRequest = { delivery_policy: "off" };
const defaults: InFlightDefaults = { "claude-code": true, codex: false };
// @ts-expect-error Unknown is an observation, not a write value.
const unknown: SetDeliveryPolicyRequest = { version: "0", agent_id: "a", policy: "unknown", expected_revision: 0 };
// @ts-expect-error Engine names are canonical.
const alias: InFlightDefaults = { claude: true };
// @ts-expect-error Defaults are strict booleans.
const text: InFlightDefaults = { codex: "false" };
void [set, applied, message, join, spawn, defaults, unknown, alias, text];
