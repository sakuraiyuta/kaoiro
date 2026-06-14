defmodule KaoiroServer.AuthTest do
  # Mutates the :wrapper_tokens / :client_tokens config.
  use ExUnit.Case, async: false

  alias KaoiroServer.Auth

  setup do
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
    test "未設定なら operator として通す (dev mode)" do
      assert {:ok, :operator} = Auth.client_role(nil)
      assert {:ok, :operator} = Auth.client_role("anything")
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

  describe "warn_if_unenforced/0 (issue #28)" do
    import ExUnit.CaptureLog

    test "トークン未設定なら dev mode 警告をログに出す" do
      log = capture_log(fn -> assert :ok = Auth.warn_if_unenforced() end)
      assert log =~ "KAOIRO_WRAPPER_TOKENS unset"
      assert log =~ "KAOIRO_CLIENT_TOKENS unset"
    end

    test "両トークン設定済みなら警告は出ない" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "lab.a:tok-a")
      Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")

      log = capture_log(fn -> assert :ok = Auth.warn_if_unenforced() end)
      refute log =~ "unset"
    end

    test "片方だけ設定なら未設定側のみ警告する" do
      Application.put_env(:kaoiro_server, :wrapper_tokens, "lab.a:tok-a")

      log = capture_log(fn -> assert :ok = Auth.warn_if_unenforced() end)
      assert log =~ "KAOIRO_CLIENT_TOKENS unset"
      refute log =~ "KAOIRO_WRAPPER_TOKENS unset"
    end
  end
end
