defmodule KaoiroServer.DeviceAuthTest do
  # Each test runs its own DeviceAuth with an injected clock (milliseconds).
  # async: false — the clustering guard reads :dns_cluster_query, which some
  # tests set.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.DeviceAuth

  @ao %{provider: "nextcloud", uid: "ao"}
  @mio %{provider: "nextcloud", uid: "mio"}
  @t0 1_800_000_000_000

  setup do
    previous = Application.get_env(:kaoiro_server, :dns_cluster_query)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:kaoiro_server, :dns_cluster_query, previous),
        else: Application.delete_env(:kaoiro_server, :dns_cluster_query)
    end)

    clock = start_supervised!({Agent, fn -> @t0 end})
    {:ok, clock: clock, server: start_store(clock)}
  end

  defp start_store(clock, opts \\ []) do
    name = :"device_auth_test_#{System.unique_integer([:positive])}"

    start_supervised!(
      {DeviceAuth, [name: name, clock: fn -> Agent.get(clock, & &1) end] ++ opts},
      id: name
    )

    name
  end

  defp at(clock, ms), do: Agent.update(clock, fn _ -> @t0 + ms end)

  defp issue!(server, client_id \\ "kaoiro-client.nvim") do
    {:ok, issued} = DeviceAuth.issue(client_id, server)
    issued
  end

  describe "issue" do
    test "returns the RFC 8628 §3.2 values", %{server: server} do
      issued = issue!(server)

      assert %{expires_in: 600, interval: 5} = issued

      assert issued.user_code =~
               ~r/\A[BCDFGHJKLMNPQRSTVWXZ]{3}-[BCDFGHJKLMNPQRSTVWXZ]{3}-[BCDFGHJKLMNPQRSTVWXZ]{3}\z/

      assert {:ok, raw} = Base.url_decode64(issued.device_code, padding: false)
      assert byte_size(raw) == 32
    end

    test "codes do not repeat", %{server: server, clock: clock} do
      issued =
        for batch <- 0..1, _ <- 1..10 do
          at(clock, batch * 61_000)
          issue!(server)
        end

      assert issued |> Enum.map(& &1.device_code) |> Enum.uniq() |> length() == 20
      assert issued |> Enum.map(& &1.user_code) |> Enum.uniq() |> length() == 20
    end
  end

  # G1 / G2: the §4.9 polling timeline, to the millisecond.
  describe "polling interval" do
    test "follows the slow_down timeline", %{server: server, clock: clock} do
      %{device_code: code} = issue!(server)

      for {t, expected} <- [
            {1_000, :slow_down},
            {10_900, :slow_down},
            {25_900, :authorization_pending},
            {40_800, :slow_down},
            {60_800, :authorization_pending}
          ] do
        at(clock, t)

        assert {:error, ^expected} = DeviceAuth.consume(code, "kaoiro-client.nvim", server),
               "t=#{t}"
      end
    end

    test "the first boundary is exactly the interval", %{server: server, clock: clock} do
      %{device_code: early} = issue!(server)
      %{device_code: on_time} = issue!(server)

      at(clock, 4_999)
      assert {:error, :slow_down} = DeviceAuth.consume(early, "kaoiro-client.nvim", server)
      at(clock, 5_000)

      assert {:error, :authorization_pending} =
               DeviceAuth.consume(on_time, "kaoiro-client.nvim", server)
    end
  end

  describe "consume" do
    # G3
    test "an approved code is returned once", %{server: server, clock: clock} do
      %{device_code: code, user_code: user_code} = issue!(server)
      assert {:ok, :approved} = DeviceAuth.decide(user_code, @ao, :approve, server)

      at(clock, 5_000)
      assert {:ok, @ao} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
      at(clock, 20_000)
      assert {:error, :invalid_grant} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
      assert DeviceAuth.count(server) == 0
    end

    # G4
    test "two concurrent polls of an approved code succeed once", %{server: server, clock: clock} do
      %{device_code: code, user_code: user_code} = issue!(server)
      {:ok, :approved} = DeviceAuth.decide(user_code, @ao, :approve, server)
      at(clock, 5_000)

      results =
        1..2
        |> Enum.map(fn _ ->
          Task.async(fn -> DeviceAuth.consume(code, "kaoiro-client.nvim", server) end)
        end)
        |> Enum.map(&Task.await/1)
        |> Enum.sort()

      assert results == [{:error, :invalid_grant}, {:ok, @ao}]
    end

    # G5
    test "expiry: expired_token in the grace period, invalid_grant after it", %{
      server: server,
      clock: clock
    } do
      %{device_code: code} = issue!(server)

      at(clock, 599_999)

      assert {:error, :authorization_pending} =
               DeviceAuth.consume(code, "kaoiro-client.nvim", server)

      at(clock, 600_000)
      assert {:error, :expired_token} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
      at(clock, 1_199_999)
      assert {:error, :expired_token} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
      at(clock, 1_200_000)
      assert {:error, :invalid_grant} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
    end

    # G6
    test "a denied code says so once", %{server: server, clock: clock} do
      %{device_code: code, user_code: user_code} = issue!(server)
      assert {:ok, :denied} = DeviceAuth.decide(user_code, @ao, :deny, server)

      at(clock, 5_000)
      assert {:error, :access_denied} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
      at(clock, 20_000)
      assert {:error, :invalid_grant} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
    end

    # G8
    test "another client_id is invalid_grant and changes nothing", %{server: server, clock: clock} do
      %{device_code: code, user_code: user_code} = issue!(server)
      {:ok, :approved} = DeviceAuth.decide(user_code, @ao, :approve, server)

      at(clock, 1_000)
      assert {:error, :invalid_grant} = DeviceAuth.consume(code, "someone-else", server)
      # Had the wrong client's early poll counted, this would be slow_down.
      at(clock, 5_000)
      assert {:ok, @ao} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
    end

    test "an unknown device code is invalid_grant", %{server: server} do
      assert {:error, :invalid_grant} = DeviceAuth.consume("nope", "kaoiro-client.nvim", server)
    end
  end

  describe "lookup and decide" do
    test "lookup shows the pending device", %{server: server, clock: clock} do
      %{user_code: user_code} = issue!(server)
      at(clock, 100_400)

      assert {:ok, info} = DeviceAuth.lookup(user_code, @ao, server)

      assert info == %{
               user_code: user_code,
               client_id: "kaoiro-client.nvim",
               issued_at: div(@t0, 1000),
               expires_in: 499
             }
    end

    # G17
    test "a decided code is not decided again", %{server: server} do
      %{user_code: user_code} = issue!(server)
      assert {:ok, :approved} = DeviceAuth.decide(user_code, @ao, :approve, server)
      assert {:error, :already_decided} = DeviceAuth.decide(user_code, @ao, :deny, server)
      assert {:error, :already_decided} = DeviceAuth.decide(user_code, @mio, :approve, server)
    end

    test "the first decision stands", %{server: server, clock: clock} do
      %{device_code: code, user_code: user_code} = issue!(server)
      {:ok, :approved} = DeviceAuth.decide(user_code, @ao, :approve, server)
      {:error, :already_decided} = DeviceAuth.decide(user_code, @mio, :deny, server)

      at(clock, 5_000)
      assert {:ok, @ao} = DeviceAuth.consume(code, "kaoiro-client.nvim", server)
    end

    test "an expired code is expired for lookup and decide", %{server: server, clock: clock} do
      %{user_code: user_code} = issue!(server)
      at(clock, 600_000)

      assert {:error, :expired} = DeviceAuth.lookup(user_code, @ao, server)
      assert {:error, :expired} = DeviceAuth.decide(user_code, @ao, :approve, server)
    end

    # G23
    test "user codes match after normalization", %{server: server} do
      %{user_code: user_code} = issue!(server)
      bare = String.replace(user_code, "-", "")

      spaced =
        bare |> String.graphemes() |> Enum.chunk_every(3) |> Enum.map_join(" ", &Enum.join/1)

      for typed <- [String.downcase(user_code), bare, " " <> spaced <> " ", String.downcase(bare)] do
        assert {:ok, %{user_code: ^user_code}} = DeviceAuth.lookup(typed, @ao, server), typed
      end
    end

    test "letters outside the alphabet do not match", %{server: server} do
      _ = issue!(server)

      for typed <- ["AEIOU-0123", "", "----", "aaaaaaaaa"] do
        assert {:error, :unknown_code} = DeviceAuth.lookup(typed, @mio, server), typed
      end
    end
  end

  describe "failure limits" do
    # G15
    test "five failures per identity in 900 seconds", %{server: server, clock: clock} do
      %{user_code: user_code} = issue!(server)

      for _ <- 1..5,
          do: assert({:error, :unknown_code} = DeviceAuth.lookup("BBB-BBB-BBB", @ao, server))

      assert {:error, {:rate_limited, 900}} = DeviceAuth.lookup(user_code, @ao, server)
      assert {:error, {:rate_limited, 900}} = DeviceAuth.decide(user_code, @ao, :approve, server)
      assert {:ok, _} = DeviceAuth.lookup(user_code, @mio, server)

      at(clock, 899_999)
      assert {:error, {:rate_limited, 1}} = DeviceAuth.lookup("BBB-BBB-BBB", @ao, server)
      at(clock, 900_000)
      %{user_code: fresh} = issue!(server)
      assert {:ok, _} = DeviceAuth.lookup(fresh, @ao, server)
    end

    test "expired codes count as failures", %{server: server, clock: clock} do
      %{user_code: user_code} = issue!(server)
      at(clock, 600_000)

      for _ <- 1..5, do: assert({:error, :expired} = DeviceAuth.lookup(user_code, @ao, server))
      assert {:error, {:rate_limited, _}} = DeviceAuth.lookup(user_code, @ao, server)
    end

    # G16
    test "twenty failures in total across identities", %{server: server} do
      %{user_code: user_code} = issue!(server)

      for uid <- ~w(a b c d e), _ <- 1..4 do
        assert {:error, :unknown_code} =
                 DeviceAuth.lookup("BBB-BBB-BBB", %{provider: "nextcloud", uid: uid}, server)
      end

      assert {:error, {:rate_limited, _}} = DeviceAuth.lookup(user_code, @mio, server)
    end

    test "nineteen failures leave the global limit open", %{server: server} do
      %{user_code: user_code} = issue!(server)

      for uid <- ~w(a b c d e), n <- 1..4, {uid, n} != {"e", 4} do
        DeviceAuth.lookup("BBB-BBB-BBB", %{provider: "nextcloud", uid: uid}, server)
      end

      assert {:ok, _} = DeviceAuth.lookup(user_code, @mio, server)
    end
  end

  describe "capacity" do
    # G18
    test "twenty pending codes", %{server: server, clock: clock} do
      for batch <- 0..1, _ <- 1..10 do
        at(clock, batch * 61_000)
        issue!(server)
      end

      at(clock, 122_000)
      assert {:error, {:unavailable, :capacity}} = DeviceAuth.issue("x", server)
    end

    # G19
    test "sixty-four entries in any state", %{server: server, clock: clock} do
      for n <- 0..63 do
        if rem(n, 10) == 0, do: at(clock, div(n, 10) * 61_000)
        %{user_code: user_code} = issue!(server)
        # Approved entries stay held, so pending never reaches 20.
        {:ok, :approved} = DeviceAuth.decide(user_code, @ao, :approve, server)
      end

      assert DeviceAuth.count(server) == 64
      at(clock, 7 * 61_000)
      assert {:error, {:unavailable, :capacity}} = DeviceAuth.issue("x", server)
    end

    # G20
    test "ten issues in any sixty seconds", %{server: server, clock: clock} do
      for _ <- 1..10, do: issue!(server)

      assert {:error, {:rate_limited, 60}} = DeviceAuth.issue("x", server)
      at(clock, 59_001)
      assert {:error, {:rate_limited, 1}} = DeviceAuth.issue("x", server)
      at(clock, 60_000)
      assert {:ok, _} = DeviceAuth.issue("x", server)
    end
  end

  # G21
  describe "sweep" do
    test "entries past their grace period leave with their user code", %{
      server: server,
      clock: clock
    } do
      %{user_code: user_code} = issue!(server)
      assert DeviceAuth.count(server) == 1

      at(clock, 1_200_000)
      assert DeviceAuth.count(server) == 0
      assert {:error, :unknown_code} = DeviceAuth.lookup(user_code, @ao, server)
    end

    test "the periodic sweep runs without a call", %{server: server, clock: clock} do
      _ = issue!(server)
      table = :sys.get_state(server).table

      at(clock, 1_200_000)
      send(Process.whereis(server), :sweep)
      _ = :sys.get_state(server)

      assert :ets.info(table, :size) == 0
    end
  end

  # G26 / G27
  describe "single backend" do
    test "a non-empty dns_cluster_query disables the store", %{clock: clock} do
      Application.put_env(:kaoiro_server, :dns_cluster_query, "kaoiro.internal")

      log = capture_log(fn -> send(self(), {:server, start_store(clock)}) end)
      assert_received {:server, server}

      assert log =~ "single backend"
      refute DeviceAuth.available?(server)
      assert {:error, {:unavailable, :clustered}} = DeviceAuth.issue("x", server)
    end

    for query <- [nil, :ignore, ""] do
      test "#{inspect(query)} is not clustered", %{clock: clock} do
        Application.put_env(:kaoiro_server, :dns_cluster_query, unquote(query))
        server = start_store(clock)

        assert DeviceAuth.available?(server)
        assert {:ok, _} = DeviceAuth.issue("x", server)
      end
    end

    test "a connected node makes it unavailable", %{clock: clock} do
      server = start_store(clock, node_list: fn -> [:other@host] end)
      refute DeviceAuth.available?(server)
    end
  end
end
