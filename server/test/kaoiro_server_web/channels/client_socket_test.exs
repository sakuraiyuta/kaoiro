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

  test "session の token が params より優先される" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator,tok-v:viewer")
    info = %{session: %{"client_token" => "tok-op"}}

    assert {:ok, socket} =
             ClientSocket.connect(%{"token" => "tok-v"}, %Phoenix.Socket{}, info)

    assert socket.assigns.role == :operator
  end

  test "どちらにも token が無ければ拒否する (fail-closed)" do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-op:operator")
    assert :error = ClientSocket.connect(%{}, %Phoenix.Socket{}, %{})
  end
end
