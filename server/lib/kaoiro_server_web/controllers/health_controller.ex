defmodule KaoiroServerWeb.HealthController do
  @moduledoc """
  GET /api/health (issue #228, build identity). Reports two DELIBERATELY
  distinct concepts, never conflated:

  - `protocol_version` — ADR-0015's wire message-shape compatibility
    stamp. Every client/server/runner message carries this same literal
    "0" (see e.g. `KaoiroServerWeb.AgentsChannel`'s `warn_on_version_mismatch/3`);
    it changes only when the WIRE SHAPE changes.
  - `build_version` / `build_channel` — the project CalVer and whether the
    artifact is a tagged main release or a development build.
  - `build_revision` / `build_dirty` — the full 40-char git SHA the running
    image was built from ("unknown" when undeterminable), and whether that
    build had uncommitted changes. Changes on every commit, whether or not
    the wire shape did. Never used to reject anything here — a mismatch
    against a connected runner's own build_revision is surfaced to the
    operator (dashboard), never enforced. See docs/adr for the full
    rationale (docs-only commits / backports / rolling deploy windows all
    make a legitimate SHA mismatch that must not become a hard reject).

  ## MF-1 (issue #228 round 2, ふじ 差し戻し): reads a build-time-baked
  FILE, never a runtime env var

  Round 1 read `System.get_env("KAOIRO_BUILD_REVISION")`, set once from a
  Dockerfile ARG into an ENV. That ENV can be overridden at container-run
  time (`docker run -e`, or `docker-compose.yaml`'s `env_file: .env`),
  letting the image's own identity claim diverge from what it was actually
  built from — the exact "identity that can drift from the running
  artifact" failure ADR-0053 exists to prevent, just moved from
  git-at-runtime (the failure mode ADR-0053 already rejected for the
  runner) to env-at-runtime for the server. `server/Dockerfile`'s final
  stage instead bakes `{revision, dirty}` into an immutable
  `build-info.json` file at `$RELEASE_ROOT/build-info.json` — `RELEASE_ROOT`
  is exported by the Mix-release-generated `bin/server` launcher (points at
  `/app` in our image), never set by a bare `mix phx.server` dev run, which
  is exactly the fallback-to-"unknown" split ADR-0053 wants: dev is
  expected to read "unknown", a production image is expected to read the
  real value baked in at build time.
  """

  use KaoiroServerWeb, :controller

  alias KaoiroServer.BuildIdentity

  @protocol_version "0"

  def status(conn, _params) do
    identity = build_identity()

    json(conn, %{
      status: "ok",
      build_version: identity.version,
      build_channel: identity.channel,
      build_revision: identity.revision,
      build_dirty: identity.dirty,
      protocol_version: @protocol_version
    })
  end

  # MF-3 (value domain): any read failure OR a malformed shape (missing
  # RELEASE_ROOT — bare `mix phx.server` dev, unreadable file, broken JSON,
  # any field outside BuildIdentity's domain)
  # degrades to unknown values — the same fail-soft posture runner's
  # own loadBuildInfo takes on a malformed dist/build-info.json.
  defp build_identity do
    with root when is_binary(root) <- System.get_env("RELEASE_ROOT"),
         {:ok, raw} <- File.read(Path.join(root, "build-info.json")),
         {:ok,
          %{
            "version" => version,
            "channel" => channel,
            "revision" => revision,
            "dirty" => dirty
          }} <- Jason.decode(raw),
         true <- BuildIdentity.valid_identity?(revision, dirty, version, channel) do
      %{version: version, channel: channel, revision: revision, dirty: dirty}
    else
      _ -> %{version: "unknown", channel: "dev", revision: "unknown", dirty: false}
    end
  end
end
