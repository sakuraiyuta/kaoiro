// A WebSocket stand-in that speaks just enough of the Phoenix channel wire
// (serializer 2.0.0: [join_ref, ref, topic, event, payload]) for the real
// App to join `agents:lobby` as an operator and be handed a snapshot and a
// directory. The harness installs it before mounting App, so a spec exercises
// App's own layout with live and offline agents and no server.

export interface LobbyScenario {
  /** Directory entries with no live envelope: the offline section's tiles. */
  offline: number;
  /** Agents with a live envelope: the live grid's cards. */
  live?: number;
  /** Push a complete rooms_snapshot that spreads the live agents over four
   *  rooms (one of them empty, one with a long name). */
  rooms?: boolean;
  stripScenario?: string;
}

function roomsSnapshot(live: number, mode = ""): unknown {
  const placed = ["lobby", "r-review", "r-long"];
  const memberships: Record<string, string> = {};
  for (let index = 0; index < live; index += 1) {
    memberships[`e2e-host.live-${index}`] = placed[index % placed.length]!;
  }
  if (mode === "lobby") return { rooms: [{ id: "lobby", name: null }], memberships: {} };
  if (mode === "unknown") return { rooms: [{ id: "lobby", name: null }], memberships: { "e2e-host.live-0": "missing" }, snapshot_incomplete: true };
  return {
    rooms: [
      { id: "lobby", name: null },
      { id: "r-review", name: "Review" },
      { id: "r-long", name: "Release coordination for the autumn deployment window" },
      { id: "r-empty", name: "Empty" },
    ],
    memberships,
  };
}

function persona() {
  return { id: "e2e", name: "E2E", sprite_set: "e2e" };
}

function directoryEntries(count: number): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    const id = `e2e-host.agent-${String(index).padStart(3, "0")}`;
    entries[id] = {
      persona: persona(),
      display_name: `offline ${index}`,
      last_seen: 1_700_000_000 + index,
    };
  }
  return entries;
}

function liveAgents(count: number, mode = ""): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    const id = `e2e-host.live-${index}`;
    agents[id] = {
      version: "0",
      agent_id: id,
      persona: persona(),
      display_name: `live ${index}`,
      ts: "2026-10-14T00:00:00Z",
      type: "state_change",
      state: mode === "lamp" && index === 1 ? "waiting_question" : "idle",
    };
  }
  return agents;
}

export function installFakeLobbySocket(scenario: LobbyScenario): void {
  const topic = "agents:lobby";

  class FakeLobbySocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeLobbySocket.CONNECTING;
    binaryType = "arraybuffer";
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    protocol = "";

    private roomUpdate = (event: Event) => { this.push("rooms_snapshot", (event as CustomEvent).detail); };

    constructor(readonly url: string) {
      window.addEventListener("e2e:room-snapshot", this.roomUpdate);
      setTimeout(() => {
        this.readyState = FakeLobbySocket.OPEN;
        this.onopen?.({});
      }, 0);
    }

    private deliver(frame: unknown[]): void {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 0);
    }

    private push(event: string, payload: unknown): void {
      this.deliver([null, null, topic, event, payload]);
    }

    send(data: string): void {
      const [joinRef, ref, frameTopic, event] = JSON.parse(data) as [
        string | null,
        string | null,
        string,
        string,
      ];
      const preview = event === "preview_room_move" || event === "preview_room_delete";
      this.deliver([
        joinRef,
        ref,
        frameTopic,
        "phx_reply",
        { status: "ok", response: preview ? { closing_count: 2, member_count: 1 } : {} },
      ]);
      if (event !== "phx_join" || frameTopic !== topic) return;
      this.push("hosts", {
        hosts: { "e2e-host": { personas: [], cwd_allowlist: [] } },
      });
      this.push("snapshot", { agents: liveAgents(scenario.live ?? 0, scenario.stripScenario) });
      this.push("directory", {
        entries: directoryEntries(scenario.offline),
        directory_incomplete: false,
      });
      if (scenario.rooms) this.push("rooms_snapshot", roomsSnapshot(scenario.live ?? 0, scenario.stripScenario));
    }

    close(): void {
      window.removeEventListener("e2e:room-snapshot", this.roomUpdate);
      this.readyState = FakeLobbySocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
  }

  window.WebSocket = FakeLobbySocket as unknown as typeof WebSocket;
}
