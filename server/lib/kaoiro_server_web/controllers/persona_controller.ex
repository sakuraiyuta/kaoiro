defmodule KaoiroServerWeb.PersonaController do
  @moduledoc """
  Persona asset distribution (ADR-0008 stage 1): the manifest JSON and
  the sprite files it references. Part of the public API — served
  regardless of the `:serve_dashboard` toggle (ADR-0007).
  """

  use KaoiroServerWeb, :controller

  alias KaoiroServer.PersonaAssets

  def manifest(conn, _params) do
    json(conn, PersonaAssets.manifest())
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

  # Only manifest-known files are served, so the request params never
  # touch the filesystem (no traversal surface). Only the manifest-issued
  # ?v= (current content hash) earns immutable caching — the manifest
  # hands out a new URL when content changes; any other URL (bare or
  # stale/garbage v) must revalidate so caches cannot pin it for a year.
  def file(conn, %{"sprite_set" => sprite_set, "file" => file}) do
    case PersonaAssets.fetch_file(sprite_set, file) do
      {:ok, %{path: path, hash: hash}} ->
        cache_control =
          if conn.query_params["v"] == PersonaAssets.version_param(hash) do
            "public, max-age=31536000, immutable"
          else
            "no-cache"
          end

        conn
        |> put_resp_content_type("image/png", nil)
        |> put_resp_header("cache-control", cache_control)
        |> send_file(200, path)

      :error ->
        conn
        |> put_status(:not_found)
        |> json(%{"error" => "not_found"})
    end
  end
end
