defmodule KaoiroServer.DeviceAccessTokenTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.DeviceAccessToken

  @endpoint KaoiroServerWeb.Endpoint
  @salt "device_access"
  @day 86_400
  @identity %{provider: "nextcloud", uid: "ao"}

  defp now, do: System.system_time(:second)

  # Builds a token the way an attacker or an old server would: straight
  # through Phoenix.Token, with any payload and signing time.
  defp raw_token(payload, signed_at),
    do: Phoenix.Token.encrypt(@endpoint, @salt, payload, signed_at: signed_at)

  test "a token round-trips its identity and first-issue time" do
    now = now()
    token = DeviceAccessToken.encrypt(@identity, now - @day, now)

    assert {:ok, %{identity: @identity, issued_at: iat}} = DeviceAccessToken.decrypt(token, now)
    assert iat == now - @day
  end

  # G31
  test "a token altered in one byte is invalid" do
    now = now()
    token = DeviceAccessToken.encrypt(@identity, now, now)
    middle = div(byte_size(token), 2)
    <<head::binary-size(^middle), byte, tail::binary>> = token
    flipped = if byte == ?A, do: ?B, else: ?A

    assert {:error, :invalid} =
             DeviceAccessToken.decrypt(<<head::binary, flipped, tail::binary>>, now)
  end

  test "a token sealed under another salt is invalid" do
    now = now()
    ticket = Phoenix.Token.encrypt(@endpoint, "client_ws", @identity)

    assert {:error, :invalid} = DeviceAccessToken.decrypt(ticket, now)
  end

  # G39: the sliding lifetime runs from signed_at, not from iat.
  describe "sliding lifetime" do
    test "a token signed three days and one second ago has expired" do
      now = now()
      signed = now - 3 * @day - 1
      token = raw_token(%{provider: "nextcloud", uid: "ao", iat: signed}, signed)

      assert {:error, :expired} = DeviceAccessToken.decrypt(token, now)
    end

    test "a token signed three days less one second ago is valid" do
      now = now()
      signed = now - 3 * @day + 1
      token = raw_token(%{provider: "nextcloud", uid: "ao", iat: signed}, signed)

      assert {:ok, _} = DeviceAccessToken.decrypt(token, now)
    end
  end

  # G41 at the token level. The refresh side is in SessionCredentialBearerTest.
  describe "absolute lifetime" do
    test "iat thirty days and one second ago is too old even when freshly signed" do
      now = now()
      token = DeviceAccessToken.encrypt(@identity, now - 30 * @day - 1, now)

      assert {:error, :too_old} = DeviceAccessToken.decrypt(token, now)
    end

    test "iat exactly thirty days ago is too old (no zero-second token)" do
      now = now()
      token = DeviceAccessToken.encrypt(@identity, now - 30 * @day, now)

      assert {:error, :too_old} = DeviceAccessToken.decrypt(token, now)
    end

    test "iat thirty days less one second ago is still valid" do
      now = now()
      token = DeviceAccessToken.encrypt(@identity, now - 30 * @day + 1, now)

      assert {:ok, _} = DeviceAccessToken.decrypt(token, now)
    end

    test "iat more than sixty seconds in the future is invalid" do
      now = now()
      token = DeviceAccessToken.encrypt(@identity, now + 61, now)

      assert {:error, :invalid} = DeviceAccessToken.decrypt(token, now)
    end

    test "iat within the sixty-second clock skew is accepted" do
      now = now()
      token = DeviceAccessToken.encrypt(@identity, now + 30, now)

      assert {:ok, _} = DeviceAccessToken.decrypt(token, now)
    end

    test "expires_in is capped by the absolute lifetime" do
      now = now()

      assert DeviceAccessToken.expires_in(now - 29 * @day, now) == @day
      assert DeviceAccessToken.expires_in(now - @day, now) == 3 * @day
      assert DeviceAccessToken.expires_in(now, now) == 3 * @day
      assert DeviceAccessToken.expires_in(now - 30 * @day, now) == 0
    end
  end

  # G42: anything but exactly %{provider, uid, iat} with the right types.
  describe "payload shape" do
    for {label, payload} <- [
          {"non-binary provider and uid", quote(do: %{provider: 1, uid: nil, iat: now()})},
          {"a bare string", quote(do: "nextcloud:ao")},
          {"a missing iat", quote(do: %{provider: "nextcloud", uid: "ao"})},
          {"a float iat", quote(do: %{provider: "nextcloud", uid: "ao", iat: now() * 1.0})},
          {"a fourth key",
           quote(do: %{provider: "nextcloud", uid: "ao", iat: now(), role: :admin})},
          {"an empty uid", quote(do: %{provider: "nextcloud", uid: "", iat: now()})}
        ] do
      test "#{label} is invalid" do
        now = now()
        token = raw_token(unquote(payload), now)

        assert {:error, :invalid} = DeviceAccessToken.decrypt(token, now)
      end
    end

    test "the well-formed payload is the positive control" do
      now = now()
      token = raw_token(%{provider: "nextcloud", uid: "ao", iat: now}, now)

      assert {:ok, _} = DeviceAccessToken.decrypt(token, now)
    end
  end
end
