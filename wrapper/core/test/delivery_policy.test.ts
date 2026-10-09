import { describe, expect, it } from "vitest";
import { DeliveryPolicyController } from "../src/delivery_policy.js";

function supporting(controller = new DeliveryPolicyController()) {
  const join = controller.beginJoin();
  controller.acceptJoin({ delivery_policy: "v1" }, join);
  return { controller, join };
}

describe("delivery policy controller", () => {
  it("default construction and supporting joins remain fenced until a valid row", () => {
    const controller = new DeliveryPolicyController();
    expect(controller.decision()).toEqual({ allowed: false, reason: "local_policy_disabled" });
    const { join } = supporting(controller);
    expect(controller.decision().allowed).toBe(false);
    expect(controller.apply({ revision: 1, policy: "on" }, join).ack).toEqual({ join, revision: 1 });
    expect(controller.decision()).toEqual({ allowed: true, revision: 1, policy: "on" });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", undefined, null])(
    "rejects invalid revision %s without opening or ack", revision => {
      const { controller, join } = supporting();
      controller.apply({ revision: 1, policy: "on" }, join);
      expect(controller.apply({ revision, policy: "on" }, join).ack).toBeUndefined();
      expect(controller.decision().allowed).toBe(false);
      expect(controller.decision().revision).toBe(1);
    },
  );

  it.each(["unknown", "ON", true, 0, undefined, null])("rejects invalid policy %s", policy => {
    const { controller, join } = supporting();
    expect(controller.apply({ revision: 1, policy }, join).ack).toBeUndefined();
    expect(controller.decision().allowed).toBe(false);
  });

  it.each([null, [], "on", {}])("rejects malformed row %s", payload => {
    const { controller, join } = supporting();
    expect(controller.apply(payload, join).ack).toBeUndefined();
    expect(controller.decision().allowed).toBe(false);
  });

  it("installs off before exposing an ack and only a higher on reopens", () => {
    const { controller, join } = supporting();
    controller.apply({ revision: 1, policy: "on" }, join);
    const result = controller.apply({ revision: 2, policy: "off" }, join);
    expect(controller.decision()).toEqual({ allowed: false, revision: 2, policy: "off", reason: "local_policy_disabled" });
    expect(controller.isCurrentAck(result.ack!)).toBe(true);
    expect(controller.apply({ revision: 1, policy: "on" }, join).ack).toBeUndefined();
    expect(controller.decision().allowed).toBe(false);
    controller.apply({ revision: 3, policy: "on" }, join);
    expect(controller.decision().allowed).toBe(true);
    expect(controller.isCurrentAck(result.ack!)).toBe(false);
  });

  it("high-water 5 then supporting rejoin revision 2 stays fenced and diagnoses once per join", () => {
    const { controller, join } = supporting();
    const old = controller.apply({ revision: 5, policy: "on" }, join).ack!;
    controller.disconnect();
    const next = supporting(controller).join;
    const lower = controller.apply({ revision: 2, policy: "on" }, next);
    expect(lower).toEqual({ diagnostic: { event: "delivery_policy_revision_below_high_water", revision: 2, high_water: 5 } });
    expect(controller.decision()).toEqual({ allowed: false, revision: 5, policy: "on", reason: "local_policy_disabled" });
    expect(controller.apply({ revision: 2, policy: "on" }, next)).toEqual({});
    expect(controller.isCurrentAck(old)).toBe(false);
    const another = supporting(controller).join;
    expect(controller.apply({ revision: 2, policy: "on" }, another).diagnostic).toBeDefined();
    expect(controller.apply({ revision: 5, policy: "on" }, another).ack).toBeDefined();
    expect(controller.decision().allowed).toBe(true);
  });

  it("equal conflicting rows quarantine across rejoin; malformed rows can recover identically", () => {
    const { controller, join } = supporting();
    controller.apply({ revision: 1, policy: "on" }, join);
    controller.apply({}, join);
    expect(controller.apply({ revision: 1, policy: "on" }, join).ack).toBeDefined();
    controller.apply({ revision: 1, policy: "off" }, join);
    expect(controller.decision().allowed).toBe(false);
    const next = supporting(controller).join;
    expect(controller.apply({ revision: 1, policy: "on" }, next).ack).toBeUndefined();
    controller.apply({ revision: 2, policy: "on" }, next);
    expect(controller.decision().allowed).toBe(true);
  });

  it.each([[], ["on"], ["off"], ["off", "on"], ["on", "off"]] as const)(
    "old-server history %j retains the last valid off fence", (...history) => {
      const { controller, join } = supporting();
      history.forEach((policy, index) => controller.apply({ revision: index + 1, policy }, join));
      controller.disconnect();
      const legacy = controller.beginJoin();
      controller.acceptJoin({}, legacy);
      expect(controller.decision().allowed).toBe(history.at(-1) !== "off");
      expect(controller.apply({ revision: 99, policy: "on" }, legacy).ack).toBeUndefined();
    },
  );

  it.each([null, "v2", false, {}, undefined])("present invalid echo %s is not an old server", echo => {
    const controller = new DeliveryPolicyController();
    const join = controller.beginJoin();
    controller.acceptJoin({ delivery_policy: echo }, join);
    expect(controller.decision().allowed).toBe(false);
    expect(controller.apply({ revision: 1, policy: "on" }, join).ack).toBeUndefined();
  });

  it("stale join input, stale ack and disconnected input cannot change a new owner", () => {
    const { controller, join } = supporting();
    const ack = controller.apply({ revision: 1, policy: "on" }, join).ack!;
    controller.disconnect();
    expect(controller.isCurrentAck(ack)).toBe(false);
    expect(controller.apply({ revision: 99, policy: "on" }, join)).toEqual({});
    const next = supporting(controller).join;
    controller.acceptJoin({}, join);
    expect(controller.decision().allowed).toBe(false);
    expect(controller.apply({ revision: 1, policy: "on" }, next).ack).toBeDefined();
    expect(controller.isCurrentAck(ack)).toBe(false);
  });
});
