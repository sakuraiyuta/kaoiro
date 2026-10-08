defmodule KaoiroServer.DeliveryPolicies do
  @moduledoc "Durable per-agent policy and permanent revision allocator. Uncertain I/O latches unknown until restart."
  use GenServer
  alias KaoiroServer.{DetsStorePath, TokenDenylist, WorkStore}
  alias KaoiroServer.DeliveryPolicies.State
  @timeout 5_000

  def resolved_path do
    Application.get_env(
      :kaoiro_server,
      :delivery_policies_path,
      DetsStorePath.default_path("delivery_policies.dets")
    )
  end

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, resolved_path())
    GenServer.start_link(__MODULE__, {name, path, opts}, name: name)
  end

  def get(id, server \\ __MODULE__), do: call(server, {:get, id})
  def ensure(id, policy \\ :on, server \\ __MODULE__), do: call(server, {:ensure, id, policy})

  def compare_and_set(id, policy, expected, server \\ __MODULE__),
    do: call(server, {:cas, id, policy, expected})

  def delete(id, server \\ __MODULE__), do: call(server, {:delete, id})
  def snapshot(id, server \\ __MODULE__), do: call(server, {:snapshot, id})

  defp call(server, message) do
    GenServer.call(server, message, @timeout)
  catch
    :exit, _ -> {:error, :policy_unknown}
  end

  @impl true
  def init({name, path, opts}) do
    state = %{
      table: nil,
      dirty: false,
      io: Keyword.get(opts, :io, :dets),
      denylist: Keyword.get(opts, :denylist, TokenDenylist),
      work_store: Keyword.get(opts, :work_store, WorkStore),
      after_sync: Keyword.get(opts, :test_after_sync, fn _stage -> :ok end)
    }

    state =
      try do
        DetsStorePath.prepare_parent!(path)
        {:ok, ^name} = state.io.open_file(name, file: String.to_charlist(path), repair: false)
        opened = %{state | table: name}

        try do
          File.chmod!(path, 0o600)
          :ok = purge_revoked(opened)
          opened
        rescue
          _ -> %{opened | dirty: true}
        catch
          _, _ -> %{opened | dirty: true}
        end
      rescue
        _ -> %{state | dirty: true}
      catch
        _, _ -> %{state | dirty: true}
      end

    {:ok, state}
  end

  @impl true
  def terminate(_, %{table: nil}), do: :ok
  def terminate(_, state), do: state.io.close(state.table)

  @impl true
  def handle_call({:get, id}, _from, state), do: {:reply, read(state, id), state}

  def handle_call({:snapshot, id}, _from, state) do
    result =
      with {:ok, row} <- read(state, id),
           snapshot <- GenServer.call(state.work_store, {:delivery_snapshot, id}, 1_000),
           do: {:ok, row, snapshot}

    {:reply, result, state}
  catch
    :exit, _ -> {:reply, {:error, :policy_unknown}, state}
  end

  def handle_call({:ensure, id, policy}, _from, state) do
    case readable(state, id) do
      {:ok, row, _} when is_map(row) -> {:reply, {:ok, row}, state}
      {:ok, nil, counter} -> commit(state, id, State.change(nil, counter, policy, 0))
      error -> {:reply, error, state}
    end
  end

  def handle_call({:cas, id, policy, expected}, _from, state) do
    case readable(state, id) do
      {:ok, row, counter} -> commit(state, id, State.change(row, counter, policy, expected))
      error -> {:reply, error, state}
    end
  end

  def handle_call({:delete, id}, _from, state) do
    try do
      true = not state.dirty and state.table != nil
      true = GenServer.call(state.denylist, {:revoked?, id}, 1_000)
      :ok = state.io.delete(state.table, {:settings, id})
      :ok = state.io.sync(state.table)
      notify(id)
      {:reply, :ok, state}
    rescue
      _ -> {:reply, {:error, :persistence_failed}, %{state | dirty: true}}
    catch
      _, _ -> {:reply, {:error, :persistence_failed}, %{state | dirty: true}}
    end
  end

  defp read(state, id) do
    case readable(state, id) do
      {:ok, row, _counter} -> {:ok, row}
      error -> error
    end
  end

  defp readable(%{dirty: true}, _), do: {:error, :policy_unknown}
  defp readable(%{table: nil}, _), do: {:error, :policy_unknown}

  defp readable(state, id) do
    false = GenServer.call(state.denylist, {:revoked?, id}, 1_000)
    row = lookup(state, {:settings, id})
    counter = lookup(state, {:counter, id})
    if State.valid?(row, counter), do: {:ok, row, counter}, else: {:error, :policy_unknown}
  rescue
    _ -> {:error, :policy_unknown}
  catch
    _, _ -> {:error, :policy_unknown}
  end

  defp lookup(state, key) do
    case state.io.lookup(state.table, key) do
      [] -> nil
      [{^key, value}] -> value
    end
  end

  defp commit(state, _id, {:error, _, _} = error), do: {:reply, error, state}
  defp commit(state, _id, {:error, _} = error), do: {:reply, error, state}

  defp commit(state, id, {:ok, row}) do
    try do
      :ok = state.io.insert(state.table, {{:counter, id}, row.revision})
      :ok = state.io.sync(state.table)
      state.after_sync.(:counter)
      :ok = state.io.insert(state.table, {{:settings, id}, row})
      :ok = state.io.sync(state.table)
      notify(id)
      state.after_sync.(:row)
      {:reply, {:ok, row}, state}
    rescue
      _ -> {:reply, {:error, :persistence_failed}, %{state | dirty: true}}
    catch
      _, _ -> {:reply, {:error, :persistence_failed}, %{state | dirty: true}}
    end
  end

  defp notify(id),
    do:
      Phoenix.PubSub.broadcast(
        KaoiroServer.PubSub,
        "delivery-policy",
        {:delivery_policy_refresh, id}
      )

  defp purge_revoked(state) do
    revoked = GenServer.call(state.denylist, :all, 1_000)
    true = is_map(revoked)
    Enum.each(revoked, fn {id, _} -> :ok = state.io.delete(state.table, {:settings, id}) end)
    state.io.sync(state.table)
  end
end
