defmodule KaoiroServer.BuildIdentity do
  @moduledoc """
  Shared value-domain validation for build identity (issue #228 round 2,
  ふじ MF-3 差し戻し): `revision` is either the literal `"unknown"` or a
  lowercase 40-hex-digit git SHA; `dirty` is a plain boolean; `version` is
  the CalVer project version and `channel` is `"dev"` or `"release"`.
  Distinct from ADR-0015's protocol `version` — see docs/adr/0053-build-identity.md.

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
  @version_re ~r/\A\d{4}\.(?:[1-9]|1[0-2])\.\d+\z/

  @doc "True for the literal \"unknown\" or a lowercase 40-hex-digit SHA."
  @spec valid_revision?(term()) :: boolean()
  def valid_revision?("unknown"), do: true
  def valid_revision?(v) when is_binary(v), do: Regex.match?(@revision_re, v)
  def valid_revision?(_), do: false

  @doc "True for a CalVer project version in YYYY.M.PATCH form or unknown."
  @spec valid_version?(term()) :: boolean()
  def valid_version?("unknown"), do: true
  def valid_version?(v) when is_binary(v), do: Regex.match?(@version_re, v)
  def valid_version?(_), do: false

  @doc "True for a supported build channel."
  @spec valid_channel?(term()) :: boolean()
  def valid_channel?(channel) when channel in ["dev", "release"], do: true
  def valid_channel?(_), do: false

  @doc "True when a release also has clean, known provenance."
  @spec valid_identity?(term(), term(), term(), term()) :: boolean()
  def valid_identity?(revision, dirty, version, channel) do
    is_boolean(dirty) and
      valid_revision?(revision) and
      valid_version?(version) and
      valid_channel?(channel) and
      (channel != "release" or
         (dirty == false and revision != "unknown" and version != "unknown"))
  end
end
