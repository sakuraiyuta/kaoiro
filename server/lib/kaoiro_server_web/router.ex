defmodule KaoiroServerWeb.Router do
  use KaoiroServerWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", KaoiroServerWeb do
    pipe_through :api
  end

  # The minimal dashboard is a static page (Phase 1.5-3); send the root
  # there until the Svelte reference dashboard (issue #12) takes over.
  scope "/" do
    get "/", KaoiroServerWeb.RootRedirect, []
  end
end
