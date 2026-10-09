import { describe, expect, expectTypeOf, it } from "vitest";
import fixture from "../../protocol/fixtures/launch-delivery-policy.json" with { type: "json" };
import { parseLaunchDeliveryPolicy, type DeliveryMechanisms } from "../src/lib/deliveryPolicy";

const enums = fixture.enums satisfies { [K in keyof DeliveryMechanisms]: Record<DeliveryMechanisms[K], boolean> };
expectTypeOf<keyof typeof enums.operator_early>().toEqualTypeOf<DeliveryMechanisms["operator_early"]>();
expectTypeOf<keyof typeof enums.inter_agent_early>().toEqualTypeOf<DeliveryMechanisms["inter_agent_early"]>();
expectTypeOf<keyof typeof enums.inter_agent_yield>().toEqualTypeOf<DeliveryMechanisms["inter_agent_yield"]>();

describe("public launch delivery client mirror", () => {
  it("loads the full shared fixture", () => {
    expect(fixture.valid).toHaveLength(5);
    expect(fixture.invalid).toHaveLength(15);
    console.info(`launch delivery fixture: ${fixture.valid.length} valid, ${fixture.invalid.length} invalid cases`);
  });
  it.each(fixture.valid)("decodes $name", ({ value }) => {
    expect(parseLaunchDeliveryPolicy(value)).toMatchObject(value);
  });
  it.each(fixture.invalid)("rejects $name", ({ value }) => {
    expect(parseLaunchDeliveryPolicy(value)).toBeUndefined();
  });
});
