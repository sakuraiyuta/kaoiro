defmodule KaoiroServerWeb.Router do
  use KaoiroServerWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", KaoiroServerWeb do
    pipe_through :api

    get "/personas", PersonaController, :manifest
  end

  # Sprite files referenced by the manifest (ADR-0008). Top-level (not
  # /api) so the manifest URLs stay plain static-file paths; no :api
  # pipeline — content negotiation does not apply to image responses.
  scope "/personas", KaoiroServerWeb do
    get "/:sprite_set/:file", PersonaController, :file
  end

  # The minimal dashboard is a static page (Phase 1.5-3); send the root
  # there until the Svelte reference dashboard (issue #12) takes over.
  scope "/" do
    get "/", KaoiroServerWeb.RootRedirect, []
  end
end
