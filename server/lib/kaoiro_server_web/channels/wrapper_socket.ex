defmodule KaoiroServerWeb.WrapperSocket do
  @moduledoc """
  Socket for wrapper connections (one per local wrapper, ADR-0002).
  Wrapper token auth + TLS are Phase 3; the tracer accepts any wrapper.
  """

  use Phoenix.Socket

  channel "wrapper:*", KaoiroServerWeb.WrapperChannel

  @impl true
  def connect(_params, socket, _connect_info), do: {:ok, socket}

  @impl true
  def id(_socket), do: nil
end
