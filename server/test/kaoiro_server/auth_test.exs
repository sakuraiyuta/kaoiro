defmodule KaoiroServer.AuthTest do
  # Mutates the :wrapper_tokens / :client_tokens config.
  use ExUnit.Case, async: false

  alias KaoiroServer.Auth

  setup do
    # Clear before AND after each test: config/runtime.exs loads
    # KAOIRO_*_TOKENS in :test too, so a host that exports them would leak
    # into the first "未設定" test before any on_exit has run.
    Application.delete_env(:kaoiro_server, :wrapper_tokens)
    Application.delete_env(:kaoiro_server, :client_tokens)

    on_exit(fn ->
      Application.delete_env(:kaoiro_server, :wrapper_tokens)
      Application.delete_env(:kaoiro_server, :client_tokens)
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
      Application.put_env(:kaoiro_server, :client_tokens, "tok-x:admin")

      assert {:error, :unauthorized} = Auth.client_role("tok-x")
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

  describe "warn_token_config/0 (issue #28)" do
    import ExUnit.CaptureLog

    test "トークン未設定なら client=拒否 / wrapper=dev mode を警告する" do
      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "KAOIRO_CLIENT_TOKENS unset"
      assert log =~ "client connections are rejected"
      assert log =~ "KAOIRO_WRAPPER_TOKENS unset"
    end

    test "両トークン設定済みなら警告は出ない" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "lab.a:tok-a")
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      refute log =~ "unset"
    end

    test "片方だけ設定なら未設定側のみ警告する" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "lab.a:tok-a")

      log = capture_log(fn -> assert :ok = Auth.warn_token_config() end)
      assert log =~ "KAOIRO_CLIENT_TOKENS unset"
      refute log =~ "KAOIRO_WRAPPER_TOKENS unset"
    end
  end
end
