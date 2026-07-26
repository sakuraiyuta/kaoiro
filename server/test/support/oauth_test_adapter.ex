defmodule KaoiroServer.OAuthTestAdapter do
  @moduledoc """
  Canned-response `Assent.HTTPAdapter` for the OAuth tests (ADR-0042).

  assent performs its token / userinfo requests synchronously inside the
  calling process — which, for a `Phoenix.ConnTest` dispatch, is the test
  process — so the stubs live in that process' dictionary. No listening
  port and no shared state, which keeps the OAuth flow tests
  deterministic under concurrent `mix test` runs.

  `install/1` also points assent at this module and restores the previous
  adapter when the test ends.
  """

  @behaviour Assent.HTTPAdapter

  alias Assent.HTTPAdapter.HTTPResponse

  @key :oauth_test_adapter_stubs

  @doc """
  Routes assent's HTTP calls here and installs `stubs`: a list of
  `{url_fragment, status, body}` where the first entry whose fragment the
  request URL contains answers the call. `body` is JSON-encoded, matching
  what the real endpoints return.
  """
  @spec install([{binary(), pos_integer(), term()}]) :: :ok
  def install(stubs) do
    previous = Application.get_env(:assent, :http_adapter)
    Application.put_env(:assent, :http_adapter, __MODULE__)

    ExUnit.Callbacks.on_exit(fn ->
      case previous do
        nil -> Application.delete_env(:assent, :http_adapter)
        adapter -> Application.put_env(:assent, :http_adapter, adapter)
      end
    end)

    Process.put(@key, stubs)

    :ok
  end

  @impl true
  def request(_method, url, _body, _headers, _opts) do
    @key
    |> Process.get([])
    |> Enum.find(fn {fragment, _status, _body} -> String.contains?(url, fragment) end)
    |> case do
      {_fragment, status, body} ->
        {:ok,
         %HTTPResponse{
           status: status,
           headers: [{"content-type", "application/json"}],
           body: Jason.encode!(body)
         }}

      nil ->
        {:error, :no_stub_for_url}
    end
  end
end
