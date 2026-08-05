defmodule KaoiroServerWeb.ClientSocket do
  @moduledoc """
  Socket for client connections (public protocol, ADR-0009: Channels only,
  vsn=2.0.0). Access control resolves a viewer/operator role from one of
  two credentials: a shared token (ADR-0011, the ADR-0005 whitelist made
  concrete) or an OAuth identity checked against the allow-list
  (ADR-0042). Either one is resolved, in order, from: a short-lived
  `ticket` param (the reload path — the SPA mints it from the httpOnly
  cookie via GET /session/ticket, ADR-0013), a `token` param (first load
  with `?token=`), or the session cookie if one rode the handshake.

  The role is resolved here on every connect, never carried in the
  credential: with no client tokens configured a token connection is
  rejected (fail-closed, issue #28), and an identity that has left the
  allow-list is rejected the same way. A misconfigured deployment is
  locked, not silently exposed as operator.

  A re-resolvable form of the credential is kept in the assigns so the
  resolution can be REPEATED while the socket is open: `role_for/1` is
  what `AgentsChannel`'s operator gate calls on every inbound operator
  action, so an allow-list demotion lands on a socket that is already
  connected instead of waiting for its next connect (issue #158).
  `role_for/1` is also what `AgentsChannel.join/3` calls before
  completing the join, closing the connect-to-join race where an
  allow-list change lands between this module resolving the snapshot
  role and the transport finishing its disconnect-topic subscription
  (issue #170). A shared token is reduced to its `Auth.socket_id/1`
  fingerprint first — the raw token never enters socket or channel
  state, so it cannot resurface in a crash report or heap dump.
  """

  use Phoenix.Socket

  alias KaoiroServer.Auth
  alias KaoiroServer.OAuthAllowlist

  # Matches the salt used by SessionController.ticket/2.
  @ws_ticket_salt "client_ws"
  @ws_ticket_max_age 30

  channel "agents:*", KaoiroServerWeb.AgentsChannel

  @impl true
  def connect(params, socket, connect_info) do
    credential =
      ticket_credential(socket, params["ticket"]) || credential(params["token"]) ||
        session_credential(connect_info)

    case role_for(credential) do
      nil ->
        :error

      role ->
        # Stamp a credential-derived id (issue #47) so a logout /
        # revocation can target this socket via Endpoint.disconnect.
        # Derived from the underlying token or identity, never stored raw.
        {:ok,
         socket
         |> assign(:role, role)
         |> assign(:credential, re_resolvable(credential))
         |> assign(:socket_id, socket_id(credential))}
    end
  end

  # What the gate re-resolves from later. A shared token is replaced by
  # its fingerprint so the secret itself is not retained (ふじ must-fix A
  # on issue #158); an OAuth identity is not a secret and is kept as is.
  defp re_resolvable({:token, token}), do: {:token_fingerprint, Auth.socket_id(token)}
  defp re_resolvable({:oauth, _identity} = credential), do: credential

  @doc """
  Resolves a credential to its role, or `nil` when it authorizes nothing
  (unknown token, identity off the allow-list, unusable shape).

  Both sources are consulted live rather than trusting a role captured
  at login time, so removing or downgrading an allow-list line lands at
  the next call — connect (ADR-0042) or an operator action on an
  already-open socket (issue #158).

  `{:token, token}` is the connect-time shape (the presented secret);
  `{:token_fingerprint, fp}` is what an open socket carries, resolved by
  digest so the token stays out of process state.
  """
  @spec role_for(term()) :: :viewer | :operator | nil
  def role_for({:token, token}), do: unwrap(Auth.client_role(token))

  def role_for({:token_fingerprint, fingerprint}),
    do: unwrap(Auth.client_role_by_fingerprint(fingerprint))

  def role_for({:oauth, %{provider: provider, uid: uid}}),
    do: OAuthAllowlist.role_for(provider, uid)

  def role_for(_credential), do: nil

  defp unwrap({:ok, role}), do: role
  defp unwrap({:error, _reason}), do: nil

  defp socket_id({:token, token}), do: Auth.socket_id(token)

  defp socket_id({:oauth, %{provider: provider, uid: uid}}),
    do: Auth.oauth_socket_id(provider, uid)

  # Decrypts a short-lived WS ticket back to its credential (ADR-0013), or
  # nil when absent/expired/forged — Vite cannot carry the cookie on a WS
  # upgrade, so the reload path authenticates with this ticket instead.
  # Decrypt (not verify): the ticket is encrypted so an embedded token
  # stays confidential against an XSS reading the JS-held ticket.
  defp ticket_credential(_socket, nil), do: nil

  defp ticket_credential(socket, ticket) do
    case Phoenix.Token.decrypt(socket, @ws_ticket_salt, ticket, max_age: @ws_ticket_max_age) do
      {:ok, payload} -> credential(payload)
      {:error, _reason} -> nil
    end
  end

  # A ticket / session payload is either a raw token (ADR-0013) or an
  # OAuth identity map (ADR-0042); the shape tells them apart.
  defp credential(token) when is_binary(token) and token != "", do: {:token, token}

  defp credential(%{provider: provider, uid: uid})
       when is_binary(provider) and is_binary(uid),
       do: {:oauth, %{provider: provider, uid: uid}}

  defp credential(_payload), do: nil

  # The session cookie rides the handshake only for a same-origin connection
  # (prod); connect_info carries it when present, nil otherwise.
  defp session_credential(%{session: %{} = session}),
    do: credential(session["oauth_identity"]) || credential(session["client_token"])

  defp session_credential(_connect_info), do: nil

  # Credential-derived id (issue #47): lets the server force-disconnect
  # this socket on logout / revocation. connect/3 only succeeds with a
  # valid credential, so the assign is always a binary here.
  @impl true
  def id(socket), do: socket.assigns[:socket_id]
end
