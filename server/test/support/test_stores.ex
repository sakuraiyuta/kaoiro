defmodule KaoiroServer.TestStores do
  @moduledoc """
  Resets the process-global stores that channel tests share, between tests.
  Test-only: `test/support` is compiled in `:test` alone.

  Memory-only stores are reset by restart, which drops every entry. The two
  DETS-backed stores keep their rows across a restart, because `init/1`
  reloads the file, so their rows are deleted from the file while the store
  is down. The store is stopped before the delete: a running store that holds
  rows in memory would write them back on its next append.

  Call this only from a case that is `async: false`. ExUnit runs async
  modules before sync ones, so no other test reads these stores meanwhile.
  """

  @memory_stores [KaoiroServer.ConversationStates, KaoiroServer.AgentActivity]
  @dets_stores [KaoiroServer.DeliveryStates, KaoiroServer.SessionLifecycleEvents]

  @spec reset! :: :ok
  def reset! do
    Enum.each(@memory_stores, &restart!/1)
    Enum.each(@dets_stores, &reset_dets!/1)
    :ok
  end

  defp restart!(store) do
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, store)
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, store)
    :ok
  end

  defp reset_dets!(store) do
    # The running store holds its table open under its own name. Read the file
    # name from that table instead of re-deriving the configured path.
    path = :dets.info(store, :filename)
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, store)
    {:ok, ^store} = :dets.open_file(store, file: path)
    :ok = :dets.delete_all_objects(store)
    :ok = :dets.sync(store)
    :ok = :dets.close(store)
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, store)
    :ok
  end
end
