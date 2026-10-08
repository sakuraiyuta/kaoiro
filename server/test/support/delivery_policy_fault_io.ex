defmodule KaoiroServer.DeliveryPolicyFaultIO do
  @moduledoc false
  defdelegate open_file(name, opts), to: :dets
  defdelegate close(name), to: :dets
  defdelegate delete(name, key), to: :dets

  def lookup(name, key) do
    if :persistent_term.get({__MODULE__, name}, nil) == :read, do: raise("read fault")
    :dets.lookup(name, key)
  end

  def insert(name, object) do
    if :persistent_term.get({__MODULE__, name}, nil) == :row and
         match?({{:settings, _}, _}, object),
       do: raise("row fault")

    :dets.insert(name, object)
  end

  def sync(name) do
    if :persistent_term.get({__MODULE__, name}, nil) == :sync, do: raise("sync fault")
    :dets.sync(name)
  end
end
