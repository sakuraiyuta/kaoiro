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

  # issue #232 MF-1: the session cookie's role gates persona pack detail
  # (personality.md is a system prompt that may carry proprietary
  # operating instructions for a custom pack — ADR-0021's fail-closed
  # default: a new output surface starts operator-limited, viewer
  # disclosure is a separate, explicit decision). Needs :fetch_session
  # (RequireOperatorPlug reads the cookie), so this does not compose with
  # the plain :api pipeline above — apply BOTH via pipe_through.
  pipeline :operator_only do
    plug :fetch_session
    plug KaoiroServerWeb.RequireOperatorPlug
  end

  # Responses carrying device codes, tokens or tickets are not stored
  # (issue 801, RFC 6749 §5.1).
  pipeline :device_api do
    plug KaoiroServerWeb.DeviceAuthHeaders
  end

  pipeline :authenticated do
    plug :fetch_session
    plug KaoiroServerWeb.RequireAuthenticatedPlug
  end

  scope "/api", KaoiroServerWeb do
    pipe_through [:authenticated, :api]
    get "/personas", PersonaController, :manifest
  end

  scope "/api", KaoiroServerWeb do
    pipe_through :api
    get "/health", HealthController, :status
  end

  scope "/api", KaoiroServerWeb do
    pipe_through [:api, :operator_only]

    get "/personas/:id", PersonaController, :detail
  end

  # Sprite files referenced by the manifest (ADR-0008). Top-level (not
  # /api) so the manifest URLs stay plain static-file paths; no :api
  # pipeline — content negotiation does not apply to image responses.
  scope "/personas", KaoiroServerWeb do
    pipe_through :authenticated
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
    get "/session/auth-methods", KaoiroServerWeb.SessionController, :auth_methods
    delete "/session", KaoiroServerWeb.SessionController, :delete
  end

  # The ticket and refresh endpoints also take a device access token
  # (issue 801), and every response here carries a credential.
  scope "/session", KaoiroServerWeb do
    pipe_through [:browser, :device_api]

    get "/ticket", SessionController, :ticket
    get "/refresh", SessionController, :refresh

    # The approval API for the device authorization grant (issue 801).
    post "/device/lookup", DeviceApprovalController, :lookup
    post "/device/decision", DeviceApprovalController, :decision
  end

  # The device authorization grant's native endpoints and verification
  # URI (issue 801, RFC 8628). No session: the native endpoints neither
  # read nor write the cookie.
  scope "/", KaoiroServerWeb do
    pipe_through :device_api

    post "/oauth/device", OAuthDeviceController, :device
    post "/oauth/token", OAuthDeviceController, :token
    get "/device", DeviceApprovalController, :entry
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
