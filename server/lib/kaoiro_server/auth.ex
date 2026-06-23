defmodule KaoiroServer.Auth do
  @moduledoc """
  Token auth for the wrapper and client sockets (ADR-0011).

  Token lists come from env via runtime config:

  - `:wrapper_tokens` — `"agent_id:token,agent_id:token"`
  - `:client_tokens` — `"token:role,..."` (role: `viewer` | `operator`)

  The unset/empty behaviour differs by socket:

  - `:wrapper_tokens` unset — wrapper auth disabled (dev convenience):
    any wrapper may connect.
  - `:client_tokens` unset — fail-closed: every client connection is
    rejected (no token can authenticate), so a misconfigured deployment
    never silently grants operator (issue #28).

  Either unset state is logged at startup via `warn_token_config/0`
  (specs/protocol.md, specs/threat-model.md).
  """

  require Logger

  @doc """
  Authorizes a wrapper connection for `agent_id`. `:ok` when the token
  matches, or when no wrapper tokens are configured.
  """
  def authorize_wrapper(agent_id, token) do
    tokens = parse_pairs(Application.get_env(:kaoiro_server, :wrapper_tokens))

    if tokens == %{} do
      :ok
    else
      # Run the comparison even for an unknown agent_id so timing does
      # not reveal which agent_ids have token entries.
      expected = Map.get(tokens, agent_id, "")
      presented = if is_binary(token), do: token, else: ""
      matched = Plug.Crypto.secure_compare(expected, presented)

      if Map.has_key?(tokens, agent_id) and matched do
        :ok
      else
        {:error, :unauthorized}
      end
    end
  end

  @doc """
  Resolves a client token to its role (`:viewer` | `:operator`), or
  `{:error, :unauthorized}` when it matches no configured token. With no
  client tokens configured at all, every connection is rejected
  (fail-closed, issue #28) — never granted operator.
  """
  def client_role(token) do
    tokens = parse_pairs(Application.get_env(:kaoiro_server, :client_tokens))

    # Fail closed: an empty token map makes role_for/2 return nil for any
    # token, so no client can authenticate. A misconfigured deployment is
    # then locked, not silently wide-open as operator (issue #28). The
    # startup warning explains the locked state.
    case role_for(tokens, token) do
      nil -> {:error, :unauthorized}
      role -> {:ok, role}
    end
  end

  defp role_for(tokens, token) when is_binary(token) do
    # Constant-time scan: compare against every entry so lookup timing
    # does not reveal whether a token exists.
    Enum.reduce(tokens, nil, fn {expected, role}, acc ->
      if matches?(expected, token), do: parse_role(role), else: acc
    end)
  end

  defp role_for(_tokens, _token), do: nil

  @doc """
  Derives a stable, opaque socket id for a client token (issue #47) so a
  logout or revocation can force-drop every live socket bound to it via
  `Endpoint.broadcast(id, "disconnect", %{})`. A SHA-256 hash, not the raw
  token, so the secret is never retained in socket state or logs. The same
  underlying token (whether it reached the socket via cookie, ticket, or
  `?token=`) maps to the same id, so the HTTP logout path and the WS
  connection agree. Returns nil for a missing/blank/non-binary token —
  there is then no socket to address.
  """
  def socket_id(token) when is_binary(token) and token != "" do
    "client_socket:" <> Base.url_encode64(:crypto.hash(:sha256, token), padding: false)
  end

  def socket_id(_token), do: nil

  @doc """
  Logs a startup warning for each token list that is unset, so the
  locked / dev-mode state is visible in logs rather than silent
  (specs/threat-model.md, issue #28):

  - `:client_tokens` unset — client connections are rejected
    (fail-closed); the env must be set to grant access.
  - `:wrapper_tokens` unset — wrapper auth disabled (dev mode); any
    wrapper may connect.
  """
  def warn_token_config do
    if parse_pairs(Application.get_env(:kaoiro_server, :client_tokens)) == %{} do
      Logger.warning(
        "KAOIRO_CLIENT_TOKENS unset: client connections are rejected " <>
          "(no token can authenticate). Set it to grant viewer/operator " <>
          "access (specs/threat-model.md)."
      )
    end

    if parse_pairs(Application.get_env(:kaoiro_server, :wrapper_tokens)) == %{} do
      Logger.warning(
        "KAOIRO_WRAPPER_TOKENS unset: wrapper auth disabled (dev mode); " <>
          "any wrapper may connect. Set it before exposing beyond loopback " <>
          "(specs/threat-model.md)."
      )
    end

    :ok
  end

  defp parse_role("viewer"), do: :viewer
  defp parse_role("operator"), do: :operator
  defp parse_role(_), do: nil

  defp matches?(expected, presented) do
    is_binary(expected) and is_binary(presented) and
      Plug.Crypto.secure_compare(expected, presented)
  end

  # "a:b,c:d" -> %{"a" => "b", "c" => "d"}; malformed entries are
  # skipped with a warning (fail visible, not fatal).
  defp parse_pairs(raw) when is_binary(raw) and raw != "" do
    raw
    |> String.split(",", trim: true)
    |> Enum.reduce(%{}, fn pair, acc ->
      case String.split(pair, ":", parts: 2) do
        [key, value] when key != "" and value != "" ->
          Map.put(acc, String.trim(key), String.trim(value))

        _ ->
          Logger.warning("ignoring malformed auth token entry")
          acc
      end
    end)
  end

  defp parse_pairs(_raw), do: %{}
end
