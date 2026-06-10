// Minimal kaoiro dashboard — text/color only (Phase 1.5-3).
//
// Speaks the Phoenix Channels V2 wire protocol directly over a native
// WebSocket (frame: [join_ref, ref, topic, event, payload]; see
// https://hexdocs.pm/phoenix/writing_a_channels_client.html and ADR-0009).
// Zero dependencies on purpose: this doubles as a proof that the public
// protocol is implementable from its documentation alone. The Svelte
// reference dashboard (issue #12) will replace it.
//
// All envelope strings are untrusted and rendered via textContent only.

"use strict";

const TOPIC = "agents:lobby";
const JOIN_REF = "1";
const HEARTBEAT_MS = 30000;
const RECONNECT_MS = 2000;

const statusEl = document.getElementById("status");
const listEl = document.getElementById("agents");

// agent_id -> latest envelope
const agents = new Map();

function render() {
  listEl.replaceChildren();
  const ids = [...agents.keys()].sort();
  for (const id of ids) {
    const envelope = agents.get(id);
    const li = document.createElement("li");
    const name = document.createElement("span");
    const persona = envelope.persona;
    name.textContent =
      (persona && typeof persona.name === "string" ? persona.name : id) +
      " (" + id + "): ";
    const state = document.createElement("span");
    const stateText = String(envelope.state);
    state.textContent = stateText;
    state.className = "state " + stateText.replace(/[^a-z_]/g, "");
    li.append(name, state);
    listEl.append(li);
  }
}

function applyEnvelope(envelope) {
  if (!envelope || typeof envelope.agent_id !== "string") return;
  agents.set(envelope.agent_id, envelope);
  render();
}

function connect() {
  const url =
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host + "/client/websocket?vsn=2.0.0";
  const ws = new WebSocket(url);
  let ref = 1;
  let heartbeatTimer = null;
  const nextRef = () => String(++ref);

  ws.onopen = () => {
    statusEl.textContent = "joining " + TOPIC + "...";
    ws.send(JSON.stringify([JOIN_REF, JOIN_REF, TOPIC, "phx_join", {}]));
    heartbeatTimer = setInterval(() => {
      ws.send(JSON.stringify([null, nextRef(), "phoenix", "heartbeat", {}]));
    }, HEARTBEAT_MS);
  };

  ws.onmessage = (raw) => {
    const [joinRef, msgRef, topic, event, payload] = JSON.parse(raw.data);
    void joinRef;
    if (topic === TOPIC && event === "phx_reply" && msgRef === JOIN_REF) {
      statusEl.textContent =
        payload.status === "ok" ? "connected" : "join failed";
      return;
    }
    if (topic !== TOPIC) return;
    if (event === "snapshot") {
      agents.clear();
      // Batch into the map first; one render covers the whole snapshot
      // (and the empty-snapshot case after clear()).
      for (const envelope of Object.values(payload.agents ?? {})) {
        if (envelope && typeof envelope.agent_id === "string") {
          agents.set(envelope.agent_id, envelope);
        }
      }
      render();
    } else if (event === "envelope") {
      applyEnvelope(payload);
    }
  };

  ws.onclose = () => {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    statusEl.textContent = "disconnected — retrying...";
    setTimeout(connect, RECONNECT_MS);
  };
}

connect();
