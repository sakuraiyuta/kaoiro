defmodule KaoiroServerWeb.Router do
  use KaoiroServerWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", KaoiroServerWeb do
    pipe_through :api
  end
end
