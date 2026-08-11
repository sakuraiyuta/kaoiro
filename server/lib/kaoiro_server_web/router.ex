defmodule KaoiroServerWeb.Router do
  use KaoiroServerWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  # The dashboard entry and the cookie-refresh endpoint read/write the
  # session cookie (ADR-0013), so they need the session fetched first.
  pipeline :browser do
    plug :fetch_session
  end

  scope "/api", KaoiroServerWeb do
    pipe_through :api

    get "/personas", PersonaController, :manifest
    get "/health", HealthController, :status
  end

  # Sprite files referenced by the manifest (ADR-0008). Top-level (not
  # /api) so the manifest URLs stay plain static-file paths; no :api
  # pipeline — content negotiation does not apply to image responses.
  scope "/personas", KaoiroServerWeb do
    get "/:sprite_set/:file", PersonaController, :file
  end

  # The minimal dashboard is a static page (Phase 1.5-3); send the root
  # there until the Svelte reference dashboard (issue #12) takes over.
  # Session cookie endpoints (ADR-0013): /session/new exchanges a token for
  # the cookie, /session/ticket mints a short-lived WS ticket from it (the
  # reload path), /session/refresh slides it while a tab is open, and
  # DELETE /session logs out + force-disconnects the socket (issue #47).
  scope "/" do
    pipe_through :browser

    get "/", KaoiroServerWeb.RootRedirect, []
    post "/session/new", KaoiroServerWeb.SessionController, :create
    get "/session/ticket", KaoiroServerWeb.SessionController, :ticket
    get "/session/refresh", KaoiroServerWeb.SessionController, :refresh
    get "/session/auth-methods", KaoiroServerWeb.SessionController, :auth_methods
    delete "/session", KaoiroServerWeb.SessionController, :delete
  end

  # OAuth login (ADR-0042). Both legs ride the session cookie: the
  # request leg stashes the OAuth2 state in it, the callback leg reads it
  # back and replaces it with the authenticated identity.
  scope "/auth", KaoiroServerWeb do
    pipe_through :browser

    get "/:provider", AuthController, :request
    get "/:provider/callback", AuthController, :callback
  end
end
