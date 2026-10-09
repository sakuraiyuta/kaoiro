import fixture from "../../../protocol/fixtures/launch-delivery-policy.json" with { type: "json" };

export const launchDeliveryContract = {
  in_flight_defaults: fixture.in_flight_defaults,
  launch_delivery_policy: fixture.valid[0]!.value,
};
