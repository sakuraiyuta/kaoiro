// Entry for the viewport-regression harness (phase-31 31-10). Picks the
// scenario from query params and mounts PRODUCTION components with fixture
// data — no Phoenix server, no WebSocket round-trips.
//
//   ?view=lobby&role=operator|viewer[&taskRing=N]
//   ?view=detail[&pending=permission|question][&attention=1]
//     [&mountDelay=ms][&expandOrigin=1][&taskRing=N]
//   ?view=overlay&overlay=dialog|drawer|persona
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
  const taskRing = params.get("taskRing");
  if (taskRing !== null) scenario.taskRing = Number(taskRing);
  if (params.get("sprite") === "1") scenario.sprite = true;
  const scrollTarget = params.get("scrollTarget");
  if (scrollTarget !== null) scenario.scrollTargetIndex = Number(scrollTarget);
  const scrollDelay = params.get("scrollDelay");
  if (scrollDelay !== null) scenario.scrollTargetDelayMs = Number(scrollDelay);
  const mountDelay = params.get("mountDelay");
  if (mountDelay !== null) scenario.mountDetailAfterMs = Number(mountDelay);
  if (params.get("expandOrigin") === "1") scenario.expandFromOrigin = true;
  const agentSwitchTarget = params.get("agentSwitchTarget");
  if (agentSwitchTarget !== null) {
    scenario.agentSwitchTargetIndex = Number(agentSwitchTarget);
  }
  const logCount = params.get("logCount");
  if (logCount !== null) scenario.logCount = Number(logCount);
  mount(DetailHarness, { target, props: { scenario } });
} else if (view === "overlay") {
  const overlayParam = params.get("overlay");
  const overlay =
    overlayParam === "drawer"
      ? "drawer"
      : overlayParam === "persona"
        ? "persona"
        : overlayParam === "modal-empty"
          ? "modal-empty"
          : "dialog";
  if (overlay === "persona") {
    // issue #232 MF-3 a11y spec: PersonaDetailDialog fetches its detail
    // over GET /api/personas/:id — stub it so the modal actually renders
    // content (an initial-focus/Tab-trap spec needs SOME focusable
    // elements inside besides the close button).
    window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/api/personas/")) {
        return json({
          id: "fuji",
          name: "ふじ",
          sprite_set: "fuji",
          version: "1.0.0",
          license: "CC0-1.0",
          min_kaoiro_version: "0.1.0",
          states: ["idle"],
          description: "e2e fixture persona",
          author: "e2e",
          homepage: "https://example.test/fuji",
          personality: "e2e fixture personality body",
        });
      }
      return new Response("", { status: 404 });
    };
  }
  mount(OverlayHarness, { target, props: { overlay } });
} else {
  mount(LobbyHarness, {
    target,
    props: {
      operator: params.get("role") !== "viewer",
      pending: params.get("pending") === "1",
      taskRing: Number(params.get("taskRing") ?? 0),
    },
  });
}
