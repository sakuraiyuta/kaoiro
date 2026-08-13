defmodule KaoiroServer.AuthTest do
  # Mutates the :wrapper_tokens / :client_tokens config.
  use ExUnit.Case, async: false

  alias KaoiroServer.Auth

  setup do
    # Clear before AND after each test: config/runtime.exs loads
    # KAOIRO_*_TOKENS in :test too, so a host that exports them would leak
    # into the first "未設定" test before any on_exit has run.
    original_env = Application.get_env(:kaoiro_server, :env)
    Application.delete_env(:kaoiro_server, :wrapper_tokens)
    Application.delete_env(:kaoiro_server, :runner_tokens)
    Application.delete_env(:kaoiro_server, :client_tokens)

    # issue #198 admin tests put an allow-list file and OAuth credentials in
    # place. `OAuthAllowlistFixture` states the CALLER clears the path, and
    # without it a deleted tmp path (and live credentials) leak into every
    # later module through global Application env — the fixture file is gone
    # by then, so the leak reads as "allow-list unreadable" rather than as
    # this module's doing (ふじ should 2, issue #198).
    oauth_keys = [
      :oauth_allowlist_path,
      :oauth_google_client_id,
      :oauth_google_client_secret,
      :oauth_github_client_id,
      :oauth_github_client_secret
    ]

    original_oauth = Map.new(oauth_keys, &{&1, Application.get_env(:kaoiro_server, &1)})
    Enum.each(oauth_keys, &Application.delete_env(:kaoiro_server, &1))

    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :wrapper_tokens)
      Application.delete_env(:kaoiro_server, :runner_tokens)
      Application.delete_env(:kaoiro_server, :client_tokens)

      Enum.each(oauth_keys, fn key ->
        case Map.fetch!(original_oauth, key) do
          nil -> Application.delete_env(:kaoiro_server, key)
          value -> Application.put_env(:kaoiro_server, key, value)
        end
      end)

      # issue #138 tests flip :env to :prod; restore it so later tests keep
      # exercising the ordinary :test dev-convenience path.
      Application.put_env(:kaoiro_server, :env, original_env)
    end)
  end

  describe "authorize_wrapper/2" do
    test "未設定なら認証を要求しない" do
      assert :ok = Auth.authorize_wrapper("any-agent", nil)
      assert :ok = Auth.authorize_wrapper("any-agent", "whatever")
    end

    test "設定時は agent_id とトークンの組で照合する" do
      Application.put_env(
        :kaoiro_server,
        :wrapper_tokens,
        "lab.a:tok-a,lab.b:tok-b"
      )

      assert :ok = Auth.authorize_wrapper("lab.a", "tok-a")
      assert :ok = Auth.authorize_wrapper("lab.b", "tok-b")
      assert {:error, :unauthorized} = Auth.authorize_wrapper("lab.a", "tok-b")
      assert {:error, :unauthorized} = Auth.authorize_wrapper("lab.a", nil)
      assert {:error, :unauthorized} = Auth.authorize_wrapper("unknown", "tok-a")
    end

    test "不正形式のエントリは無視される" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "broken,lab.a:tok-a")

      assert :ok = Auth.authorize_wrapper("lab.a", "tok-a")
      assert {:error, :unauthorized} = Auth.authorize_wrapper("broken", "x")
    end

    test "server-minted 署名トークンを受理する (ADR-0024、事前登録不要)" do
      # wrapper auth ON but the agent_id is NOT pre-registered: only the signed
      # token can authorize it, proving the spawn path works without a config entry.
      Application.put_env(:kaoiro_server, :wrapper_tokens, "other.a:tok-a")
      token = Auth.mint_wrapper_token("lab.spawned")

      assert :ok = Auth.authorize_wrapper("lab.spawned", token)
    end

    test "署名トークンは別 agent_id を認証しない (binding)" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "other.a:tok-a")
      token = Auth.mint_wrapper_token("lab.spawned")

      assert {:error, :unauthorized} = Auth.authorize_wrapper("lab.other", token)
    end

    test "署名でないトークンは拒否する" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "other.a:tok-a")

      assert {:error, :unauthorized} = Auth.authorize_wrapper("lab.spawned", "garbage")
    end

    test "denylist に載る agent_id は署名トークンでも拒否する (issue #72)" do
      # signing scheme はそのまま、denylist は additive gate。
      # 通常の signed token は通るが、revoke 後は同じ token が unauth に落ちる。
      Application.put_env(:kaoiro_server, :wrapper_tokens, "other.a:tok-a")
      agent_id = "lab.denylisted-#{System.unique_integer([:positive])}"
      token = Auth.mint_wrapper_token(agent_id)

      # revoke 前は通る。
      assert :ok = Auth.authorize_wrapper(agent_id, token)

      KaoiroServer.TokenDenylist.revoke(agent_id, "2026-07-23T15:00:00Z")

      on_exit(fn ->
        KaoiroServer.TokenDenylist.restore(agent_id)
      end)

      # cast の反映を待ってから照合する。
      :ok = poll_until(fn -> KaoiroServer.TokenDenylist.revoked?(agent_id) end)
      assert {:error, :unauthorized} = Auth.authorize_wrapper(agent_id, token)
    end

    test ":prod では未設定でも fail-closed になる (issue #138)" do
      Application.put_env(:kaoiro_server, :env, :prod)

      assert {:error, :unauthorized} = Auth.authorize_wrapper("any-agent", nil)
      assert {:error, :unauthorized} = Auth.authorize_wrapper("any-agent", "whatever")
    end

    test ":prod では未設定でも server-minted 署名トークンは通る (runner-only 配備)" do
      # ペア登録ゼロの runner-only 配備 (2026-08-02 gateway) で、
      # dashboard 起点の spawn (ADR-0024) が fail-closed に巻き込まれて
      # 全拒否されない — 署名検証は registry の有無と独立に走る。
      Application.put_env(:kaoiro_server, :env, :prod)
      token = Auth.mint_wrapper_token("lab.spawned")

      assert :ok = Auth.authorize_wrapper("lab.spawned", token)
      assert {:error, :unauthorized} = Auth.authorize_wrapper("lab.other", token)
    end

    test ":prod でも登録済みトークンでの認証は通る (issue #138)" do
      Application.put_env(:kaoiro_server, :env, :prod)

      Application.put_env(
        :kaoiro_server,
        :wrapper_tokens,
        "lab.a:tok-a"
      )

      assert :ok = Auth.authorize_wrapper("lab.a", "tok-a")
      assert {:error, :unauthorized} = Auth.authorize_wrapper("lab.a", "wrong")
    end

    test "denylist は dev モード (wrapper_tokens 未設定) でも効く (issue #72)" do
      # 「未設定なら誰でも通る」ゆるい dev モードでも、明示 revoke だけは
      # override せず維持する (security 操作は operator が意図的に取った
      # もの — dev convenience に潰されてはいけない)。
      Application.delete_env(:kaoiro_server, :wrapper_tokens)
      agent_id = "lab.denylisted-dev-#{System.unique_integer([:positive])}"

      assert :ok = Auth.authorize_wrapper(agent_id, "anything")

      KaoiroServer.TokenDenylist.revoke(agent_id)

      on_exit(fn ->
        KaoiroServer.TokenDenylist.restore(agent_id)
      end)

      :ok = poll_until(fn -> KaoiroServer.TokenDenylist.revoked?(agent_id) end)
      assert {:error, :unauthorized} = Auth.authorize_wrapper(agent_id, "anything")
    end
  end

  defp poll_until(pred, attempts \\ 50) do
    cond do
      pred.() -> :ok
      attempts <= 0 -> :timeout
      true -> Process.sleep(5) && poll_until(pred, attempts - 1)
    end
  end

  describe "authorize_runner/2 (ADR-0023)" do
    test "未設定なら認証を要求しない" do
      assert :ok = Auth.authorize_runner("any-host", nil)
      assert :ok = Auth.authorize_runner("any-host", "whatever")
    end

    test "設定時は host_id とトークンの組で照合する" do
      Application.put_env(
        :kaoiro_server,
        :runner_tokens,
        "lab-pc-1:tok-1,lab-pc-2:tok-2"
      )

      assert :ok = Auth.authorize_runner("lab-pc-1", "tok-1")
      assert :ok = Auth.authorize_runner("lab-pc-2", "tok-2")
      assert {:error, :unauthorized} = Auth.authorize_runner("lab-pc-1", "tok-2")
      assert {:error, :unauthorized} = Auth.authorize_runner("lab-pc-1", nil)
      assert {:error, :unauthorized} = Auth.authorize_runner("unknown", "tok-1")
    end

    test ":prod では未設定でも fail-closed になる (issue #138)" do
      Application.put_env(:kaoiro_server, :env, :prod)

      assert {:error, :unauthorized} = Auth.authorize_runner("any-host", nil)
      assert {:error, :unauthorized} = Auth.authorize_runner("any-host", "whatever")
    end
  end

  describe "client_role/1" do
    test "未設定なら全接続を拒否する (fail-closed, issue #28)" do
      assert {:error, :unauthorized} = Auth.client_role(nil)
      assert {:error, :unauthorized} = Auth.client_role("anything")
    end

    test "設定時はトークンを role に解決する" do
      Application.put_env(
        :kaoiro_server,
        :client_tokens,
        "tok-view:viewer,tok-op:operator"
      )

      assert {:ok, :viewer} = Auth.client_role("tok-view")
      assert {:ok, :operator} = Auth.client_role("tok-op")
      assert {:error, :unauthorized} = Auth.client_role("unknown")
      assert {:error, :unauthorized} = Auth.client_role(nil)
    end

    test "未知 role のエントリは拒否される" do
      # `admin` was this fixture's unknown-role word until issue #198 made
      # it real; `root` is deliberately a word no role table defines, so
      # the case still tests rejection rather than a stale spelling.
      Application.put_env(:kaoiro_server, :client_tokens, "tok-x:root")

      assert {:error, :unauthorized} = Auth.client_role("tok-x")
    end

    test "admin role のトークンは admin に解決する (issue #198)" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-admin:admin")

      assert {:ok, :admin} = Auth.client_role("tok-admin")
    end

    test "role 語の綴り違いは viewer へ降格せず拒否される (issue #198)" do
      # The bootstrap path is config text, so a typo must fail closed
      # rather than silently authenticate at the weakest role.
      Application.put_env(:kaoiro_server, :client_tokens, "tok-typo:admn")

      assert {:error, :unauthorized} = Auth.client_role("tok-typo")
    end

    test "name 付きエントリでも role 解決は変わらない (issue #197)" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator:CI bot")

      assert {:ok, :operator} = Auth.client_role("tok-op")
    end
  end

  describe "client_token_display_name/1 (issue #197 マスター決裁 2026-08-09 #1)" do
    test "token:role:name エントリは設定名を返す" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator:CI bot")

      assert Auth.client_token_display_name("tok-op") == "CI bot"
    end

    test "name を省略した token:role エントリは nil を返す" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      assert Auth.client_token_display_name("tok-op") == nil
    end

    test "未知 token / 未設定は nil を返す" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator:CI bot")

      assert Auth.client_token_display_name("unknown") == nil
      assert Auth.client_token_display_name(nil) == nil
    end
  end

  describe "client_token_hash/1 (issue #197)" do
    test "同じ token は同じ hash、異なる token は別の hash" do
      assert Auth.client_token_hash("tok-a") == Auth.client_token_hash("tok-a")
      refute Auth.client_token_hash("tok-a") == Auth.client_token_hash("tok-b")
    end

    test "生 token を hash に含めない" do
      refute Auth.client_token_hash("super-secret-token") =~ "super-secret-token"
    end

    test "socket_id/1 とは別の名前空間 (衝突しても混同しない)" do
      refute Auth.client_token_hash("tok-a") == Auth.socket_id("tok-a")
    end
  end

  describe "socket_id/1 (issue #47)" do
    test "同じ token は同じ id、異なる token は別の id" do
      assert Auth.socket_id("tok-a") == Auth.socket_id("tok-a")
      refute Auth.socket_id("tok-a") == Auth.socket_id("tok-b")
      assert String.starts_with?(Auth.socket_id("tok-a"), "client_socket:")
    end

    test "生 token を id に含めない (ハッシュ化)" do
      refute Auth.socket_id("super-secret-token") =~ "super-secret-token"
    end

    test "nil / 空 / 非バイナリの token は id を持たない" do
      assert Auth.socket_id(nil) == nil
      assert Auth.socket_id("") == nil
      assert Auth.socket_id(123) == nil
    end
  end

  describe "client_token_hash_role_map/0 (issue #197 段階2, director D10 改訂)" do
    test "map は client_token_hash/1 の値で引ける" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator,tok-view:viewer")

      map = Auth.client_token_hash_role_map()

      assert Map.fetch(map, Auth.client_token_hash("tok-op")) == {:ok, :operator}
      assert Map.fetch(map, Auth.client_token_hash("tok-view")) == {:ok, :viewer}
      assert map_size(map) == 2
    end

    test "admin も map に残る (issue #198)" do
      # この map は `Users.all_with_role/1` の role join 元。admin が
      # 落ちると token 経路の admin が user directory から消え、ADR-0050
      # D2 の「admin は隠蔽できない」に反する (ふじ should 1)。
      Application.put_env(:kaoiro_server, :client_tokens, "tok-admin:admin")

      map = Auth.client_token_hash_role_map()

      assert Map.fetch(map, Auth.client_token_hash("tok-admin")) == {:ok, :admin}
    end

    test "raw token / socket_id(token) はどちらも key に現れない" do
      Application.put_env(:kaoiro_server, :client_tokens, "super-secret-token:operator")

      map = Auth.client_token_hash_role_map()

      refute Map.has_key?(map, "super-secret-token")
      refute Map.has_key?(map, Auth.socket_id("super-secret-token"))
      refute inspect(map) =~ "super-secret-token"
    end

    test "設定変更は次の呼び出しに反映される (キャッシュしない)" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-a:viewer")
      assert Auth.client_token_hash_role_map() == %{Auth.client_token_hash("tok-a") => :viewer}

      Application.put_env(:kaoiro_server, :client_tokens, "tok-a:operator")
      assert Auth.client_token_hash_role_map() == %{Auth.client_token_hash("tok-a") => :operator}
    end

    test "未設定 / 空は空 map" do
      Application.put_env(:kaoiro_server, :client_tokens, nil)
      assert Auth.client_token_hash_role_map() == %{}

      Application.put_env(:kaoiro_server, :client_tokens, "")
      assert Auth.client_token_hash_role_map() == %{}
    end
  end

  describe "warn_token_config/0 (issue #28)" do
    import ExUnit.CaptureLog

    test "トークン未設定なら client=拒否 / wrapper=dev mode / runner=dev mode を警告する" do
      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "KAOIRO_CLIENT_TOKENS unset"
      assert log =~ "client connections are rejected"
      assert log =~ "KAOIRO_WRAPPER_TOKENS unset"
      assert log =~ "KAOIRO_RUNNER_TOKENS unset"
    end

    test "全トークン設定済みなら警告は出ない" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "lab.a:tok-a")
      Application.put_env(:kaoiro_server, :runner_tokens, "lab-pc-1:tok-1")
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      refute log =~ "unset"
    end

    test "一部だけ設定なら未設定側のみ警告する" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "lab.a:tok-a")
      Application.put_env(:kaoiro_server, :runner_tokens, "lab-pc-1:tok-1")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "KAOIRO_CLIENT_TOKENS unset"
      refute log =~ "KAOIRO_WRAPPER_TOKENS unset"
      refute log =~ "KAOIRO_RUNNER_TOKENS unset"
    end

    test ":prod では wrapper/runner 未設定を fail-closed 文言で警告する (issue #138)" do
      Application.put_env(:kaoiro_server, :env, :prod)

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "KAOIRO_WRAPPER_TOKENS unset: pair auth disabled"
      assert log =~ "only server-minted wrapper tokens"
      assert log =~ "fail-closed in prod"
      assert log =~ "KAOIRO_RUNNER_TOKENS unset: runner connections are rejected"
      refute log =~ "dev mode"
    end
  end

  describe "admin 不在の起動警告 (issue #198, ADR-0050 D2)" do
    import ExUnit.CaptureLog

    test "どちらの経路にも admin が居なければ警告する" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "no usable admin"
    end

    test "token 経路に admin が居れば警告しない" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-admin:admin")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      refute log =~ "no usable admin"
    end

    defp enable_provider("github") do
      Application.put_env(:kaoiro_server, :oauth_github_client_id, "gh-id")
      Application.put_env(:kaoiro_server, :oauth_github_client_secret, "gh-secret")
    end

    defp enable_provider("google") do
      Application.put_env(:kaoiro_server, :oauth_google_client_id, "g-id")
      Application.put_env(:kaoiro_server, :oauth_google_client_secret, "g-secret")
    end

    test "有効な provider の許可リストに admin が居れば警告しない" do
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
      enable_provider("github")
      KaoiroServer.OAuthAllowlistFixture.put_allowlist("github:ao:admin\n")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      refute log =~ "no usable admin"
    end

    test "admin が無効な provider にしか居なければ警告する" do
      # credentials の無い provider の行は誰にもログインを許さないので、
      # admin として数えると「実際には 0 人」を取り逃す (ふじ must-fix 1)。
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
      KaoiroServer.OAuthAllowlistFixture.put_allowlist("github:ao:admin\n")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "no usable admin"
    end

    test "有効 provider の operator と無効 provider の admin が混在しても警告する" do
      # 有効 provider が存在することで、無効 provider の admin が隠れて
      # しまう経路。ふじ が実測した組み合わせをそのまま固定する。
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
      enable_provider("google")

      KaoiroServer.OAuthAllowlistFixture.put_allowlist(
        "google:ao@example.com:operator\ngithub:ao:admin\n"
      )

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "no usable admin"
    end

    test "role 語の綴り違いは admin と数えず、警告は出たままになる" do
      # 綴り違いは認証も通らない。数えてしまうと、この警告を最も必要と
      # する設定ミスに限って警告が消える、という逆の挙動になる。
      Application.put_env(:kaoiro_server, :client_tokens, "tok-x:admn")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "no usable admin"
    end
  end
end
