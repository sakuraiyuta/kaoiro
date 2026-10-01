import type { WrapperConfig } from "./index.js";

const prolite: WrapperConfig = {
  agent_id: "codex-prolite",
  persona: { id: "codex", name: "Codex", sprite_set: "codex" },
  display_name: "Codex",
  server_url: "ws://localhost/wrapper",
  codex_chatgpt_plan: "prolite",
};

const promax: WrapperConfig = {
  agent_id: "codex-promax",
  persona: { id: "codex", name: "Codex", sprite_set: "codex" },
  display_name: "Codex",
  server_url: "ws://localhost/wrapper",
  codex_chatgpt_plan: "promax",
};

// @ts-expect-error the protocol keeps unknown plan identifiers out of the wire type
const unknownPlan: WrapperConfig["codex_chatgpt_plan"] = "team";

void prolite;
void promax;
void unknownPlan;
