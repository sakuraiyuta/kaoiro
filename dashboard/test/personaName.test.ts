import { describe, expect, it } from "vitest";
import { personaName } from "../src/lib/personaName";
import type { DirectoryEntry, Envelope } from "../src/lib/protocol";

const agents: Record<string, Envelope> = {
  "live.agent": {
    version: "0",
    agent_id: "live.agent",
    ts: "2026-09-23T00:00:00Z",
    type: "state_change",
    state: "waiting_input",
    persona: { id: "momo", name: "もも", sprite_set: "momo" },
  },
};

const directory: Record<string, DirectoryEntry> = {
  "offline.agent": {
    persona: { id: "ao", name: "あお", sprite_set: "ao" },
    display_name: "あお",
    last_seen: null,
  },
};

describe("personaName (issue #383)", () => {
  it("resolves live and directory-only personas, then falls back to the raw id", () => {
    expect(personaName("live.agent", agents, directory)).toBe("もも");
    expect(personaName("offline.agent", agents, directory)).toBe("あお");
    expect(personaName("unknown.agent", agents, directory)).toBe("unknown.agent");
  });
});
