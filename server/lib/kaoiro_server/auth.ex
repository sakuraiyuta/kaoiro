defmodule KaoiroServer.Auth do
  @moduledoc """
  Token auth for the wrapper and client sockets (ADR-0011).

  Token lists come from env via runtime config:

  - `:wrapper_tokens` — `"agent_id:token,agent_id:token"`
  - `:runner_tokens` — `"host_id:token,host_id:token"` (ADR-0023)
  - `:client_tokens` — `"token:role,..."` (role: `viewer` | `operator`)

  The unset/empty behaviour differs by socket:

  - `:wrapper_tokens` unset — wrapper auth disabled (dev convenience):
    any wrapper may connect.
  - `:runner_tokens` unset — runner auth disabled (dev convenience):
    any runner may connect. Mirrors wrapper (ADR-0011 per-entity tokens,
    extended to hosts by ADR-0023).
  - `:client_tokens` unset — fail-closed: every client connection is
    rejected (no token can authenticate), so a misconfigured deployment
    never silently grants operator (issue #28).

  Either unset state is logged at startup via `warn_token_config/0`
  (specs/protocol.md, specs/threat-model.md).
  """

  require Logger

  # Salt for the server-minted per-agent wrapper token (ADR-0024). A
  # constant, distinct from any other Phoenix.Token use.
  @wrapper_token_salt "kaoiro wrapper auth"

  @doc """
  Authorizes a wrapper connection for `agent_id`. `:ok` when wrapper auth
  is disabled (dev), the token matches a pre-registered `:wrapper_tokens`
  entry, or it is a valid server-minted signed token for this agent_id
  (the spawn path, ADR-0024). Otherwise `{:error, :unauthorized}`.

  Per-agent_id revocation (issue #72): a `TokenDenylist`-listed agent_id
  is rejected BEFORE the ordinary token compare, so even a token that
  would otherwise pass the signature check cannot re-join under a
  revoked id. The check is by agent_id — not by token bytes — because
  ADR-0024's stateless mint never persists the token, and the
  `<host>.<rand>` id space makes post-purge collisions negligible.
  Applies to dev mode too: a denylist entry is a security operation the
  operator explicitly took (or was applied by `delete_agent`), and dev
  mode's "any wrapper may connect" must not silently override it.
  """
  def authorize_wrapper(agent_id, token) do
    tokens = parse_pairs(Application.get_env(:kaoiro_server, :wrapper_tokens))

    cond do
      # Fail-closed denylist gate: takes precedence over both the dev
      # convenience branch and the signed-token branch. An unknown
      # agent_id (never revoked) returns false here so behaviour for
      # everyone else is unchanged.
      KaoiroServer.TokenDenylist.revoked?(agent_id) -> {:error, :unauthorized}
      # Dev convenience: no wrapper tokens configured → any wrapper connects.
      tokens == %{} -> :ok
      registered_wrapper_token?(tokens, agent_id, token) -> :ok
      valid_signed_wrapper_token?(agent_id, token) -> :ok
      true -> {:error, :unauthorized}
    end
  end

  @doc """
  Mints a per-agent wrapper token for a server-initiated spawn (ADR-0024).
  Signed with the endpoint's `secret_key_base` and bound to `agent_id`, with
  no expiry. Two revocation channels: (a) per-agent_id via
  `KaoiroServer.TokenDenylist` (issue #72, seeded by `delete_agent` and by
  operator revoke), and (b) whole-fleet via `secret_key_base` rotation
  (invalidates every signed token at once). This lets a spawned wrapper
  authenticate without a pre-registered `:wrapper_tokens` entry.
  """
  def mint_wrapper_token(agent_id) do
    Phoenix.Token.sign(KaoiroServerWeb.Endpoint, @wrapper_token_salt, agent_id)
  end

  # Pre-registered agent_id:token pair (ADR-0011). The secure_compare runs
  # even for an unknown agent_id so timing does not reveal which agent_ids
  # have token entries.
  defp registered_wrapper_token?(tokens, agent_id, token) do
    expected = Map.get(tokens, agent_id, "")
    presented = if is_binary(token), do: token, else: ""
    matched = Plug.Crypto.secure_compare(expected, presented)
    Map.has_key?(tokens, agent_id) and matched
  end

  # Server-minted signed token (ADR-0024). Verifies the Phoenix.Token
  # signature and that the embedded agent_id matches the joining one.
  defp valid_signed_wrapper_token?(agent_id, token) when is_binary(token) do
    case Phoenix.Token.verify(KaoiroServerWeb.Endpoint, @wrapper_token_salt, token,
           max_age: :infinity
         ) do
      {:ok, ^agent_id} -> true
      _ -> false
    end
  end

  defp valid_signed_wrapper_token?(_agent_id, _token), do: false

  @doc """
  Authorizes a runner connection for `host_id` (ADR-0023). `:ok` when the
  token matches, or when no runner tokens are configured. Mirrors
  `authorize_wrapper/2` against a separate `:runner_tokens` list since the
  host control channel is a distinct entity from the per-agent_id wrapper.
  """
  def authorize_runner(host_id, token) do
    tokens = parse_pairs(Application.get_env(:kaoiro_server, :runner_tokens))

    if tokens == %{} do
      :ok
    else
      # Run the comparison even for an unknown host_id so timing does not
      # reveal which host_ids have token entries.
      expected = Map.get(tokens, host_id, "")
      presented = if is_binary(token), do: token, else: ""
      matched = Plug.Crypto.secure_compare(expected, presented)

      if Map.has_key?(tokens, host_id) and matched do
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
  - `:runner_tokens` unset — runner auth disabled (dev mode); any
    runner may connect (ADR-0023).
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

    if parse_pairs(Application.get_env(:kaoiro_server, :runner_tokens)) == %{} do
      Logger.warning(
        "KAOIRO_RUNNER_TOKENS unset: runner auth disabled (dev mode); " <>
          "any runner may connect. Set it before exposing beyond loopback " <>
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
