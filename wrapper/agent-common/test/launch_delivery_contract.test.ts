import { describe, expect, expectTypeOf, it } from "vitest";
import type { DeliveryMechanisms, LaunchDeliveryPolicyMetadata } from "@kaoiro/protocol";
import fixture from "../../../protocol/fixtures/launch-delivery-policy.json" with { type: "json" };

const enums = fixture.enums satisfies { [K in keyof DeliveryMechanisms]: Record<DeliveryMechanisms[K], boolean> };
expectTypeOf<keyof typeof enums.operator_early>().toEqualTypeOf<DeliveryMechanisms["operator_early"]>();
expectTypeOf<keyof typeof enums.inter_agent_early>().toEqualTypeOf<DeliveryMechanisms["inter_agent_early"]>();
expectTypeOf<keyof typeof enums.inter_agent_yield>().toEqualTypeOf<DeliveryMechanisms["inter_agent_yield"]>();

describe("shared launch delivery fixture", () => {
  it("loads every contract case and checks the canonical metadata shape", () => {
    expect(fixture.valid).toHaveLength(5);
    expect(fixture.invalid).toHaveLength(15);
    const baseline = { version: "v1", ceiling: true,
      mechanisms: { operator_early: "none", inter_agent_early: "steer", inter_agent_yield: "none" },
    } satisfies LaunchDeliveryPolicyMetadata;
    expect(baseline).toEqual(fixture.valid[0]!.value);
    console.info(`launch delivery fixture: ${fixture.valid.length} valid, ${fixture.invalid.length} invalid cases`);
  });
  it.each(fixture.valid)("valid wire example: $name", ({ value }) => {
    expect(value.version).toBe("v1");
    expect(typeof value.ceiling).toBe("boolean");
    for (const modes of [value.mechanisms, ...Object.values(value.persona_overrides ?? {})]) {
      for (const field of Object.keys(enums) as (keyof DeliveryMechanisms)[]) {
        expect(Object.hasOwn(enums[field], modes[field])).toBe(true);
        if (!value.ceiling) expect(modes[field]).toBe("none");
      }
    }
  });
});
