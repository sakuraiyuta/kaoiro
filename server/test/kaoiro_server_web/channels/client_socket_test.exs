defmodule KaoiroServerWeb.ClientSocketTest do
  # Mutates :client_tokens; calls connect/3 directly (ADR-0013).
  use ExUnit.Case, async: false

  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServerWeb.ClientSocket

  setup do
    clear_env()
    on_exit(&clear_env/0)
  end

  defp clear_env do
    Application.delete_env(:kaoiro_server, :client_tokens)
    Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
  end

  test "session cookie の token で認証する (ADR-0013)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    info = %{session: %{"client_token" => "tok-op"}}

    assert {:ok, socket} = ClientSocket.connect(%{}, %Phoenix.Socket{}, info)
    assert socket.assigns.role == :operator
  end

  test "session が無ければ params の token にフォールバックする (dev 経路)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-v:viewer")

    assert {:ok, socket} =
             ClientSocket.connect(%{"token" => "tok-v"}, %Phoenix.Socket{}, %{})

    assert socket.assigns.role == :viewer
  end

  test "ticket が token param より優先される (解決順)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator,tok-v:viewer")
    socket = %Phoenix.Socket{endpoint: KaoiroServerWeb.Endpoint}
    ticket = Phoenix.Token.encrypt(KaoiroServerWeb.Endpoint, "client_ws", "tok-op")

    assert {:ok, authed} =
             ClientSocket.connect(
               %{"ticket" => ticket, "token" => "tok-v"},
               socket,
               %{}
             )

    assert authed.assigns.role == :operator
  end

  test "どちらにも token が無ければ拒否する (fail-closed)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    assert :error = ClientSocket.connect(%{}, %Phoenix.Socket{}, %{})
  end

  test "短命チケットの param で認証する (ADR-0013 reload 経路)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    socket = %Phoenix.Socket{endpoint: KaoiroServerWeb.Endpoint}
    ticket = Phoenix.Token.encrypt(KaoiroServerWeb.Endpoint, "client_ws", "tok-op")

    assert {:ok, authed} = ClientSocket.connect(%{"ticket" => ticket}, socket, %{})
    assert authed.assigns.role == :operator
  end

  test "改竄チケットは拒否する (fail-closed)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    socket = %Phoenix.Socket{endpoint: KaoiroServerWeb.Endpoint}

    assert :error = ClientSocket.connect(%{"ticket" => "garbage"}, socket, %{})
  end

  test "認証成功で token 由来の socket id を割り当て id/1 で公開する (#47)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    info = %{session: %{"client_token" => "tok-op"}}

    assert {:ok, socket} = ClientSocket.connect(%{}, %Phoenix.Socket{}, info)
    assert socket.assigns.socket_id == KaoiroServer.Auth.socket_id("tok-op")
    # id/1 surfaces it so Endpoint.disconnect can target this socket.
    assert ClientSocket.id(socket) == socket.assigns.socket_id
  end

  describe "OAuth identity (ADR-0042)" do
    test "session cookie の identity を許可リストで role に解決する" do
      put_allowlist("nextcloud:ao:operator")
      info = %{session: %{"oauth_identity" => identity()}}

      assert {:ok, socket} = ClientSocket.connect(%{}, %Phoenix.Socket{}, info)
      assert socket.assigns.role == :operator
      assert socket.assigns.socket_id == KaoiroServer.Auth.oauth_socket_id("nextcloud", "ao")
    end

    test "role 省略のエントリは viewer になる" do
      put_allowlist("nextcloud:ao")
      info = %{session: %{"oauth_identity" => identity()}}

      assert {:ok, socket} = ClientSocket.connect(%{}, %Phoenix.Socket{}, info)
      assert socket.assigns.role == :viewer
    end

    test "identity を暗号化したチケットで接続できる (reload 経路)" do
      put_allowlist("nextcloud:ao:operator")
      socket = %Phoenix.Socket{endpoint: KaoiroServerWeb.Endpoint}
      ticket = Phoenix.Token.encrypt(KaoiroServerWeb.Endpoint, "client_ws", identity())

      assert {:ok, authed} = ClientSocket.connect(%{"ticket" => ticket}, socket, %{})
      assert authed.assigns.role == :operator
    end

    test "許可リストに無い identity は拒否する (毎回再照合)" do
      put_allowlist("nextcloud:kuroe:operator")
      info = %{session: %{"oauth_identity" => identity()}}

      assert :error = ClientSocket.connect(%{}, %Phoenix.Socket{}, info)
    end

    test "許可リスト未設定なら identity でも拒否する (fail-closed)" do
      info = %{session: %{"oauth_identity" => identity()}}

      assert :error = ClientSocket.connect(%{}, %Phoenix.Socket{}, info)
    end

    test "identity は token 認証の設定に依存しない" do
      # :client_tokens 未設定 (token 認証は fail-closed) でも OAuth は通る。
      put_allowlist("nextcloud:ao:operator")
      info = %{session: %{"oauth_identity" => identity()}}

      assert {:ok, socket} = ClientSocket.connect(%{}, %Phoenix.Socket{}, info)
      assert socket.assigns.role == :operator
    end

    test "token と identity の socket id は衝突しない" do
      refute KaoiroServer.Auth.oauth_socket_id("nextcloud", "ao") ==
               KaoiroServer.Auth.socket_id("nextcloud:ao")

      assert KaoiroServer.Auth.oauth_socket_id("nextcloud", "") == nil
      assert KaoiroServer.Auth.oauth_socket_id(nil, "ao") == nil
    end
  end

  defp identity, do: %{provider: "nextcloud", uid: "ao"}
end
