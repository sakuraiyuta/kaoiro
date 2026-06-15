defmodule KaoiroServerWeb.ClientSocketTest do
  # Mutates :client_tokens; calls connect/3 directly (ADR-0013).
  use ExUnit.Case, async: false

  alias KaoiroServerWeb.ClientSocket

  setup do
    Application.delete_env(:kaoiro_server, :client_tokens)
    on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
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
    ticket = Phoenix.Token.sign(KaoiroServerWeb.Endpoint, "client_ws", "tok-op")

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
    ticket = Phoenix.Token.sign(KaoiroServerWeb.Endpoint, "client_ws", "tok-op")

    assert {:ok, authed} = ClientSocket.connect(%{"ticket" => ticket}, socket, %{})
    assert authed.assigns.role == :operator
  end

  test "改竄チケットは拒否する (fail-closed)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    socket = %Phoenix.Socket{endpoint: KaoiroServerWeb.Endpoint}

    assert :error = ClientSocket.connect(%{"ticket" => "garbage"}, socket, %{})
  end
end
