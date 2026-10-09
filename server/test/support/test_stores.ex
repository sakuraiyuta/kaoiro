defmodule KaoiroServer.TestStores do
  @moduledoc """
  Resets the process-global stores that channel tests share, between tests.
  Test-only: `test/support` is compiled in `:test` alone.

  Memory-only stores are reset by restart, which drops every entry. The
  DETS-backed stores keep their rows across a restart, because `init/1`
  reloads the file, so their rows are deleted from the file while the store
  is down. The store is stopped before its rows are deleted: a running store
  that holds rows in memory would write them back on its next append.

  `dets_singletons/0` is the ordered list of every DETS-backed store the reset
  covers. The order is part of the contract:

    * a store that reads another store at start comes after it
      (DeliveryPolicies and AgentStatusLines read TokenDenylist), and
    * IngressOrder comes last, after the two stores it seeds from
      (ClearWatermarks and SessionStarts).

  Call this only from a case that is `async: false`. ExUnit runs async
  modules before sync ones, so no other test reads these stores meanwhile.
  See `KaoiroServer.StoreResetCoverageGuardTest` for the coverage check.
  """

  @memory_stores [KaoiroServer.ConversationStates, KaoiroServer.AgentActivity]

  @dets_singletons [
    KaoiroServer.SessionPointers,
    KaoiroServer.PermissionModes,
    KaoiroServer.PermissionSettings,
    KaoiroServer.SessionLifecycleEvents,
    KaoiroServer.DeliveryStates,
    KaoiroServer.WorkStore,
    KaoiroServer.QuagmireSettings,
    KaoiroServer.Users,
    KaoiroServer.TokenDenylist,
    KaoiroServer.DeliveryPolicies,
    KaoiroServer.AgentDirectory,
    KaoiroServer.AgentStatusLines,
    KaoiroServer.ClearWatermarks,
    KaoiroServer.SessionStarts,
    KaoiroServer.IngressOrder
  ]

  @spec dets_singletons :: [module()]
  def dets_singletons, do: @dets_singletons

  @spec memory_stores :: [module()]
  def memory_stores, do: @memory_stores

  @dispatcher KaoiroServerWeb.DeliveryLossDispatcher

  @spec reset! :: :ok
  def reset! do
    # The dispatcher polls DeliveryStates every second. A poll that lands while
    # DeliveryStates is down exits the dispatcher, so it is stopped first and
    # started again after the stores are back (issue 554).
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, @dispatcher)
    Enum.each(@memory_stores, &restart!/1)
    Enum.each(@dets_singletons, &reset_dets!/1)
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, @dispatcher)
    :ok
  end

  defp restart!(store) do
    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, store)
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, store)
    :ok
  end

  defp reset_dets!(store) do
    # `:undefined` means the table is not open, and open_file/2 would then
    # create a file named "undefined" in the working directory. Fail instead.
    path =
      case :dets.info(store, :filename) do
        :undefined -> raise "#{inspect(store)} is not open; its rows cannot be reset"
        file -> file
      end

    :ok = Supervisor.terminate_child(KaoiroServer.Supervisor, store)
    {:ok, ^store} = :dets.open_file(store, file: path)
    :ok = :dets.delete_all_objects(store)
    :ok = :dets.sync(store)
    :ok = :dets.close(store)
    {:ok, _pid} = Supervisor.restart_child(KaoiroServer.Supervisor, store)
    :ok
  end
end
