defmodule KaoiroServerWeb.HealthController do
  @moduledoc """
  GET /api/health (issue #228, build identity). Reports two DELIBERATELY
  distinct concepts, never conflated:

  - `protocol_version` — ADR-0015's wire message-shape compatibility
    stamp. Every client/server/runner message carries this same literal
    "0" (see e.g. `KaoiroServerWeb.AgentsChannel`'s `warn_on_version_mismatch/3`);
    it changes only when the WIRE SHAPE changes.
  - `build_revision` — the full 40-char git SHA the running image was
    built from ("unknown" when undeterminable: a bare `mix phx.server`
    dev run with no image, or an image built without
    KAOIRO_BUILD_REVISION). It changes on every commit, whether or not
    the wire shape did. Never used to reject anything here — a mismatch
    against a connected runner's own build_revision is surfaced to the
    operator (dashboard), never enforced. See docs/adr for the full
    rationale (docs-only commits / backports / rolling deploy windows all
    make a legitimate SHA mismatch that must not become a hard reject).
  """

  use KaoiroServerWeb, :controller

  @protocol_version "0"

  def status(conn, _params) do
    json(conn, %{
      status: "ok",
      build_revision: build_revision(),
      protocol_version: @protocol_version
    })
  end

  defp build_revision do
    Application.get_env(:kaoiro_server, :build_revision) || "unknown"
  end
end
