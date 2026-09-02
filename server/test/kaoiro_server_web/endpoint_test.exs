defmodule KaoiroServerWeb.EndpointTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.TransportLimits

  describe "socket max_frame_size (#154 M2)" do
    test "3 ソケットすべてが TransportLimits の実 frame 上限を使う" do
      # A socket without an explicit cap falls back to Phoenix's
      # :infinity default, letting an unauthenticated peer park an
      # arbitrarily large frame in the receive buffer. /runner is the
      # easiest target: RunnerSocket.connect/3 accepts unconditionally
      # (auth happens at channel join).
      for path <- ["/wrapper", "/runner", "/client"] do
        {_path, _mod, opts} =
          Enum.find(KaoiroServerWeb.Endpoint.__sockets__(), fn {p, _, _} ->
            p == path
          end)

        assert get_in(opts, [:websocket, :max_frame_size]) == TransportLimits.max_frame_bytes(),
               "#{path} は max_frame_size 未設定 (Phoenix 既定の :infinity)"
      end
    end
  end
end
