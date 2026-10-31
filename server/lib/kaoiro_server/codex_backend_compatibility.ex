defmodule KaoiroServer.CodexBackendCompatibility do
  @moduledoc """
  Read-only, host-scoped observations for the Codex backend preparation
  workflow. Projections exclude session IDs, cwd, snapshots, envelope contents,
  and lifecycle transaction metadata. Runner observations include the channel
  owner and Node identity needed to bind them to the local service.
  """

  alias KaoiroServer.AgentActivity
  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentStates
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets
  alias KaoiroServer.RunnerConnections
  alias KaoiroServerWeb.AgentId

  @host_id_pattern ~r/^[A-Za-z0-9._-]+$/

  @doc "Reads the current owner's Supervisor entries; never a process-tree census."
  def observe_runner(host_id) do
    with true <- is_binary(host_id) and AgentId.valid?(host_id),
         {:ok, owner} <- RunnerConnections.owner(host_id),
         request_id = Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false),
         {:ok, projection} <- GenServer.call(owner, {:observe_codex_work, request_id}, 6_000),
         :ok <- RunnerConnections.check_owner(host_id, owner) do
      {:ok, Map.put(projection, "owner", inspect(owner))}
    else
      false -> {:error, :invalid_host_id}
      error -> error
    end
  catch
    :exit, _ -> {:error, :runner_observation_unavailable}
  end

  @doc false
  def validate_runner(payload, host, request_id) do
    with %{
           "version" => "0",
           "schema" => 1,
           "host" => ^host,
           "request_id" => ^request_id,
           "build_revision" => revision,
           "pid" => pid,
           "instance_id" => instance,
           "applied_backend" => backend,
           "children" => children,
           "pending_spawns" => spawns,
           "pending_switches" => switches
         } <- payload,
         false <- Map.has_key?(payload, "unavailable"),
         true <- is_binary(revision) and Regex.match?(~r/^[0-9a-f]{40}$/, revision),
         true <- is_integer(pid) and pid > 0,
         true <- is_binary(instance) and Regex.match?(~r/^[0-9a-f-]{36}$/, instance),
         true <- backend in ["exec", "app-server"],
         true <- is_list(children) and Enum.all?(children, &valid_child?/1),
         true <- valid_work_ids?(Enum.map(children, & &1["agent_id"]), host),
         true <- valid_work_ids?(spawns, host) and valid_work_ids?(switches, host) do
      {:ok,
       Map.take(
         payload,
         ~w(version schema host request_id build_revision pid instance_id applied_backend children pending_spawns pending_switches)
       )
       |> Map.update!("children", fn rows ->
         Enum.map(rows, &Map.take(&1, ~w(agent_id stopping restarting reset_pending)))
       end)}
    else
      _ -> {:error, :invalid_runner_observation}
    end
  end

  defp valid_child?(%{"agent_id" => _, "stopping" => s, "restarting" => r, "reset_pending" => p}),
    do: is_boolean(s) and is_boolean(r) and is_boolean(p)

  defp valid_child?(_), do: false

  defp valid_work_ids?(ids, host) when is_list(ids) do
    Enum.all?(ids, &(is_binary(&1) and AgentId.valid?(&1) and AgentId.host_id_from(&1) == host)) and
      length(Enum.uniq(ids)) == length(ids)
  end

  defp valid_work_ids?(_, _), do: false

  @doc "Returns the complete allowlisted host projection or an unavailable error."
  def observe_host(host_id, opts \\ [])

  def observe_host(host_id, opts) when is_binary(host_id) do
    if Regex.match?(@host_id_pattern, host_id) do
      with {:ok, directory} <-
             source(
               :directory,
               fn -> AgentDirectory.all(server(opts, :directory)) end,
               &valid_map?/1
             ),
           {:ok, pointers} <-
             source(
               :pointers,
               fn -> SessionPointers.all(server(opts, :pointers)) end,
               &valid_map?/1
             ),
           {:ok, states} <-
             source(:states, fn -> AgentStates.snapshot(server(opts, :states)) end, &valid_map?/1),
           {:ok, connected} <-
             source(
               :connections,
               fn -> AgentStates.connected_ids(server: server(opts, :states)) end,
               &valid_id_set?/1
             ),
           {:ok, reset_pending} <-
             source(
               :resets,
               fn -> SessionResets.pending_ids(server(opts, :resets)) end,
               &valid_id_set?/1
             ),
           {:ok, transition_pending} <-
             source(
               :transitions,
               fn -> AgentActivity.pending_ids(server(opts, :activity)) end,
               &valid_id_set?/1
             ),
           :ok <- validate_map_ids(directory),
           :ok <- validate_map_ids(pointers),
           :ok <- validate_map_ids(states),
           :ok <- validate_id_set(connected),
           :ok <- validate_id_set(reset_pending),
           :ok <- validate_id_set(transition_pending),
           {:ok, rows} <-
             project_rows(
               host_id,
               directory,
               pointers,
               states,
               connected,
               reset_pending,
               transition_pending
             ) do
        {:ok, %{"schema" => 1, "host" => host_id, "rows" => rows}}
      end
    else
      {:error, :invalid_host_id}
    end
  end

  def observe_host(_host_id, _opts), do: {:error, :invalid_host_id}

  defp server(opts, key) do
    Keyword.get(opts, server_option(key), module_for(key))
  end

  defp server_option(:directory), do: :directory_server
  defp server_option(:pointers), do: :pointers_server
  defp server_option(:states), do: :states_server
  defp server_option(:resets), do: :resets_server
  defp server_option(:activity), do: :activity_server

  defp module_for(:directory), do: AgentDirectory
  defp module_for(:pointers), do: SessionPointers
  defp module_for(:states), do: AgentStates
  defp module_for(:resets), do: SessionResets
  defp module_for(:activity), do: AgentActivity

  defp source(name, reader, valid?) do
    try do
      value = reader.()
      if valid?.(value), do: {:ok, value}, else: {:error, {:observation_unavailable, name}}
    rescue
      _ -> {:error, {:observation_unavailable, name}}
    catch
      :exit, _ -> {:error, {:observation_unavailable, name}}
    end
  end

  defp valid_map?(value), do: is_map(value)
  defp valid_id_set?(%MapSet{}), do: true
  defp valid_id_set?(_), do: false

  defp validate_map_ids(map) do
    if Enum.all?(Map.keys(map), &(is_binary(&1) and AgentId.valid?(&1))),
      do: :ok,
      else: {:error, :invalid_observation}
  end

  defp validate_id_set(ids) do
    if Enum.all?(ids, &(is_binary(&1) and AgentId.valid?(&1))),
      do: :ok,
      else: {:error, :invalid_observation}
  end

  defp project_rows(
         host_id,
         directory,
         pointers,
         states,
         connected,
         reset_pending,
         transition_pending
       ) do
    ids =
      [
        Map.keys(directory),
        Map.keys(pointers),
        Map.keys(states),
        MapSet.to_list(connected),
        MapSet.to_list(reset_pending),
        MapSet.to_list(transition_pending)
      ]
      |> List.flatten()
      |> Enum.uniq()
      |> Enum.filter(&(AgentId.host_id_from(&1) == host_id))
      |> Enum.sort()

    Enum.reduce_while(ids, {:ok, []}, fn id, {:ok, rows} ->
      case project_row(
             id,
             directory,
             pointers,
             states,
             connected,
             reset_pending,
             transition_pending
           ) do
        {:ok, row} -> {:cont, {:ok, [row | rows]}}
        {:error, _} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, rows} -> {:ok, Enum.reverse(rows)}
      error -> error
    end
  end

  defp project_row(id, directory, pointers, states, connected, reset_pending, transition_pending) do
    pointer = Map.get(pointers, id, :missing)
    state = Map.get(states, id)

    with {:ok, pointer_state} <- pointer_state(pointer),
         {:ok, engine} <- engine(pointer, state) do
      {:ok,
       %{
         "id" => id,
         "directory" => Map.has_key?(directory, id),
         "pointer" => pointer_state,
         "engine" => engine,
         "live" => not is_nil(state),
         "connected" => MapSet.member?(connected, id),
         "reset_pending" => MapSet.member?(reset_pending, id),
         "transition_pending" => MapSet.member?(transition_pending, id)
       }}
    end
  end

  defp pointer_state(:missing), do: {:ok, "missing"}

  defp pointer_state(pointer) when is_map(pointer) do
    case Map.fetch(pointer, :session_id) do
      {:ok, nil} -> {:ok, "nil"}
      {:ok, session_id} when is_binary(session_id) and session_id != "" -> {:ok, "non_nil"}
      _ -> {:error, :invalid_observation}
    end
  end

  defp pointer_state(_), do: {:error, :invalid_observation}

  defp engine(pointer, state) do
    pointer_engine = if is_map(pointer), do: Map.get(pointer, :engine), else: nil

    state_ext =
      if is_map(state), do: Map.get(state, "ext", Map.get(state, :ext, :missing)), else: :missing

    with {:ok, pointer_engine} <- normalize_engine(pointer_engine),
         {:ok, ext_engine} <- state_ext_engine(state_ext) do
      case [pointer_engine, ext_engine] |> Enum.reject(&is_nil/1) |> Enum.uniq() do
        [] -> {:ok, nil}
        [engine] -> {:ok, engine}
        _ -> {:error, :invalid_observation}
      end
    else
      _ -> {:error, :invalid_observation}
    end
  end

  defp state_ext_engine(:missing), do: {:ok, nil}
  defp state_ext_engine(nil), do: {:ok, nil}

  defp state_ext_engine(ext) when is_map(ext) do
    ext
    |> Map.get("engine", Map.get(ext, :engine))
    |> normalize_engine()
  end

  defp state_ext_engine(_), do: {:error, :invalid_observation}

  defp normalize_engine(nil), do: {:ok, nil}
  defp normalize_engine(engine) when is_binary(engine) and engine != "", do: {:ok, engine}
  defp normalize_engine(engine) when is_atom(engine), do: {:ok, Atom.to_string(engine)}
  defp normalize_engine(_), do: {:error, :invalid_observation}
end
