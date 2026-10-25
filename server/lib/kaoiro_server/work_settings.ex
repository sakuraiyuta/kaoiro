defmodule KaoiroServer.WorkSettings do
  @moduledoc false

  @key {:settings, :work_capacity}
  @keys ~w(work_nominated_per_principal work_active_per_assignee)
  @max_value 2_147_483_647
  @max_revision 9_007_199_254_740_991
  @history_limit 100
  @corrupt "Work admission is closed because {:settings, :work_capacity} is invalid or has an unsupported schema. The only repair is the offline one-key deletion procedure in docs/reference/configuration/server.md#repair-invalid-work-capacity-settings. Dashboard changes, environment overrides and restoring the pre-repair whole-file backup do not repair it."
  @unknown "Work admission is closed because the persisted work settings cannot be determined. Do not retry the update or delete the settings object. Perform a controlled server restart and read the authoritative settings; use the invalid-settings repair only if the object is then diagnosed as invalid."

  def key, do: @key
  def keys, do: @keys
  def empty, do: %{schema: 1, revision: 0, overrides: %{}, changes: []}
  def message(:work_settings_corrupt), do: @corrupt
  def message(:work_settings_unknown), do: @unknown
  def reason(:blocked_invalid), do: :work_settings_corrupt
  def reason(:blocked_unknown), do: :work_settings_unknown

  def valid_value?(value), do: is_integer(value) and value >= 0 and value <= @max_value
  def valid_revision?(value), do: is_integer(value) and value >= 0 and value <= @max_revision

  def valid_patch?(revision, patch) do
    valid_revision?(revision) and is_map(patch) and map_size(patch) in 1..2 and
      Enum.all?(patch, fn {key, value} ->
        key in @keys and (is_nil(value) or valid_value?(value))
      end)
  end

  def validate(value) do
    validate_object(value)
  catch
    _, _ -> {:error, :work_settings_corrupt}
  end

  defp validate_object(
         %{schema: 1, revision: revision, overrides: overrides, changes: changes} = object
       ) do
    valid? =
      map_size(object) == 4 and valid_revision?(revision) and valid_overrides?(overrides) and
        is_list(changes) and length(changes) == min(revision, @history_limit)

    if valid? do
      entries_valid? =
        Enum.all?(Enum.with_index(changes), fn {entry, index} ->
          valid_change?(entry, revision - index)
        end)

      chain_valid? =
        changes
        |> Enum.chunk_every(2, 1, :discard)
        |> Enum.all?(fn [newer, older] ->
          is_map(newer) and is_map(older) and newer[:old_overrides] == older[:new_overrides]
        end)

      starts_at_origin? =
        case List.last(changes) do
          %{revision: 1, old_overrides: old} -> old == %{}
          _ -> true
        end

      if entries_valid? and chain_valid? and starts_at_origin? and
           ((revision == 0 and overrides == %{}) or
              (revision > 0 and hd(changes).new_overrides == overrides)) do
        :ok
      else
        {:error, :work_settings_corrupt}
      end
    else
      {:error, :work_settings_corrupt}
    end
  end

  defp validate_object(_), do: {:error, :work_settings_corrupt}

  defp valid_overrides?(values) when is_map(values) do
    map_size(values) <= 2 and Enum.all?(values, fn {k, v} -> k in @keys and valid_value?(v) end)
  end

  defp valid_overrides?(_), do: false

  defp valid_effective?(values, overrides) when is_map(values) do
    map_size(values) == 2 and Enum.all?(@keys, &valid_value?(values[&1])) and
      Enum.all?(overrides, fn {key, value} -> values[key] == value end)
  end

  defp valid_effective?(_, _), do: false

  defp valid_change?(
         %{
           revision: revision,
           at: at,
           actor: actor,
           old_overrides: old,
           new_overrides: new,
           old_effective: old_effective,
           new_effective: new_effective
         } = entry,
         expected
       ) do
    map_size(entry) == 7 and revision == expected and revision > 0 and
      valid_actor?(actor) and valid_timestamp?(at) and valid_overrides?(old) and
      valid_overrides?(new) and old != new and
      valid_effective?(old_effective, old) and valid_effective?(new_effective, new)
  end

  defp valid_change?(_, _), do: false

  defp valid_actor?(%{"kind" => "user", "id" => id} = actor),
    do: map_size(actor) == 2 and is_binary(id) and byte_size(id) in 1..256 and String.valid?(id)

  defp valid_actor?(_), do: false

  defp valid_timestamp?(at) when is_binary(at) and byte_size(at) <= 40,
    do: match?({:ok, _, _}, DateTime.from_iso8601(at))

  defp valid_timestamp?(_), do: false

  def fallbacks(config) do
    Map.new(@keys, fn key -> {key, Keyword.get(config, String.to_existing_atom(key), 16)} end)
  end

  def effective(object, fallback), do: Map.merge(fallback, object.overrides)

  def snapshot(object, fallback, configured, history? \\ false) do
    sources =
      Map.new(@keys, fn key ->
        source =
          cond do
            Map.has_key?(object.overrides, key) -> "dashboard"
            key in configured -> "config"
            true -> "default"
          end

        {key, source}
      end)

    value = %{
      version: "0",
      state: "ready",
      revision: object.revision,
      overrides: object.overrides,
      effective: effective(object, fallback),
      fallbacks: fallback,
      sources: sources,
      last_change: List.first(object.changes)
    }

    if history?, do: Map.put(value, :changes, object.changes), else: value
  end

  def unavailable(status) do
    reason = reason(status)

    %{
      version: "0",
      state: "unavailable",
      reason: Atom.to_string(reason),
      message: message(reason)
    }
  end

  def update(object, expected, patch, actor, fallback) do
    cond do
      not valid_patch?(expected, patch) or not valid_actor?(actor) ->
        {:error, :invalid_work_settings}

      expected != object.revision ->
        {:error, :revision_conflict}

      true ->
        overrides =
          Enum.reduce(patch, object.overrides, fn
            {key, nil}, acc -> Map.delete(acc, key)
            {key, value}, acc -> Map.put(acc, key, value)
          end)

        cond do
          overrides == object.overrides ->
            {:ok, object}

          object.revision == @max_revision ->
            {:error, :revision_exhausted}

          true ->
            entry = %{
              revision: object.revision + 1,
              at: DateTime.utc_now() |> DateTime.to_iso8601(),
              actor: actor,
              old_overrides: object.overrides,
              new_overrides: overrides,
              old_effective: effective(object, fallback),
              new_effective: Map.merge(fallback, overrides)
            }

            {:ok,
             %{
               object
               | revision: entry.revision,
                 overrides: overrides,
                 changes: Enum.take([entry | object.changes], @history_limit)
             }}
        end
    end
  end

  def load(table, io) do
    case io.(:lookup, [table, @key]) do
      [] ->
        {:ok, nil}

      [{@key, object}] ->
        case validate(object) do
          :ok -> {:ok, object}
          error -> error
        end

      records when is_list(records) ->
        {:error, :work_settings_corrupt}

      _ ->
        {:error, :work_settings_unknown}
    end
  catch
    _, _ -> {:error, :work_settings_unknown}
  end

  def persist(table, object, io) do
    with :ok <- io.(:insert, [table, {@key, object}]),
         :ok <- io.(:sync, [table]),
         {:ok, readback} <- load(table, io) do
      if readback == object, do: :ok, else: {:error, :work_settings_unknown}
    else
      {:error, :work_settings_corrupt} = error -> error
      _ -> {:error, :work_settings_unknown}
    end
  catch
    _, _ -> {:error, :work_settings_unknown}
  end
end
