defmodule KaoiroServer.UsersTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.Users

  setup do
    # Isolated DETS file + table name per test so cases don't share state
    # (mirrors AgentDirectoryTest).
    name = :"users_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, pid} = Users.start_link(name: name, path: path)

    on_exit(fn ->
      stop_quietly(pid)
      File.rm(path)
    end)

    %{server: name, path: path}
  end

  test "get_or_create は新規 source に採番し id/kind/display_name を返す", %{server: server} do
    user = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

    assert %{id: id, kind: "user", display_name: "Ao"} = user
    assert is_binary(id)
  end

  test "get_or_create は internal source を公開しない", %{server: server} do
    user = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

    refute Map.has_key?(user, :source)
    assert Map.keys(user) |> Enum.sort() == [:display_name, :id, :kind]
  end

  test "同一 source を再度 get_or_create すると同じ user_id が返る", %{server: server} do
    first = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)
    second = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

    assert first.id == second.id
  end

  test "既存 user の display_name は再ログインで更新されない (マスター決裁2026-08-09#1)", %{
    server: server
  } do
    first = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)
    second = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao Renamed Upstream", server)

    assert first.id == second.id
    assert second.display_name == "Ao"
  end

  test "異なる source は別の user_id になる", %{server: server} do
    a = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)
    b = Users.get_or_create({:oauth, "github", "kuroe"}, "user", "Kuroe", server)

    refute a.id == b.id
  end

  test "oauth source と token source は別の user_id になる (同じ文字列由来でも衝突しない)", %{
    server: server
  } do
    a = Users.get_or_create({:oauth, "token", "abc"}, "user", "A", server)
    b = Users.get_or_create({:token, "abc"}, "user", "B", server)

    refute a.id == b.id
  end

  test "initial_display_name が nil なら採番した user_id 自体が display_name になる", %{
    server: server
  } do
    user = Users.get_or_create({:token, "hash-x"}, "user", nil, server)

    assert user.display_name == user.id
  end

  test "未知 user_id の get は nil", %{server: server} do
    assert Users.get("none", server) == nil
  end

  test "get で登録済み user を引ける", %{server: server} do
    created = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

    assert Users.get(created.id, server) == created
  end

  test "all は全 user を返す", %{server: server} do
    a = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)
    b = Users.get_or_create({:oauth, "github", "kuroe"}, "user", "Kuroe", server)

    all = Users.all(server)
    assert all[a.id] == a
    assert all[b.id] == b
  end

  test "同一 DETS ファイルからの再起動で user が残り、user_id は再利用されない", %{
    server: server,
    path: path
  } do
    a = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)
    :ok = GenServer.stop(server)

    name2 = :"users_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = Users.start_link(name: name2, path: path)

    # 既存 user は復元される。
    assert Users.get(a.id, name2) == a

    # 新規 source は復元済み id と衝突しない番号を採番する。
    b = Users.get_or_create({:oauth, "github", "kuroe"}, "user", "Kuroe", name2)
    refute b.id == a.id

    GenServer.stop(name2)
  end
end
