defmodule KaoiroServer.ExternalEngine do
  @moduledoc false
  @bundled ~w(claude-code codex antigravity grok muse)
  @operations ~w(spawn resume enumerate_sessions refresh_engine_catalog)
  @snapshot_fields ~w(model model_source effort effort_source)

  def bundled?(id), do: id in @bundled

  def external?(id) when is_binary(id) and byte_size(id) in 1..64 do
    not bundled?(id) and id != "claude" and Regex.match?(~r/\A[a-z][a-z0-9-]*\z/, id)
  end

  def external?(_), do: false

  # Called after the legacy catalog row and model checks.
  def valid_declarations?(rows) do
    counts = Enum.frequencies_by(rows, & &1["id"])

    Enum.all?(rows, fn row ->
      case Map.fetch(row, "operations") do
        :error ->
          true

        {:ok, ops} ->
          external?(row["id"]) and counts[row["id"]] == 1 and
            valid_operations?(ops, row["models"])
      end
    end)
  end

  defp valid_operations?(%{"version" => 1} = ops, models) do
    Enum.all?(@operations, &is_boolean(Map.get(ops, &1, false))) and
      Enum.all?(models, &valid_selection?/1) and
      length(models) == length(Enum.uniq_by(models, & &1["value"]))
  end

  defp valid_operations?(%{"version" => n}, _models) when is_integer(n) and n > 1, do: true
  defp valid_operations?(_ops, _models), do: false

  defp valid_selection?(%{"value" => value} = model) do
    value != "" and
      case Map.fetch(model, "effort_levels") do
        :error -> true
        {:ok, [_ | _] = levels} -> Enum.all?(levels, &(is_binary(&1) and &1 != ""))
        _ -> false
      end
  end

  def catalog_for(host, id, operations) do
    with true <- external?(id) and id in Map.get(host, :capabilities, []),
         %{"operations" => %{"version" => 1} = ops} = row <-
           Enum.find(Map.get(host, :engines, []), &(&1["id"] == id)),
         true <- Enum.all?(operations, &(ops[&1] === true)) do
      {:ok, row}
    else
      _ -> {:error, :engine_not_supported}
    end
  end

  def validate_spawn(row, payload, session_pattern) do
    with false <-
           Enum.any?(
             ~w(permission_mode sandbox network_access approval),
             &Map.has_key?(payload, &1)
           ),
         true <- valid_session?(Map.fetch(payload, "resume_session_id"), session_pattern),
         true <-
           valid_picks?(row["models"], Map.fetch(payload, "model"), Map.fetch(payload, "effort")) do
      :ok
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp valid_session?(:error, _pattern), do: true
  defp valid_session?({:ok, sid}, pattern) when is_binary(sid), do: Regex.match?(pattern, sid)
  defp valid_session?(_, _), do: false

  defp valid_picks?(_models, :error, effort), do: effort == :error

  defp valid_picks?(models, {:ok, value}, effort) do
    case Enum.find(models, &(&1["value"] == value)) do
      nil ->
        false

      _row when effort == :error ->
        true

      row ->
        {:ok, selected} = effort
        selected in Map.get(row, "effort_levels", [])
    end
  end

  def project_envelope(%{} = envelope, engine) when is_binary(engine) do
    ext =
      case envelope["ext"] do
        %{} = ext -> ext
        _ -> %{}
      end

    ext =
      ext
      |> Map.drop(~w(permission_control permission_mode permission))
      |> Map.put("engine", engine)
      |> filter_map("effective", &Map.take(&1, @snapshot_fields))
      |> filter_map("session_capabilities", fn caps ->
        caps
        |> Map.delete("permission_switch_axes")
        |> Map.put("supports_permission_switch", false)
        |> Map.put("supports_permission_mode_switch", false)
      end)

    Map.put(envelope, "ext", ext)
  end

  def project_envelope(envelope, _engine), do: envelope

  defp filter_map(map, key, filter) do
    case Map.fetch(map, key) do
      {:ok, %{} = value} -> Map.put(map, key, filter.(value))
      _ -> Map.delete(map, key)
    end
  end

  def put_snapshot(payload, %{engine: engine, snapshot: snapshot}) when is_map(snapshot) do
    if external?(engine) do
      case Map.take(snapshot, @snapshot_fields) do
        selected when map_size(selected) > 0 -> Map.put(payload, "resume_snapshot", selected)
        _ -> payload
      end
    else
      Map.put(payload, "resume_snapshot", snapshot)
    end
  end

  def put_snapshot(payload, _pointer), do: payload
end
