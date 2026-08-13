defmodule KaoiroServer.Auth do
  @moduledoc """
  Token auth for the wrapper and client sockets (ADR-0011).

  Token lists come from env via runtime config:

  - `:wrapper_tokens` — `"agent_id:token,agent_id:token"`
  - `:runner_tokens` — `"host_id:token,host_id:token"` (ADR-0023)
  - `:client_tokens` — `"token:role,..."`
    (role: `viewer` | `operator` | `admin`, ADR-0050 D2)

  The unset/empty behaviour differs by socket:

  - `:wrapper_tokens` unset — in `:dev`/`:test` (`Application.get_env(
    :kaoiro_server, :env)`), wrapper auth is disabled (dev convenience):
    any wrapper may connect. In `:prod`, pair auth is simply absent:
    server-minted signed tokens (the spawn path, ADR-0024) still
    authenticate, everything else is rejected (fail-closed, issue
    #138) — a runner-only deployment needs no pair entries.
  - `:runner_tokens` unset — mirrors only the dev/test relaxation and
    the prod fail-closed (ADR-0011 per-entity tokens, extended to hosts
    by ADR-0023; issue #138). Runners have NO signed-token path: unset
    in `:prod` rejects every runner, unlike the wrapper's ADR-0024
    exception above.
  - `:client_tokens` unset — fail-closed in every env: every client
    connection is rejected (no token can authenticate), so a
    misconfigured deployment never silently grants operator (issue #28).

  Either unset state is logged at startup via `warn_token_config/0`
  (specs/protocol.md, specs/threat-model.md).
  """

  require Logger

  # Salt for the server-minted per-agent wrapper token (ADR-0024). A
  # constant, distinct from any other Phoenix.Token use.
  @wrapper_token_salt "kaoiro wrapper auth"

  @doc """
  Authorizes a wrapper connection for `agent_id`. `:ok` when wrapper auth
  is disabled (dev/test convenience — never in `:prod`, issue #138), the
  token matches a pre-registered `:wrapper_tokens` entry, or it is a
  valid server-minted signed token for this agent_id (the spawn path,
  ADR-0024). Otherwise `{:error, :unauthorized}`.

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
      # Dev/test convenience: no wrapper tokens configured → any wrapper
      # connects. In :prod an empty registry must NOT silently open up
      # (issue #138) — but it must not block the spawn path either: fall
      # through so a server-minted signed token (ADR-0024) still
      # authenticates. A runner-only deployment has no pair entries at
      # all, and gating the signed branch on a non-empty registry refused
      # every dashboard-launched wrapper as `unauthorized` (2026-08-02
      # gateway). Anything unsigned still lands on the final
      # fail-closed clause.
      tokens == %{} and not prod_env?() -> :ok
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
  token matches, or when no runner tokens are configured outside `:prod`.
  Mirrors `authorize_wrapper/2`'s pair auth against a separate
  `:runner_tokens` list since the host control channel is a distinct
  entity from the per-agent_id wrapper, and mirrors its :prod
  fail-closed (issue #138) — but NOT its signed-token branch: there is
  no minted-token concept for runners, so unset in :prod rejects every
  runner.
  """
  def authorize_runner(host_id, token) do
    tokens = parse_pairs(Application.get_env(:kaoiro_server, :runner_tokens))

    if tokens == %{} do
      if prod_env?(), do: {:error, :unauthorized}, else: :ok
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
  Resolves a client token to its role (`:viewer` | `:operator` |
  `:admin`), or
  `{:error, :unauthorized}` when it matches no configured token. With no
  client tokens configured at all, every connection is rejected
  (fail-closed, issue #28) — never granted operator.
  """
  def client_role(token) do
    tokens = parse_client_pairs(Application.get_env(:kaoiro_server, :client_tokens))

    # Fail closed: an empty token map makes role_for/2 return nil for any
    # token, so no client can authenticate. A misconfigured deployment is
    # then locked, not silently wide-open as operator (issue #28). The
    # startup warning explains the locked state.
    case role_for(tokens, token) do
      nil -> {:error, :unauthorized}
      role -> {:ok, role}
    end
  end

  @doc """
  The configured display name for a shared token (a `token:role:name`
  entry — issue #197 マスター決裁 2026-08-09 #1), or nil when the entry
  omits one or the token is unknown. Used only to seed
  `KaoiroServer.Users.get_or_create/4`'s initial_display_name on a
  token's first login; display_name is independently managed by the
  Users store afterward, so this is never re-read once a user exists
  for the token.
  """
  def client_token_display_name(token) when is_binary(token) do
    tokens = parse_client_pairs(Application.get_env(:kaoiro_server, :client_tokens))

    Enum.reduce(tokens, nil, fn {expected, %{name: name}}, acc ->
      if matches?(expected, token), do: name, else: acc
    end)
  end

  def client_token_display_name(_token), do: nil

  @doc """
  Opaque digest of a shared token for use ONLY as a
  `KaoiroServer.Users` secondary-index key (issue #197). Distinct from
  `socket_id/1` (which serves disconnect broadcasts and is itself
  exposed as a socket address) — this digest is not returned to any
  caller outside `KaoiroServer.Users` and MUST NOT reach a log line or
  wire payload (director review, issue #197): sha256 cannot be reversed
  to the token, but the digest is still an unnecessary correlation
  handle if it leaked into an audit trail.

  Deliberately no fallback clause (unlike `socket_id/1` /
  `client_token_display_name/1`, both of which return nil for a
  missing/blank token): every call site already holds a token that just
  passed `client_role/1`, so a nil/blank/non-binary argument here is a
  caller bug, not a runtime "no token" case — a `FunctionClauseError`
  surfaces that immediately instead of silently hashing garbage into
  the Users store's index.
  """
  def client_token_hash(token) when is_binary(token) and token != "" do
    Base.url_encode64(:crypto.hash(:sha256, token), padding: false)
  end

  @doc """
  `token_hash => role` for every configured client token (issue #197
  段階2, director D2/D10 判定). Built fresh from config on every call —
  never cached in socket/process state — so a caller building a single
  response (`KaoiroServer.Users.all_with_role/1`) can snapshot it ONCE
  and resolve every user's role against the same map, avoiding a
  split-brain read if config changes mid-response.

  Keyed by `client_token_hash/1` specifically (NOT `socket_id/1`'s
  `"client_socket:"`-prefixed digest, despite `client_role_by_fingerprint/1`
  using that one) — this is the same digest `KaoiroServer.Users`
  already stores as a `{:token, hash}` source, so a stored source joins
  directly with no second hash algorithm to keep in sync.
  `client_token_hash/1` and `socket_id/1` are independent APIs with no
  conversion between them; their digests are never compared or derived
  from one another anywhere in this codebase, and that must stay true —
  do not add a check or a test asserting a relationship between the two
  (director D10 改訂, issue #197 段階2: an earlier draft of this doc
  argued digest-space separation itself as a defense, which director
  review later withdrew as unfounded — reusing `socket_id/1` here would
  not actually "reopen" any correlation path, since the two functions'
  outputs are not made comparable by using one or the other). **The
  actual defense is `KaoiroServer.Users` keeping `source` internal-only
  (see its own moduledoc) — never returning it to a caller, a log line,
  or a wire payload — not any property of which hash function is used
  to build this map.**
  """
  def client_token_hash_role_map do
    Application.get_env(:kaoiro_server, :client_tokens)
    |> parse_client_pairs()
    |> Map.new(fn {token, %{role: role}} -> {client_token_hash(token), parse_role(role)} end)
  end

  defp role_for(tokens, token) when is_binary(token) do
    # Constant-time scan: compare against every entry so lookup timing
    # does not reveal whether a token exists.
    Enum.reduce(tokens, nil, fn {expected, %{role: role}}, acc ->
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
  Resolves a client token's role from its `socket_id/1` fingerprint
  instead of the token itself (issue #158, ふじ must-fix A).

  A live socket has to re-resolve its role on every operator action, but
  retaining the shared token in socket/channel state to do so would put
  the secret back into crash reports and heap dumps — exactly what
  `socket_id/1` exists to avoid. Hashing every configured token and
  comparing digests keeps the raw token out of process state entirely.

  Scans the whole list in constant time like `client_role/1`, and is
  fail-closed the same way: no configured tokens means no match.
  """
  def client_role_by_fingerprint(fingerprint) when is_binary(fingerprint) do
    tokens = parse_client_pairs(Application.get_env(:kaoiro_server, :client_tokens))

    case role_by_fingerprint(tokens, fingerprint) do
      nil -> {:error, :unauthorized}
      role -> {:ok, role}
    end
  end

  def client_role_by_fingerprint(_fingerprint), do: {:error, :unauthorized}

  defp role_by_fingerprint(tokens, fingerprint) do
    Enum.reduce(tokens, nil, fn {token, %{role: role}}, acc ->
      if fingerprint_matches?(token, fingerprint), do: parse_role(role), else: acc
    end)
  end

  defp fingerprint_matches?(token, fingerprint) do
    case socket_id(token) do
      nil -> false
      id -> Plug.Crypto.secure_compare(id, fingerprint)
    end
  end

  @doc """
  The `socket_id/1` counterpart for an OAuth identity (ADR-0042).

  Hashes `"oauth:<provider>:<uid>"` so an OAuth session gets a stable id
  in the same namespace as the token one, letting logout / allow-list
  revocation force-drop its live sockets through the same broadcast.
  The `"oauth:"` prefix keeps the two id spaces from ever colliding on a
  token whose bytes happen to look like an identity.
  """
  def oauth_socket_id(provider, uid)
      when is_binary(provider) and provider != "" and is_binary(uid) and uid != "" do
    digest = :crypto.hash(:sha256, "oauth:" <> provider <> ":" <> uid)
    "client_socket:" <> Base.url_encode64(digest, padding: false)
  end

  def oauth_socket_id(_provider, _uid), do: nil

  @doc """
  Whether shared-token client auth is usable at all, i.e. whether
  `:client_tokens` holds at least one well-formed entry. The dashboard
  reads this through `GET /session/auth-methods` so it only shows the
  token form when a token can actually authenticate (ADR-0042).
  """
  def token_auth_enabled? do
    parse_client_pairs(Application.get_env(:kaoiro_server, :client_tokens)) != %{}
  end

  @doc """
  Logs a startup warning for each token list that is unset, so the
  locked / dev-mode / fail-closed state is visible in logs rather than
  silent (specs/threat-model.md, issue #28, issue #138):

  - `:client_tokens` unset — client connections are rejected
    (fail-closed in every env); the env must be set to grant access.
  - `:wrapper_tokens` unset — dev/test: wrapper auth disabled, any
    wrapper may connect. `:prod`: pair auth off, only server-minted
    signed tokens (ADR-0024) authenticate; anything else is rejected.
  - `:runner_tokens` unset — dev/test relaxation and prod fail-closed
    as above, but with no signed-token path (ADR-0023): unset in
    `:prod` rejects every runner.

  Also forwards to `KaoiroServer.OAuth.warn_config/0` so the OAuth login
  path (ADR-0042) reports its own half-configured states from the same
  startup call.
  """
  def warn_token_config do
    if parse_client_pairs(Application.get_env(:kaoiro_server, :client_tokens)) == %{} do
      Logger.warning(
        "KAOIRO_CLIENT_TOKENS unset: client connections are rejected " <>
          "(no token can authenticate). Set it to grant viewer/operator/admin " <>
          "access (specs/threat-model.md)."
      )
    end

    if parse_pairs(Application.get_env(:kaoiro_server, :wrapper_tokens)) == %{} do
      Logger.warning(
        "KAOIRO_WRAPPER_TOKENS unset: " <> unset_wrapper_or_runner_message("wrapper")
      )
    end

    if parse_pairs(Application.get_env(:kaoiro_server, :runner_tokens)) == %{} do
      Logger.warning("KAOIRO_RUNNER_TOKENS unset: " <> unset_wrapper_or_runner_message("runner"))
    end

    warn_no_admin()

    KaoiroServer.OAuth.warn_config()
  end

  # issue #198 / ADR-0050 D2. The additive model starts with zero admins
  # and zero edges, so config is the ONLY entry point for the first one;
  # a deployment without an admin has no way to edit the permission graph
  # once issue #199 lands. Surface it at boot rather than at the moment
  # someone needs it and finds themselves locked out.
  #
  # The token count routes through `parse_role/1` rather than comparing
  # the raw string. For every input reaching it today the two agree —
  # `parse_client_pairs/1` has already trimmed, so `"admn"` fails both —
  # so this is NOT load-bearing right now and no test distinguishes them.
  # It is here to keep "who counts as admin" derived from the one function
  # that decides whether a token AUTHENTICATES as admin: an alias or a
  # normalization added there stays reflected in this count for free,
  # instead of leaving a second spelling table to remember.
  #
  # Counts only. The OAuth allow-list holds personal data (identifiers)
  # and must never reach the log — nothing derived from its ENTRIES is
  # emitted here, only whether the count is zero.
  defp warn_no_admin do
    token_admins =
      Application.get_env(:kaoiro_server, :client_tokens)
      |> parse_client_pairs()
      |> Enum.count(fn {_token, %{role: role}} -> parse_role(role) == :admin end)

    # Gated on the provider actually being configured (ふじ must-fix 1,
    # issue #198): an allow-list line grants nothing when its provider has
    # no credentials, so counting it hides a genuinely admin-less
    # deployment. The measured case: GitHub OAuth disabled, the only admin
    # on a `github:` line, Google enabled with operators — zero admin can
    # log in, and the warning stayed silent because the entry was counted.
    allowlist_admins =
      KaoiroServer.OAuthAllowlist.snapshot(log?: false)
      |> Enum.count(fn {{provider, _identifier}, role} ->
        role == :admin and KaoiroServer.OAuth.enabled?(provider)
      end)

    if token_admins + allowlist_admins == 0 do
      Logger.warning(
        "no usable admin: neither KAOIRO_CLIENT_TOKENS nor the allow-list " <>
          "of any ENABLED OAuth provider grants the admin role (ADR-0050 " <>
          "D2). An admin line on a provider without credentials does not " <>
          "count — nobody can log in through it. Permission-graph editing " <>
          "will have no entry point once per-pair permissions land."
      )
    end

    :ok
  end

  defp unset_wrapper_or_runner_message(entity) do
    cond do
      not prod_env?() ->
        "#{entity} auth disabled (dev mode); any #{entity} may connect. " <>
          "Set it before exposing beyond loopback (specs/threat-model.md)."

      entity == "wrapper" ->
        "pair auth disabled; only server-minted wrapper tokens (the " <>
          "spawn path, ADR-0024) authenticate, anything else is " <>
          "rejected (fail-closed in prod, issue #138). Set it to " <>
          "pre-register fixed wrappers."

      true ->
        "#{entity} connections are rejected (fail-closed in prod, issue #138). " <>
          "Set it to allow #{entity}s to connect."
    end
  end

  # issue #138: dev/test keep the pre-existing "unset → wide open"
  # convenience; :prod fails closed instead so a release started without
  # KAOIRO_WRAPPER_TOKENS / KAOIRO_RUNNER_TOKENS never silently accepts
  # any wrapper/runner. Backed by config.exs' `env: config_env()` since
  # config_env() itself cannot be called at runtime.
  defp prod_env?, do: Application.get_env(:kaoiro_server, :env) == :prod

  defp parse_role("viewer"), do: :viewer
  defp parse_role("operator"), do: :operator
  # admin is the bootstrap path ADR-0050 D2 requires: the additive
  # permission model starts with zero admins and zero edges, so a role
  # declared in config is the only way to create the first one. Unknown
  # role words keep falling through to nil (fail-closed) — a typo'd
  # "admn" must not authenticate at all rather than degrade to viewer.
  defp parse_role("admin"), do: :admin
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

  # "token:role[:name]" -> %{token => %{role: "admin"|"operator"|"viewer", name:
  # binary | nil}}. Kept separate from parse_pairs/1 (shared by
  # wrapper_tokens/runner_tokens, which have no name concept) so a ':'
  # inside a configured name cannot desync those pair lists (issue #197
  # マスター決裁 2026-08-09 #1, "共有トークン user は token の設定名を
  # 初期値とする").
  defp parse_client_pairs(raw) when is_binary(raw) and raw != "" do
    raw
    |> String.split(",", trim: true)
    |> Enum.reduce(%{}, fn pair, acc ->
      case String.split(pair, ":", parts: 3) do
        [token, role] when token != "" and role != "" ->
          Map.put(acc, String.trim(token), %{role: String.trim(role), name: nil})

        [token, role, name] when token != "" and role != "" ->
          trimmed_name = String.trim(name)
          name = if trimmed_name == "", do: nil, else: trimmed_name
          Map.put(acc, String.trim(token), %{role: String.trim(role), name: name})

        _ ->
          Logger.warning("ignoring malformed auth token entry")
          acc
      end
    end)
  end

  defp parse_client_pairs(_raw), do: %{}
end
