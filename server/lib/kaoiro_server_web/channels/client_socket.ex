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

    case authorize(credential) do
      {:ok, role, socket_id} ->
        # Stamp a credential-derived id (issue #47) so a logout /
        # revocation can target this socket via Endpoint.disconnect.
        # Derived from the underlying token or identity, never stored raw.
        {:ok,
         socket
         |> assign(:role, role)
         |> assign(:socket_id, socket_id)}

      :error ->
        :error
    end
  end

  defp authorize({:token, token}) do
    case Auth.client_role(token) do
      {:ok, role} -> {:ok, role, Auth.socket_id(token)}
      {:error, _reason} -> :error
    end
  end

  # The allow-list is consulted on every connect rather than trusting a
  # role stored at login time, so removing a line drops the identity at
  # its next reconnect (ADR-0042).
  defp authorize({:oauth, %{provider: provider, uid: uid}}) do
    case OAuthAllowlist.role_for(provider, uid) do
      nil -> :error
      role -> {:ok, role, Auth.oauth_socket_id(provider, uid)}
    end
  end

  defp authorize(_credential), do: :error

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
