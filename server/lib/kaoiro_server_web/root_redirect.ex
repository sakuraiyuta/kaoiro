defmodule KaoiroServerWeb.RootRedirect do
  @moduledoc """
  Redirects `/` to the static minimal dashboard (Phase 1.5-3).
  """

  def init(opts), do: opts

  def call(conn, _opts) do
    conn
    |> Phoenix.Controller.redirect(to: "/index.html")
    |> Plug.Conn.halt()
  end
end
