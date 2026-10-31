defmodule KaoiroServerWeb.NativeOAuthInput do
  @moduledoc """
  Reads the input of the native device authorization endpoints
  (`POST /oauth/device`, `POST /oauth/token`, issue 801) in place of
  `Plug.Parsers`, which `KaoiroServerWeb.Parsers` does not call for them.

  The checks run in a fixed order, which is the wire contract's order:
  transport, content type, query string, body size, form decoding,
  duplicate keys. The first failure is stored as `{:error, reason}` under
  `conn.private[:kaoiro_oauth_input]` and the rest are skipped; success
  stores `{:ok, %{pairs: [{key, value}]}}`. Nothing here raises or sends
  a response: an exception would reach `Phoenix.Endpoint`'s catch-all
  with the conn from before `Plug.SSL`, losing every header the
  controller's answer must carry. `body_params` stays unfetched.
  """

  import Plug.Conn

  alias KaoiroServerWeb.SessionCredential

  @private_key :kaoiro_oauth_input

  # An operational cap, not a contract on the boundary byte: read_body's
  # length is approximate, and a client's form is a few hundred bytes.
  @max_body 16_384

  @type reason ::
          :insecure_transport
          | :unsupported_media_type
          | :query_not_empty
          | :body_too_large
          | :body_unreadable
          | :malformed_form
          | :duplicate_parameter

  @spec private_key :: atom()
  def private_key, do: @private_key

  @spec call(Plug.Conn.t()) :: Plug.Conn.t()
  def call(conn) do
    {conn, result} = read(conn)
    put_private(conn, @private_key, result)
  end

  defp read(conn) do
    with :ok <- transport(conn),
         :ok <- media_type(conn),
         :ok <- empty_query(conn),
         {:ok, body, conn} <- body(conn),
         {:ok, pairs} <- decode(body, conn),
         :ok <- unique_keys(pairs, conn) do
      {conn, {:ok, %{pairs: pairs}}}
    else
      {:error, reason, conn} -> {conn, {:error, reason}}
    end
  end

  defp transport(conn) do
    if SessionCredential.secure_transport?(conn),
      do: :ok,
      else: {:error, :insecure_transport, conn}
  end

  defp media_type(conn) do
    with [value] <- get_req_header(conn, "content-type"),
         {:ok, "application", "x-www-form-urlencoded", _params} <-
           Plug.Conn.Utils.content_type(value) do
      :ok
    else
      _other -> {:error, :unsupported_media_type, conn}
    end
  end

  defp empty_query(%Plug.Conn{query_string: ""}), do: :ok
  defp empty_query(conn), do: {:error, :query_not_empty, conn}

  defp body(conn) do
    case read_body(conn, length: @max_body, read_length: @max_body) do
      {:ok, body, conn} -> {:ok, body, conn}
      {:more, _partial, conn} -> {:error, :body_too_large, conn}
      {:error, _reason} -> {:error, :body_unreadable, conn}
    end
  end

  # URI.query_decoder/1 passes a malformed escape (`%ZZ`, a trailing `%`)
  # through as literal text and does not check UTF-8, so both are checked
  # here: the escapes before decoding, the encoding after.
  @bad_escape ~r/%(?![0-9A-Fa-f]{2})/

  defp decode(body, conn) do
    with false <- Regex.match?(@bad_escape, body),
         pairs = Enum.to_list(URI.query_decoder(body)),
         true <- Enum.all?(pairs, fn {k, v} -> String.valid?(k) and String.valid?(v) end) do
      {:ok, pairs}
    else
      _malformed -> {:error, :malformed_form, conn}
    end
  end

  defp unique_keys(pairs, conn) do
    keys = Enum.map(pairs, &elem(&1, 0))

    if length(Enum.uniq(keys)) == length(keys),
      do: :ok,
      else: {:error, :duplicate_parameter, conn}
  end
end
