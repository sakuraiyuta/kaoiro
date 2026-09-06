defmodule KaoiroServer.DetsStorePathTest do
  use ExUnit.Case, async: false

  import Bitwise
  import KaoiroServer.TestTeardown

  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.ClearWatermarks
  alias KaoiroServer.DeliveryStates
  alias KaoiroServer.IngressOrder
  alias KaoiroServer.PermissionModes
  alias KaoiroServer.PersistencePaths
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
      on_exit(fn -> stop_quietly(pid) end)

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

  # issue #217 class, second layer (クロエ #310 round 1 M-1). The test-time
  # scan of the compiled artifact catches an undeclared store before it
  # ships; this catches one at the moment it would actually place its file
  # in the container's temporary directory — the deployment that loses the
  # data on the next recreation.
  test "default_path refuses a filename PersistencePaths does not declare" do
    assert_raise ArgumentError, ~r/not declared in KaoiroServer\.PersistencePaths/, fn ->
      KaoiroServer.DetsStorePath.default_path("undeclared_store.dets")
    end
  end

  test "default_path resolves every declared store" do
    for store <- PersistencePaths.stores() do
      path = KaoiroServer.DetsStorePath.default_path(store.default_file)

      assert Path.basename(path) == store.default_file
      assert Path.type(path) == :absolute
    end
  end
end
