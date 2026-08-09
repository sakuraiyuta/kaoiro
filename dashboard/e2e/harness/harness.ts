// Entry for the viewport-regression harness (phase-31 31-10). Picks the
// scenario from query params and mounts PRODUCTION components with fixture
// data — no Phoenix server, no WebSocket round-trips.
//
//   ?view=lobby&role=operator|viewer[&taskRing=1]
//   ?view=detail[&pending=permission|question][&attention=1]
//   ?view=overlay&overlay=dialog|drawer
//   ?view=app        — real App.svelte behind fetch mocks (header chrome)
import { mount } from "svelte";
import "../../src/app.css";
import App from "../../src/App.svelte";
import DetailHarness from "./DetailHarness.svelte";
import LobbyHarness from "./LobbyHarness.svelte";
import OverlayHarness from "./OverlayHarness.svelte";
import type { DetailScenario } from "./fixtures";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "lobby";
const target = document.getElementById("app")!;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Static replies for App's auth/session endpoints so the real App renders
 *  its dashboard chrome (header + main). The Phoenix WebSocket keeps
 *  failing/retrying quietly — the specs only assert layout. */
function mockAppFetch(): void {
  window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/session/ticket")) return json({ ticket: "e2e" });
    if (url.includes("/session/auth-methods")) {
      return json({ token: true, oauth: [] });
    }
    if (url.includes("/session")) return json({});
    return new Response("", { status: 404 });
  };
}

if (view === "app") {
  mockAppFetch();
  mount(App, { target });
} else if (view === "detail") {
  const scenario: DetailScenario = {};
  const pending = params.get("pending");
  if (pending === "permission" || pending === "question") {
    scenario.pending = pending;
  }
  if (params.get("attention") === "1") scenario.attention = true;
  if (params.get("taskRing") === "1") scenario.taskRing = true;
  mount(DetailHarness, { target, props: { scenario } });
} else if (view === "overlay") {
  const overlay = params.get("overlay") === "drawer" ? "drawer" : "dialog";
  mount(OverlayHarness, { target, props: { overlay } });
} else {
  mount(LobbyHarness, {
    target,
    props: {
      operator: params.get("role") !== "viewer",
      pending: params.get("pending") === "1",
      taskRing: params.get("taskRing") === "1",
    },
  });
}
