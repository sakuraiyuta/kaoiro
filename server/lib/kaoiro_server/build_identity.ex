defmodule KaoiroServer.BuildIdentity do
  @moduledoc """
  Shared value-domain validation for build identity (issue #228 round 2,
  ふじ MF-3 差し戻し): `revision` is either the literal `"unknown"` or a
  lowercase 40-hex-digit git SHA; `dirty` is a plain boolean. Distinct from
  ADR-0015's protocol `version` — see docs/adr/0053-build-identity.md.

  Used both when `HealthController` reads the build-time-baked
  `build-info.json` (server's own identity) and when `RunnerChannel` parses
  a runner's `register` payload (a connected runner's identity), so the two
  boundaries cannot silently diverge on what counts as a well-formed
  revision. A value outside this domain is a TYPE/SHAPE breach and is
  rejected at its boundary (structural validation) — this module never
  judges whether a well-formed value is the "right" one; SHA equality
  checking against another artifact stays observability-only elsewhere
  (dashboard warning), never enforcement (issue #230's scope).
  """

  @revision_re ~r/\A[0-9a-f]{40}\z/

  @doc "True for the literal \"unknown\" or a lowercase 40-hex-digit SHA."
  @spec valid_revision?(term()) :: boolean()
  def valid_revision?("unknown"), do: true
  def valid_revision?(v) when is_binary(v), do: Regex.match?(@revision_re, v)
  def valid_revision?(_), do: false
end
