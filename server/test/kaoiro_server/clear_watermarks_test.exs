defmodule KaoiroServer.ClearWatermarksTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.ClearWatermarks

  setup do
    name = :"cw_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
    File.rm(path)
    {:ok, pid} = ClearWatermarks.start_link(name: name, path: path)

    on_exit(fn ->
      # #169: alive? と stop の間にテスト終了のリンク死が挟まると
      # `no process` で teardown だけが落ちる。詳細は
      # session_starts_test.exs の同 cushion を参照。
      try do
        if Process.alive?(pid), do: GenServer.stop(pid)
      catch
        :exit, _ -> :ok
      end

      File.rm(path)
    end)

    %{server: name, path: path}
  end

  # Same-domain tuple as InterAgentHistory.append/2 stamps at ingress.
  defp order(us, uniq), do: {us, uniq}

  test "record してから get すると {order, display} が返る", %{server: server} do
    :ok = ClearWatermarks.record("a.1", order(1_000_000, 1), "2026-07-23T15:00:00Z", server)

    assert ClearWatermarks.get("a.1", server) ==
             {order(1_000_000, 1), "2026-07-23T15:00:00Z", nil}

    # 便利 helper: order だけ / display だけ。
    assert ClearWatermarks.get_order("a.1", server) == order(1_000_000, 1)
    assert ClearWatermarks.get_display("a.1", server) == "2026-07-23T15:00:00Z"
  end

  test "未知 agent は nil", %{server: server} do
    assert ClearWatermarks.get("a.none", server) == nil
    assert ClearWatermarks.get_order("a.none", server) == nil
    assert ClearWatermarks.get_display("a.none", server) == nil
  end

  test "新しい order への更新は上書き、古い order への更新は無視 (単調前進)",
       %{server: server} do
    :ok =
      ClearWatermarks.record("a.2", order(1_000_000, 1), "2026-07-23T15:00:00Z", server)

    # 新しい order は上書き。
    :ok =
      ClearWatermarks.record("a.2", order(2_000_000, 5), "2026-07-23T16:00:00Z", server)

    assert ClearWatermarks.get_order("a.2", server) == order(2_000_000, 5)

    # 古い order (out-of-order retry) は無視 — さもないと過去の IA が再露出する。
    :ok =
      ClearWatermarks.record("a.2", order(500_000, 0), "2026-07-23T14:00:00Z", server)

    assert ClearWatermarks.get_order("a.2", server) == order(2_000_000, 5)
    assert ClearWatermarks.get_display("a.2", server) == "2026-07-23T16:00:00Z"
  end

  test "同一 DETS ファイルからの再起動で order と display が両方残る",
       %{server: server, path: path} do
    :ok =
      ClearWatermarks.record("a.3", order(3_000_000, 7), "2026-07-23T15:30:00Z", server)

    :ok = GenServer.stop(server)

    name2 = :"cw_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: name2, path: path)

    assert ClearWatermarks.get("a.3", name2) ==
             {order(3_000_000, 7), "2026-07-23T15:30:00Z", nil}

    GenServer.stop(name2)
  end

  test "all_orders は agent_id => order の filter-path map、all_displays は audit map",
       %{server: server} do
    :ok =
      ClearWatermarks.record("a.4", order(4_000_000, 1), "2026-07-23T15:00:00Z", server)

    :ok =
      ClearWatermarks.record("a.5", order(5_000_000, 2), "2026-07-23T15:01:00Z", server)

    orders = ClearWatermarks.all_orders(server)
    displays = ClearWatermarks.all_displays(server)
    assert orders["a.4"] == order(4_000_000, 1)
    assert orders["a.5"] == order(5_000_000, 2)
    assert displays["a.4"] == "2026-07-23T15:00:00Z"
    assert displays["a.5"] == "2026-07-23T15:01:00Z"
  end

  test "delete で order が消え、再起動後も残らない", %{server: server, path: path} do
    :ok =
      ClearWatermarks.record("a.6", order(6_000_000, 1), "2026-07-23T15:00:00Z", server)

    assert ClearWatermarks.delete("a.6", server) == :ok
    assert ClearWatermarks.get("a.6", server) == nil

    :ok = GenServer.stop(server)
    name2 = :"cw_delete_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: name2, path: path)
    assert ClearWatermarks.get("a.6", name2) == nil
    GenServer.stop(name2)
  end

  test "delete は未知 agent でも :ok (冪等)", %{server: server} do
    assert ClearWatermarks.delete("a.none", server) == :ok
  end

  # M7-a regression pin (ふじ #109 must-fix): record must be synchronous
  # and fsync-gated so an operator's `history_cleared` broadcast can
  # never fire before disk persistence lands. `record/4` returning `:ok`
  # is the pin — a cast implementation would have returned `:ok` before
  # the DETS write anyway, but the process crash between reply and disk
  # would then lose the entry. Same policy TokenDenylist adopted for
  # its own #72 revoke path.
  test "record は synchronous で reply 前に fsync 済み (M7-a)", %{server: server, path: path} do
    :ok =
      ClearWatermarks.record("a.sync", order(9_000_000, 3), "2026-07-23T16:00:00Z", server)

    # GenServer.stop で永続 flush を促さずとも、reply 時点で DETS 上に
    # 反映済み — 別 open で直接 lookup できる。
    :ok = GenServer.stop(server)

    verify_name = :"cw_sync_verify_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: verify_name, path: path)

    assert ClearWatermarks.get("a.sync", verify_name) ==
             {order(9_000_000, 3), "2026-07-23T16:00:00Z", nil}

    GenServer.stop(verify_name)
  end

  # ふじ R2 must-fix (2026-07-23) — 前回の "レガシー 2-tuple record を
  # {{0,0}, iso} に昇格" 方針は、新 IA (order tuple の us が非零) が
  # `{0, 0}` を必ず上回るせいで legacy watermark が inert になり、redeploy
  # で旧 clear 済み IA が全件再露出する regression を起こしていた。
  # 修正: legacy record は :iso_only モードで保持し、all_filter_bounds が
  # `{:iso, iso}` を返して agents_channel 側で wire ts と比較する。
  test "legacy 2-tuple record は :iso_only モードで保持される (R2)",
       %{server: server, path: path} do
    :ok = GenServer.stop(server)

    inject = :"cw_legacy_inject_#{System.unique_integer([:positive])}"
    {:ok, ^inject} = :dets.open_file(inject, file: String.to_charlist(path))
    :ok = :dets.insert(inject, {"a.legacy", "2026-07-01T00:00:00Z"})
    :ok = :dets.close(inject)

    boot = :"cw_legacy_boot_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: boot, path: path)

    # 内部 shape は :iso_only。
    assert ClearWatermarks.get("a.legacy", boot) ==
             {:iso_only, "2026-07-01T00:00:00Z"}

    # display は取れる (audit / broadcast helper 用途)。
    assert ClearWatermarks.get_display("a.legacy", boot) == "2026-07-01T00:00:00Z"

    # 比較可能な tuple は無いので get_order / all_orders は nil / omit。
    assert ClearWatermarks.get_order("a.legacy", boot) == nil
    assert ClearWatermarks.all_orders(boot) == %{}

    # filter path 用の all_filter_bounds は tagged で返る。
    assert ClearWatermarks.all_filter_bounds(boot) == %{
             "a.legacy" => {:iso, "2026-07-01T00:00:00Z"}
           }

    GenServer.stop(boot)
  end

  # 次回 record/4 で legacy 記録は tuple domain に promote される
  # (R2: legacy は比較可能 order が無いので、monotonic-advance の
  # 制約なく無条件で置換される)。
  test "record/4 は :iso_only 記録を tuple 記録へ promote する (R2)",
       %{server: server, path: path} do
    :ok = GenServer.stop(server)

    inject = :"cw_promote_inject_#{System.unique_integer([:positive])}"
    {:ok, ^inject} = :dets.open_file(inject, file: String.to_charlist(path))
    :ok = :dets.insert(inject, {"a.promote", "2026-07-01T00:00:00Z"})
    :ok = :dets.close(inject)

    boot = :"cw_promote_boot_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: boot, path: path)

    :ok =
      ClearWatermarks.record(
        "a.promote",
        order(7_000_000, 3),
        "2026-07-23T17:00:00Z",
        boot
      )

    assert ClearWatermarks.get("a.promote", boot) ==
             {order(7_000_000, 3), "2026-07-23T17:00:00Z", nil}

    assert ClearWatermarks.all_filter_bounds(boot) == %{
             "a.promote" => {:order, order(7_000_000, 3)}
           }

    GenServer.stop(boot)
  end

  test "legacy 5/4/3-tuple records は watermark として load される",
       %{server: server, path: path} do
    :ok = GenServer.stop(server)

    inject = :"cw_legacy_shapes_inject_#{System.unique_integer([:positive])}"
    {:ok, ^inject} = :dets.open_file(inject, file: String.to_charlist(path))

    :ok =
      :dets.insert(inject, {"a.legacy5", {8_000_000, 5}, "2026-07-20T12:00:00Z", nil, "sess-old"})

    :ok = :dets.insert(inject, {"a.legacy4", {8_000_001, 5}, "2026-07-20T12:01:00Z", "sess-new"})
    :ok = :dets.insert(inject, {"a.legacy3", {8_000_002, 5}, "2026-07-20T12:02:00Z"})
    :ok = :dets.close(inject)

    boot = :"cw_legacy_shapes_boot_#{System.unique_integer([:positive])}"
    {:ok, _pid} = ClearWatermarks.start_link(name: boot, path: path)

    assert ClearWatermarks.get("a.legacy5", boot) ==
             {{8_000_000, 5}, "2026-07-20T12:00:00Z", nil}

    assert ClearWatermarks.get("a.legacy4", boot) ==
             {{8_000_001, 5}, "2026-07-20T12:01:00Z", "sess-new"}

    assert ClearWatermarks.get("a.legacy3", boot) ==
             {{8_000_002, 5}, "2026-07-20T12:02:00Z", nil}

    GenServer.stop(boot)
  end
end
