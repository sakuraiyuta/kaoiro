defmodule KaoiroServer.IngressOrderTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.IngressOrder

  # ふじ R5 must-fix (2026-07-23): every test spins up an isolated
  # IngressOrder GenServer bound to a tmp DETS file so pins can drive a
  # deterministic clock via `:clock` opt and observe restart behaviour
  # without touching the production singleton.
  setup do
    name = :"io_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)

    on_exit(fn ->
      # #169 / #171: ExUnit のリンク死と stop が競合して teardown だけが
      # 落ちる。良性の exit だけ吸収する (KaoiroServer.TestTeardown)。
      stop_quietly(name)

      File.rm(path)
    end)

    %{name: name, path: path}
  end

  # Configurable clock helper — atomics-backed monotonic-by-default so
  # the same test can flip to a rollback with `set_now/2`.
  defp make_clock(initial_us) do
    ref = :atomics.new(1, signed: false)
    :atomics.put(ref, 1, initial_us)
    fun = fn -> :atomics.get(ref, 1) end
    {fun, ref}
  end

  defp set_now(ref, us), do: :atomics.put(ref, 1, us)

  test "allocate は毎回 pairwise-strict-monotonic な tuple を返す (通常時)",
       %{name: name, path: path} do
    {clock, ref} = make_clock(1_000_000)
    {:ok, _} = IngressOrder.start_link(name: name, path: path, clock: clock)

    # 初回: us が {0, 0} を上回るので seq=0。
    assert IngressOrder.allocate(name) == {1_000_000, 0}
    # 同 us で allocate → seq が bump。
    assert IngressOrder.allocate(name) == {1_000_000, 1}
    assert IngressOrder.allocate(name) == {1_000_000, 2}

    # us 前進 → seq リセット。
    set_now(ref, 2_000_000)
    assert IngressOrder.allocate(name) == {2_000_000, 0}
    assert IngressOrder.allocate(name) == {2_000_000, 1}
  end

  # クロエ指定の pin その 1: wall-clock rollback。now が last_us を下回
  # っても allocate は last_us を保持しつつ seq を bump するので strict
  # monotonic を維持する。
  test "wall-clock rollback: last_us を保持して seq を bump (R5 pin)",
       %{name: name, path: path} do
    {clock, ref} = make_clock(5_000_000)
    {:ok, _} = IngressOrder.start_link(name: name, path: path, clock: clock)

    assert IngressOrder.allocate(name) == {5_000_000, 0}

    # 時計が過去に戻る (NTP 補正 / VM 移動)。
    set_now(ref, 1_000_000)
    next = IngressOrder.allocate(name)
    assert next == {5_000_000, 1}
    # 次も strict > を維持。
    assert IngressOrder.allocate(name) > next
  end

  # クロエ指定の pin その 2: VM restart 越し。allocate → GenServer.stop
  # → 同 path で再起動 → 次 allocate が pre-restart 最大より > を返す。
  test "VM restart 越しでも strict monotonic を維持 (R5 pin)",
       %{name: name, path: path} do
    {clock, _ref} = make_clock(3_000_000)
    {:ok, _} = IngressOrder.start_link(name: name, path: path, clock: clock)

    # pre-restart で数個 allocate: {3M,0}, {3M,1}, {3M,2}
    _ = IngressOrder.allocate(name)
    _ = IngressOrder.allocate(name)
    last_before = IngressOrder.allocate(name)
    assert last_before == {3_000_000, 2}

    :ok = GenServer.stop(name)

    # 同一 path (persisted `last`) から立ち上げ直し。clock は同じ 3_000_000
    # で advance してないので、seq bump が続く必要がある。
    name2 = :"io_restart_#{System.unique_integer([:positive])}"
    {clock2, _ref2} = make_clock(3_000_000)
    {:ok, _} = IngressOrder.start_link(name: name2, path: path, clock: clock2)

    after_restart = IngressOrder.allocate(name2)
    assert after_restart > last_before
    assert after_restart == {3_000_000, 3}

    GenServer.stop(name2)
  end

  # クロエ指定 pin: seed_from は pairwise tuple max で、旧 unique_integer
  # 由来の大きな uniq (同一 us + large uniq) を食わせると次 allocate は
  # `{same_us, large_uniq + 1}` を返す。single-integer max では pass
  # しない (last_seq を 0 に落として同 tuple を返してしまう) ため、
  # pairwise 比較の正しさを直接 pin する。
  test "init seed は pairwise tuple max: 同 us + large uniq を上回る (R5 pin)",
       %{name: name, path: path} do
    # InterAgentHistory.all_with_order/0 相当の shape を stub。
    same_us = 4_000_000

    seed_source = fn ->
      %{
        "agent-a" => [
          {{same_us, 123}, %{}},
          {{same_us, 999}, %{}},
          {{same_us - 1, 999_999}, %{}}
        ]
      }
    end

    {clock, _} = make_clock(same_us)

    {:ok, _} =
      IngressOrder.start_link(
        name: name,
        path: path,
        clock: clock,
        seed_from: [seed_source]
      )

    # 単純な integer max なら 999_999 を last_seq に取ってしまうが、
    # pairwise では `{same_us - 1, 999_999} < {same_us, 999}` なので
    # last = {same_us, 999} が正解。次 allocate は {same_us, 1000}。
    assert IngressOrder.peek(name) == {same_us, 999}
    assert IngressOrder.allocate(name) == {same_us, 1000}
  end

  test "init seed は ClearWatermarks.all_orders shape (%{id => tuple}) も受ける (R5)",
       %{name: name, path: path} do
    seed_source = fn -> %{"agent-a" => {6_000_000, 5}, "agent-b" => {5_500_000, 42}} end
    {clock, _} = make_clock(6_000_000)

    {:ok, _} =
      IngressOrder.start_link(
        name: name,
        path: path,
        clock: clock,
        seed_from: [seed_source]
      )

    # 最大 = {6_000_000, 5}。
    assert IngressOrder.peek(name) == {6_000_000, 5}
    assert IngressOrder.allocate(name) == {6_000_000, 6}
  end

  test "seed_from に nil / 空 / 型不一致が混じっても crash しない (fail-safe)",
       %{name: name, path: path} do
    {clock, _} = make_clock(1_000_000)

    {:ok, _} =
      IngressOrder.start_link(
        name: name,
        path: path,
        clock: clock,
        seed_from: [
          fn -> nil end,
          fn -> %{} end,
          fn -> %{"garbage" => "not a tuple"} end,
          fn -> [] end
        ]
      )

    # 空 seed → {0, 0} で始まる。next allocate は clock 使用。
    assert IngressOrder.peek(name) == {0, 0}
    assert IngressOrder.allocate(name) == {1_000_000, 0}
  end

  test "persisted last と seed_from の max を pairwise で取る (R5)",
       %{name: name, path: path} do
    # 事前に persisted state を作る。
    {clock, _} = make_clock(1_000_000)
    {:ok, _} = IngressOrder.start_link(name: name, path: path, clock: clock)
    _ = IngressOrder.allocate(name)
    _ = IngressOrder.allocate(name)
    persisted_last = IngressOrder.peek(name)
    :ok = GenServer.stop(name)

    # persisted より大きい seed を用意して restart。
    name2 = :"io_pair_#{System.unique_integer([:positive])}"
    bigger = {persisted_last |> elem(0), elem(persisted_last, 1) + 100}
    seed_source = fn -> %{"agent" => bigger} end
    {clock2, _} = make_clock(elem(bigger, 0))

    {:ok, _} =
      IngressOrder.start_link(
        name: name2,
        path: path,
        clock: clock2,
        seed_from: [seed_source]
      )

    assert IngressOrder.peek(name2) == bigger
    GenServer.stop(name2)
  end

  test "record 前に fsync が済んでいる (crash-safe)",
       %{name: name, path: path} do
    {clock, _} = make_clock(9_000_000)
    {:ok, _} = IngressOrder.start_link(name: name, path: path, clock: clock)

    got = IngressOrder.allocate(name)
    assert got == {9_000_000, 0}

    # GenServer.stop 経由の terminate flush を待たずとも、reply 時点で
    # DETS に反映済み — 別 open で確認できる。
    :ok = GenServer.stop(name)

    name2 = :"io_fsync_#{System.unique_integer([:positive])}"
    {clock2, _} = make_clock(9_000_000)
    {:ok, _} = IngressOrder.start_link(name: name2, path: path, clock: clock2)

    # restart 後 peek は persisted last と一致する必要がある。
    assert IngressOrder.peek(name2) == got
    GenServer.stop(name2)
  end
end
