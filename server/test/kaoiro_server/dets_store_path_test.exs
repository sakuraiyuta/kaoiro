defmodule KaoiroServer.DetsStorePathTest do
  use ExUnit.Case, async: false

  import Bitwise

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.ClearWatermarks
  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.IngressOrder
  alias KaoiroServer.PermissionModes
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionStarts
  alias KaoiroServer.TokenDenylist
  alias KaoiroServer.Users

  test "all DETS stores narrow their own parent before opening" do
    root =
      Path.join(System.tmp_dir!(), "kaoiro_dets_parent_#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm_rf(root) end)

    [
      SessionPointers,
      AgentDirectory,
      PermissionModes,
      ClearWatermarks,
      SessionStarts,
      IngressOrder,
      DeliveryStates,
      TokenDenylist,
      Users
    ]
    |> Enum.each(fn store ->
      name = String.to_atom("#{store}_#{System.unique_integer([:positive])}")
      parent = Path.join(root, Atom.to_string(name))
      path = Path.join(parent, "store.dets")
      File.mkdir_p!(parent)
      File.chmod!(parent, 0o755)

      {:ok, pid} = store.start_link(name: name, path: path)
      on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)

      assert %{mode: mode} = File.stat!(parent)
      assert band(mode, 0o777) == 0o700
    end)
  end

  test "dedicated parent is required instead of chmodding the shared temporary directory" do
    path = Path.join(System.tmp_dir!(), "kaoiro_dets_store_path_test.dets")

    assert_raise ArgumentError, ~r/dedicated directory/, fn ->
      KaoiroServer.DetsStorePath.prepare_parent!(path)
    end
  end
end
