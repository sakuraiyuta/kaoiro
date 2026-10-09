defmodule KaoiroServer.ReleaseFleet do
  @moduledoc "Read-only, bounded build identities for the local release RPC."

  @call_timeout 1_000
  @max_bytes 524_288

  def snapshot_json do
    hosts = GenServer.call(KaoiroServer.HostRegistry, {:snapshot, []}, @call_timeout)
    wrappers = GenServer.call(KaoiroServer.WrapperBuildInfos, :snapshot, @call_timeout)

    json =
      Jason.encode!(%{
        schema: 1,
        hosts: project(hosts),
        wrappers: project(wrappers)
      })

    if byte_size(json) > @max_bytes, do: raise("release fleet snapshot exceeds byte bound")
    json
  end

  defp project(entries) when map_size(entries) <= 1_000 do
    entries
    |> Enum.sort_by(fn {id, _} -> id end)
    |> Enum.map(fn {id, info} ->
      %{id: id}
      |> Map.merge(
        Map.new(
          [
            {"build_revision", :build_revision},
            {"build_dirty", :build_dirty},
            {"build_version", :build_version},
            {"build_channel", :build_channel},
            {"build_branch", :build_branch}
          ],
          fn {key, atom} -> {key, Map.get(info, key, Map.get(info, atom))} end
        )
      )
    end)
  end
end
