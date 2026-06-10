defmodule KaoiroServerWeb.DashboardStatic do
  @moduledoc """
  Plug.Static gated by the `:serve_dashboard` config (ADR-0007: the
  bundled dashboard's static serving can be turned off; channels and the
  public API stay on). Default is on.
  """

  @behaviour Plug

  @impl true
  def init(opts), do: Plug.Static.init(opts)

  @impl true
  def call(conn, opts) do
    if Application.get_env(:kaoiro_server, :serve_dashboard, true) do
      Plug.Static.call(conn, opts)
    else
      conn
    end
  end
end
