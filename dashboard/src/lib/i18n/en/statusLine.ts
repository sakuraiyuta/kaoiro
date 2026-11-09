import type { Messages } from "../ja";

export const statusLine: Messages["statusLine"] = {
  headOmitted: "(beginning omitted: too long)",
  moreAvailable: ({ kb }) => `…more (${kb} KB)`,
  unset: "Not set",
};
