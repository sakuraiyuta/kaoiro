import type { Messages } from "../ja";
import { plural } from "./plural";

export const bottomSheet: Messages["bottomSheet"] = {
  pending: "Something is waiting for you",
  backToList: "Back to the list to respond",
  othersNeedAttention: ({ count }) =>
    `${plural(count, "other agent needs", "other agents need")} attention`,
};
