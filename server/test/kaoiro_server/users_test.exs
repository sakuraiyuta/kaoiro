defmodule KaoiroServer.UsersTest do
  # all_with_role/1 tests mutate :client_tokens / :oauth_allowlist_path
  # (issue #197 段階2), mirroring auth_test.exs / session_controller_test.exs.
  use ExUnit.Case, async: false

  import KaoiroServer.OAuthAllowlistFixture
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

  describe "all_with_role/1 (issue #197 段階2)" do
    setup do
      on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
      :ok
    end

    test "OAuth source の role を allow-list からライブ join する", %{server: server} do
      put_allowlist("github:ao:operator\n")
      user = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

      assert Users.all_with_role(server) == [
               %{id: user.id, kind: "user", display_name: "Ao", role: :operator}
             ]
    end

    test "token source の role を client_tokens からライブ join する", %{server: server} do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-a:viewer")
      hash = KaoiroServer.Auth.client_token_hash("tok-a")
      user = Users.get_or_create({:token, hash}, "user", "Token User", server)

      assert Users.all_with_role(server) == [
               %{id: user.id, kind: "user", display_name: "Token User", role: :viewer}
             ]
    end

    test "role 変更は次の呼び出しに反映される (キャッシュしない)", %{server: server} do
      put_allowlist("github:ao:operator\n")
      user = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

      assert [%{role: :operator}] = Users.all_with_role(server)

      put_allowlist("github:ao:viewer\n")

      assert [%{id: id, role: :viewer}] = Users.all_with_role(server)
      assert id == user.id
    end

    test "allow-list から消えた user は entry ごと省略され、復旧後は再出現する", %{server: server} do
      put_allowlist("github:ao:operator\n")
      user = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

      assert [%{role: :operator}] = Users.all_with_role(server)

      put_allowlist("")
      assert Users.all_with_role(server) == []

      put_allowlist("github:ao:viewer\n")
      assert [%{id: id, role: :viewer}] = Users.all_with_role(server)
      assert id == user.id
    end

    test "role が解決できない (未設定 token) user は結果から除外される", %{server: server} do
      Application.put_env(:kaoiro_server, :client_tokens, "")
      Users.get_or_create({:token, "unresolvable-hash"}, "user", "Ghost", server)

      assert Users.all_with_role(server) == []
    end

    test "複数 user が混在しても role 解決できる user だけが残る", %{server: server} do
      put_allowlist("github:ao:operator\n")
      Application.put_env(:kaoiro_server, :client_tokens, "")

      resolvable = Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)
      Users.get_or_create({:token, "unresolvable-hash"}, "user", "Ghost", server)

      assert [%{id: id}] = Users.all_with_role(server)
      assert id == resolvable.id
    end

    test "source を wire shape に含めない", %{server: server} do
      put_allowlist("github:ao:operator\n")
      Users.get_or_create({:oauth, "github", "ao"}, "user", "Ao", server)

      [entry] = Users.all_with_role(server)
      refute Map.has_key?(entry, :source)
      assert Map.keys(entry) |> Enum.sort() == [:display_name, :id, :kind, :role]
    end
  end

  describe "expose_to_agents_default/1 (issue #197 段階2, ふじ M1 レビュー指摘)" do
    test "env 未設定 (nil) は config default = true" do
      # 実測確認 (2026-08-11): fresh BEAM で config/runtime.exs を実際に
      # 評価し、env 未設定時に Application.get_env(:kaoiro_server,
      # :expose_users_to_agents) が true になることを次のコマンドで確認
      # 済み — `env -u KAOIRO_EXPOSE_USERS_TO_AGENTS mix run --no-start -e
      # 'IO.inspect(Application.get_env(:kaoiro_server,
      # :expose_users_to_agents))'` → `true`。このテストは runtime.exs が
      # 呼ぶ純粋関数そのものを pin する(runtime.exs 自体は通常の mix
      # test では評価されないため)。
      assert Users.expose_to_agents_default(nil) == true
    end

    test "明示 \"true\" は true、明示 \"false\" は false" do
      assert Users.expose_to_agents_default("true") == true
      assert Users.expose_to_agents_default("false") == false
    end

    test "typo / 不正値は false (fail-closed)" do
      assert Users.expose_to_agents_default("yes") == false
      assert Users.expose_to_agents_default("1") == false
      assert Users.expose_to_agents_default("TRUE") == false
    end
  end
end
