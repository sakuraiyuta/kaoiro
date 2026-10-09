defmodule KaoiroServer.BuildIdentity do
  @moduledoc """
  Shared value-domain validation for build identity (issue #218 round 2,
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
  (dashboard warning), never enforcement (issue #220's scope).
  """

  @revision_re ~r/\A[0-9a-f]{40}\z/
  @version_re ~r/\A\d{4}\.(?:[1-9]|1[0-2])\.\d{1,6}\z/
  @landing_re ~r/\A(2[0-9]{3}|[3-9][0-9]{3})\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.([1-9][0-9]{0,5})\z/

  def supported_formats, do: ["legacy-calver", "landing-calver-v1"]

  def landing_version?(value) when is_binary(value) do
    case Regex.run(@landing_re, value) do
      [_, year, month, day, _] ->
        match?({:ok, _}, Date.from_iso8601("#{year}-#{month}-#{day}"))

      _ ->
        false
    end
  end

  def landing_version?(_), do: false

  def requires_branch?(version), do: landing_version?(version) or version == "untagged"

  def valid_branch?(value) when is_binary(value) do
    byte_size(value) in 1..256 and value != "@" and
      not String.starts_with?(value, "-") and not String.ends_with?(value, ".") and
      not Regex.match?(~r/[\x00-\x20\x7f~^:?*\[\\]/, value) and
      not String.contains?(value, ["..", "@{"]) and
      Enum.all?(String.split(value, "/"), fn part ->
        part != "" and not String.starts_with?(part, ".") and not String.ends_with?(part, ".lock")
      end)
  end

  def valid_branch?(_), do: false

  @doc "True for the literal \"unknown\" or a lowercase 40-hex-digit SHA."
  @spec valid_revision?(term()) :: boolean()
  def valid_revision?("unknown"), do: true
  def valid_revision?(v) when is_binary(v), do: Regex.match?(@revision_re, v)
  def valid_revision?(_), do: false

  @doc "True for a CalVer project version in YYYY.M.PATCH form or unknown."
  @spec valid_version?(term()) :: boolean()
  def valid_version?(value) when value in ["unknown", "untagged"], do: true
  def valid_version?(v) when is_binary(v), do: Regex.match?(@version_re, v) or landing_version?(v)
  def valid_version?(_), do: false

  @doc "True for a supported build channel."
  @spec valid_channel?(term()) :: boolean()
  def valid_channel?(channel) when channel in ["dev", "release"], do: true
  def valid_channel?(_), do: false

  @doc "True when a release also has clean, known provenance."
  @spec valid_identity?(term(), term(), term(), term()) :: boolean()
  def valid_identity?(revision, dirty, version, channel, branch \\ nil) do
    is_boolean(dirty) and
      valid_revision?(revision) and
      valid_version?(version) and
      valid_channel?(channel) and
      if(requires_branch?(version),
        do: valid_branch?(branch),
        else: branch == nil or valid_branch?(branch)
      ) and
      (not landing_version?(version) or (dirty == false and revision != "unknown")) and
      (channel != "release" or
         (dirty == false and revision != "unknown" and version not in ["unknown", "untagged"]))
  end
end
