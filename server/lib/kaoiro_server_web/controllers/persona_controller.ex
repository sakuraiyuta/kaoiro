defmodule KaoiroServerWeb.PersonaController do
  @moduledoc """
  Authenticated persona delivery, independent of the dashboard serving toggle.
  """

  use KaoiroServerWeb, :controller

  alias KaoiroServer.PersonaAssets
  alias KaoiroServerWeb.PersonaDelivery

  def manifest(conn, _params) do
    case PersonaDelivery.scope(conn.assigns.persona_role) do
      {:ok, scope} -> json(conn, PersonaDelivery.manifest(scope))
      {:error, :unavailable} -> unavailable(conn)
    end
  end

  # Full persona pack detail (issue #232): manifest.json metadata +
  # personality.md body, fetched on demand when the operator opens the
  # detail modal — unlike `manifest/2` above, not polled/broadcast.
  def detail(conn, %{"id" => id}) do
    case PersonaAssets.get_pack_detail(id) do
      nil ->
        conn
        |> put_status(:not_found)
        |> json(%{"error" => "not_found"})

      detail ->
        json(conn, detail)
    end
  end

  def file(conn, %{"sprite_set" => sprite_set, "file" => file}) do
    with {:ok, scope} <- PersonaDelivery.scope(conn.assigns.persona_role),
         {:ok, %{path: path}} <- PersonaDelivery.fetch_file(scope, sprite_set, file),
         {:ok, bytes} <- File.read(path) do
      conn
      |> cache_versioned(bytes)
      |> put_resp_content_type("image/png", nil)
      |> send_resp(200, bytes)
    else
      {:error, :unavailable} -> unavailable(conn)
      _ -> conn |> put_status(:not_found) |> json(%{"error" => "not_found"})
    end
  end

  # Hash the bytes being sent, not the snapshot's stored hash: a cache slot
  # rewritten or altered under a published snapshot must not be pinned in a
  # browser for a year under a URL that names other content.
  defp cache_versioned(conn, bytes) do
    hash = :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

    if conn.query_params["v"] == PersonaAssets.version_param(hash),
      do: put_resp_header(conn, "cache-control", "private, max-age=31536000, immutable"),
      else: conn
  end

  defp unavailable(conn),
    do: conn |> put_status(:service_unavailable) |> json(%{"error" => "unavailable"})
end
