defmodule KaoiroServer.RunnerConnections do
  @moduledoc "Read-only observation requires the complete, unchanged joined-runner population."

  @registry __MODULE__.Registry
  @epoch {__MODULE__, :boot_identity}

  def child_spec(_opts), do: %{id: __MODULE__, start: {__MODULE__, :start_link, [[]]}}

  def start_link(_opts) do
    # A Registry restart must not certify its newly empty population as complete.
    :persistent_term.put(@epoch, identity())
    :ignore
  end

  def register(host) do
    case Registry.register(@registry, host, nil) do
      {:ok, _} -> :ok
      _ -> {:error, :runner_connections_unavailable}
    end
  rescue
    _ -> {:error, :runner_connections_unavailable}
  catch
    :exit, _ -> {:error, :runner_connections_unavailable}
  end

  def owner(host) do
    with :ok <- check_epoch(),
         [{owner, nil}] <- Registry.lookup(@registry, host),
         %{runner_pid: ^owner} <- KaoiroServer.HostRegistry.get(host) do
      {:ok, owner}
    else
      {:error, _} = error -> error
      _ -> {:error, :ambiguous_runner}
    end
  rescue
    _ -> {:error, :runner_connections_unavailable}
  catch
    :exit, _ -> {:error, :runner_connections_unavailable}
  end

  def check_owner(host, expected) do
    case owner(host) do
      {:ok, ^expected} -> :ok
      {:ok, _} -> {:error, :runner_owner_changed}
      error -> error
    end
  end

  defp check_epoch do
    current = identity()

    if current != nil and current == :persistent_term.get(@epoch, nil),
      do: :ok,
      else: {:error, :runner_registry_changed}
  end

  defp identity do
    with registry when is_pid(registry) <- Process.whereis(@registry),
         [{_, partition, :worker, [Registry.Partition]}] when is_pid(partition) <-
           Supervisor.which_children(registry) do
      {registry, partition}
    else
      _ -> nil
    end
  catch
    :exit, _ -> nil
  end
end
