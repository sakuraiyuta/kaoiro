// The UI wording of a delivery policy view. Kept out of deliveryPolicy.ts so
// that module stays free of the Svelte runtime: the Playwright specs import its
// parsers in Node, where `$state` does not exist.
import { hasDeliveryMechanism, type DeliveryPolicyView } from "./deliveryPolicy";
import { msg } from "./i18n/index.svelte";

export function deliveryPolicyLabel(view: DeliveryPolicyView, ownerConnected: boolean): string {
  const t = msg().deliveryPolicy;
  if (!ownerConnected) return t.waitingConnection;
  if (view.policy === "unknown") return t.unknownNormal;
  if (view.policy === "off") return t.off({ pending: view.pending });
  if (!hasDeliveryMechanism(view.mechanisms)) return t.unsupportedNormalOnly;
  if (!view.wrapper_support) return t.switchUnsupported;
  return view.confirmed && view.applied_revision === view.revision ? t.onConfirmed : t.awaitingConfirmation;
}
