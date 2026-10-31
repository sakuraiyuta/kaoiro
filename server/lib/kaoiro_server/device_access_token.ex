defmodule KaoiroServer.DeviceAccessToken do
  @moduledoc """
  The bearer access token a native client receives from the device
  authorization grant (issue 801, RFC 8628). It is a `Phoenix.Token`
  encryption of `%{provider, uid, iat}` under its own salt, so it carries
  the same identity as the browser's OAuth session cookie and the server
  keeps no state for it.

  Two lifetimes apply. The sliding lifetime runs from the token's
  `signed_at` (the issue or refresh time) and is checked by
  `Phoenix.Token.decrypt/4`. The absolute lifetime runs from `iat`, the
  time of the first issue, which a refresh carries over unchanged, so a
  stolen token cannot be kept alive by refreshing it forever. The browser
  cookie has no absolute lifetime (ADR-0013); these constants are kept
  apart from the cookie's max_age on purpose.
  """

  @salt "device_access"
  @sliding 259_200
  @absolute 2_592_000
  @skew 60

  @type identity :: %{provider: String.t(), uid: String.t()}

  @doc "Encrypts `identity` with first-issue time `iat`, signed at `now` (Unix seconds)."
  @spec encrypt(identity(), integer(), integer()) :: String.t()
  def encrypt(%{provider: provider, uid: uid}, iat, now) do
    Phoenix.Token.encrypt(
      KaoiroServerWeb.Endpoint,
      @salt,
      %{provider: provider, uid: uid, iat: iat},
      signed_at: now,
      max_age: @sliding
    )
  end

  @doc """
  Decrypts `token` and checks both lifetimes against `now` (Unix seconds).
  A failure carries no part of the payload.
  """
  @spec decrypt(String.t(), integer()) ::
          {:ok, %{identity: identity(), issued_at: integer()}}
          | {:error, :invalid | :expired | :too_old}
  def decrypt(token, now) do
    case Phoenix.Token.decrypt(KaoiroServerWeb.Endpoint, @salt, token, max_age: @sliding) do
      {:ok, payload} -> check_payload(payload, now)
      {:error, :expired} -> {:error, :expired}
      {:error, _reason} -> {:error, :invalid}
    end
  end

  @doc """
  Seconds left for a token first issued at `issued_at`, at `now`:
  `min(now + sliding, issued_at + absolute) - now`. Zero or less means
  no token may be issued.
  """
  @spec expires_in(integer(), integer()) :: integer()
  def expires_in(issued_at, now), do: min(now + @sliding, issued_at + @absolute) - now

  defp check_payload(%{provider: provider, uid: uid, iat: iat} = payload, now)
       when map_size(payload) == 3 and is_binary(provider) and provider != "" and
              is_binary(uid) and uid != "" and is_integer(iat) do
    cond do
      iat <= 0 or iat > now + @skew -> {:error, :invalid}
      now - iat >= @absolute -> {:error, :too_old}
      true -> {:ok, %{identity: %{provider: provider, uid: uid}, issued_at: iat}}
    end
  end

  defp check_payload(_payload, _now), do: {:error, :invalid}
end
