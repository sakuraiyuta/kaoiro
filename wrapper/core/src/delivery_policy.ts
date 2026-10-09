import type { DeliveryPolicy } from "@kaoiro/protocol";

export interface DeliveryPolicyAck {
  readonly join: number;
  readonly revision: number;
}

export interface DeliveryPolicyDecision {
  readonly allowed: boolean;
  readonly revision?: number;
  readonly policy?: DeliveryPolicy;
  readonly reason?: "local_policy_disabled";
}

export interface DeliveryPolicyApplication {
  readonly ack?: DeliveryPolicyAck;
  readonly diagnostic?: {
    readonly event: "delivery_policy_revision_below_high_water" | "delivery_policy_invalid";
    readonly revision?: number;
    readonly high_water?: number;
  };
}

export class DeliveryPolicyController {
  #join = 0;
  #support: "pending" | "legacy" | "v1" | "invalid" = "pending";
  #ready = false;
  #last: { revision: number; policy: DeliveryPolicy } | undefined;
  #quarantinedRevision: number | undefined;
  #lowerDiagnosed = false;

  beginJoin(): number {
    this.#join++;
    this.#support = "pending";
    this.#ready = false;
    this.#lowerDiagnosed = false;
    return this.#join;
  }

  acceptJoin(reply: unknown, join: number): void {
    if (join !== this.#join) return;
    const object = typeof reply === "object" && reply !== null && !Array.isArray(reply) ? reply : {};
    const present = Object.prototype.hasOwnProperty.call(object, "delivery_policy");
    const echo = (object as { delivery_policy?: unknown }).delivery_policy;
    this.#support = !present ? "legacy" : echo === "v1" ? "v1" : "invalid";
    this.#ready = false;
  }

  disconnect(): void {
    this.beginJoin();
  }

  decision(): DeliveryPolicyDecision {
    const allowed = this.#support === "legacy"
      ? this.#last?.policy !== "off"
      : this.#support === "v1" && this.#ready && this.#last?.policy === "on";
    return Object.freeze({ allowed, ...this.#last,
      ...(allowed ? {} : { reason: "local_policy_disabled" as const }) });
  }

  apply(payload: unknown, join: number): DeliveryPolicyApplication {
    if (join !== this.#join || this.#support !== "v1") return {};
    const message = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as { revision?: unknown; policy?: unknown } : {};
    const revision = message.revision;
    const policy = message.policy;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0 ||
        (policy !== "on" && policy !== "off")) {
      this.#ready = false;
      return { diagnostic: { event: "delivery_policy_invalid" } };
    }
    if (this.#last !== undefined && revision < this.#last.revision) {
      if (this.#lowerDiagnosed) return {};
      this.#lowerDiagnosed = true;
      return { diagnostic: { event: "delivery_policy_revision_below_high_water",
        revision, high_water: this.#last.revision } };
    }
    if (this.#last !== undefined && revision === this.#last.revision &&
        (policy !== this.#last.policy || this.#quarantinedRevision === revision)) {
      this.#quarantinedRevision = revision;
      this.#ready = false;
      return { diagnostic: { event: "delivery_policy_invalid" } };
    }
    this.#last = { revision, policy };
    this.#quarantinedRevision = undefined;
    this.#ready = true;
    return { ack: Object.freeze({ join, revision }) };
  }

  isCurrentAck(ack: DeliveryPolicyAck): boolean {
    return ack.join === this.#join && this.#support === "v1" && this.#ready &&
      ack.revision === this.#last?.revision;
  }
}
