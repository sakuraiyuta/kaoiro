defmodule KaoiroServerWeb.PersonaDelivery do
  @moduledoc "Request-scoped persona authorization over one immutable asset generation."
  alias KaoiroServer.{AgentStates, PersonaAssets}
  alias KaoiroServerWeb.ViewerAgentProjection

  @policy_marker "auth=1"

  def scope(role) when role in [:viewer, :operator, :admin] do
    assets = PersonaAssets.delivery_snapshot()

    allowed =
      if role == :viewer do
        allowed_sets(assets, AgentStates.snapshot())
      else
        :all
      end

    {:ok, %{assets: assets, allowed: allowed}}
  catch
    :exit, _ -> {:error, :unavailable}
  end

  def allowed_sets(assets, agents) do
    claimants =
      Enum.reduce(assets.personas_by_id, %{}, fn {id, persona}, acc ->
        Map.update(acc, persona["sprite_set"], MapSet.new([id]), &MapSet.put(&1, id))
      end)

    Enum.reduce(agents, MapSet.new(), fn {_agent_id, envelope}, allowed ->
      with {:ok, projected} <- ViewerAgentProjection.sanitize(envelope),
           false <- projected["state"] == "disconnected",
           %{"id" => id, "sprite_set" => set} <- projected["persona"],
           true <- is_binary(id) and is_binary(set) and id != "default" and set != "default",
           %{"id" => ^id, "sprite_set" => ^set} <- assets.personas_by_id[id],
           true <- Map.has_key?(assets.manifest["personas"], set),
           %MapSet{} = owners <- claimants[set],
           true <- MapSet.size(owners) == 1 do
        MapSet.put(allowed, set)
      else
        _ -> allowed
      end
    end)
  end

  def manifest(scope) do
    personas =
      for {set, entry} <- scope.assets.manifest["personas"], permitted?(scope, set), into: %{} do
        states =
          Map.new(entry["states"], fn {state, sprite} ->
            {state, Map.update!(sprite, "url", &(&1 <> "&" <> @policy_marker))}
          end)

        {set, Map.put(entry, "states", states)}
      end

    %{"personas" => personas, "version" => version(personas)}
  end

  def version(personas, marker \\ @policy_marker) do
    :crypto.hash(:sha256, :erlang.term_to_binary({marker, personas}, [:deterministic]))
    |> Base.encode16(case: :lower)
    |> binary_part(0, 16)
  end

  def fetch_file(scope, set, file) do
    if permitted?(scope, set), do: Map.fetch(scope.assets.files, {set, file}), else: :error
  end

  defp permitted?(%{allowed: :all}, _set), do: true
  defp permitted?(%{allowed: allowed}, set), do: MapSet.member?(allowed, set)
end
