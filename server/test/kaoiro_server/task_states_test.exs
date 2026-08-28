defmodule KaoiroServer.TaskStatesTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias KaoiroServer.TaskStates
  alias KaoiroServer.TransportLimits

  @max_task_snapshot_bytes TaskStates.snapshot_byte_budget()

  setup do
    name = String.to_atom("task_states_#{System.unique_integer([:positive])}")
    %{store: start_supervised!({TaskStates, name: name})}
  end

  defp task_envelope(task_id, kind, agent_id \\ "agent-a", extra \\ %{}) do
    status =
      case kind do
        "completed" -> "completed"
        _ -> "running"
      end

    %{
      "version" => "0",
      "agent_id" => agent_id,
      "persona" => %{"id" => "p", "name" => "P", "sprite_set" => "p"},
      "ts" => "2026-08-09T00:00:00Z",
      "type" => "task",
      "state" => "idle",
      "payload" =>
        Map.merge(
          %{
            "kind" => kind,
            "agent_id" => agent_id,
            "task_id" => task_id,
            "task_type" => "local_agent",
            "status" => status
          },
          extra
        ),
      "ext" => %{}
    }
  end

  # Pads `extra["summary"]` with ASCII filler so the envelope's exact
  # JSON-encoded byte size hits `target_bytes` (ASCII chars need no JSON
  # escaping, so 1 char == 1 byte, making the target deterministic).
  defp padded_task_envelope(task_id, kind, agent_id, target_bytes) do
    base = task_envelope(task_id, kind, agent_id, %{"summary" => ""})
    base_size = base |> Jason.encode!() |> byte_size()
    pad_len = max(target_bytes - base_size, 0)
    task_envelope(task_id, kind, agent_id, %{"summary" => String.duplicate("x", pad_len)})
  end

  # M1 round-3 fix (2026-08-09, ふじ round 3): like `padded_task_envelope`,
  # but targets the entry's real WIRE contribution
  # (`TaskStates.entry_wire_size/2` = leaf + task_id's own outer-key
  # overhead), not just the leaf. Subtracts the key overhead
  # (`byte_size(Jason.encode!(task_id)) + 2` for the colon + comma)
  # before delegating, so the padded leaf plus that overhead lands
  # exactly on `target_wire_bytes`.
  defp padded_task_envelope_for_wire_size(task_id, kind, agent_id, target_wire_bytes) do
    key_overhead = byte_size(Jason.encode!(task_id)) + 2
    leaf_target = max(target_wire_bytes - key_overhead, 0)
    padded_task_envelope(task_id, kind, agent_id, leaf_target)
  end

  defp entry_wire_size(task_id, envelope),
    do: byte_size(Jason.encode!(task_id)) + 2 + byte_size(Jason.encode!(envelope))

  defp agent_outer_wire_size(agent_id), do: byte_size(Jason.encode!(agent_id)) + 4

  test "started は snapshot に agent_id => %{task_id => envelope} で現れる", %{store: store} do
    assert :ok = TaskStates.put(task_envelope("t1", "started"), server: store)
    assert %{"agent-a" => %{"t1" => envelope}} = TaskStates.snapshot(store)
    assert envelope["payload"]["kind"] == "started"
  end

  test "updated は同じ (agent_id, task_id) を最新 envelope で上書きする", %{store: store} do
    TaskStates.put(task_envelope("t1", "started"), server: store)

    TaskStates.put(
      task_envelope("t1", "updated", "agent-a", %{"summary" => "half way"}),
      server: store
    )

    assert %{"agent-a" => %{"t1" => envelope}} = TaskStates.snapshot(store)
    assert envelope["payload"]["kind"] == "updated"
    assert envelope["payload"]["summary"] == "half way"
  end

  test "completed は snapshot から取り除き、空になった agent の枝も剪定する (ADR-0019 F4 の -1)", %{
    store: store
  } do
    TaskStates.put(task_envelope("t1", "started"), server: store)
    assert %{"agent-a" => %{"t1" => _}} = TaskStates.snapshot(store)

    TaskStates.put(task_envelope("t1", "completed"), server: store)
    assert TaskStates.snapshot(store) == %{}
  end

  test "複数 task_id が独立に管理される (同時実行数 = 全 agent 合算の entry 数)", %{store: store} do
    TaskStates.put(task_envelope("t1", "started"), server: store)
    TaskStates.put(task_envelope("t2", "started"), server: store)
    assert %{"agent-a" => tasks} = TaskStates.snapshot(store)
    assert map_size(tasks) == 2

    TaskStates.put(task_envelope("t1", "completed"), server: store)
    assert %{"agent-a" => %{"t2" => _}} = TaskStates.snapshot(store)
    assert map_size(TaskStates.snapshot(store)["agent-a"]) == 1
  end

  # M1 fix-round (2026-08-09, ふじ round1 must-fix): ADR-0047 F2 の
  # task_id 一意性は「親セッション内」のみの保証。task_id 単独キーだと
  # 別 agent の valid な task が衝突・相殺していた — 複合キー化で
  # このクラスの穴を閉じる。
  test "同一 task_id を持つ 2 agent は独立に管理され、片方の completed が他方を消さない (M1 fix-round)", %{
    store: store
  } do
    TaskStates.put(task_envelope("shared-id", "started", "agent-a"), server: store)
    TaskStates.put(task_envelope("shared-id", "started", "agent-b"), server: store)

    assert %{
             "agent-a" => %{"shared-id" => _},
             "agent-b" => %{"shared-id" => _}
           } = TaskStates.snapshot(store)

    TaskStates.put(task_envelope("shared-id", "completed", "agent-a"), server: store)

    snapshot = TaskStates.snapshot(store)
    refute Map.has_key?(snapshot, "agent-a")
    assert %{"agent-b" => %{"shared-id" => envelope}} = snapshot
    assert envelope["payload"]["kind"] == "started"
  end

  test "discard_for_agent は該当 agent_id の task だけを破棄する (ADR-0048 F1)", %{
    store: store
  } do
    TaskStates.put(task_envelope("t1", "started", "agent-a"), server: store)
    TaskStates.put(task_envelope("t2", "started", "agent-b"), server: store)

    assert :ok = TaskStates.discard_for_agent("agent-a", server: store)

    snapshot = TaskStates.snapshot(store)
    refute Map.has_key?(snapshot, "agent-a")
    assert %{"agent-b" => %{"t2" => _}} = snapshot
  end

  test "discard_for_agent は未知 agent_id では no-op (:ok を返す)", %{store: store} do
    TaskStates.put(task_envelope("t1", "started", "agent-a"), server: store)
    assert :ok = TaskStates.discard_for_agent("agent-never-seen", server: store)
    assert %{"agent-a" => %{"t1" => _}} = TaskStates.snapshot(store)
  end

  test "task_id 欠落・agent_id 欠落・kind 欠落は crash せず drop する (fail-visible)", %{
    store: store
  } do
    malformed = [
      %{"type" => "task", "payload" => %{"kind" => "started", "agent_id" => "a"}},
      %{"type" => "task", "payload" => %{"task_id" => "t1", "agent_id" => "a"}},
      %{"type" => "task", "payload" => %{"task_id" => "t1", "kind" => "started"}},
      %{"type" => "task", "payload" => %{}},
      %{"type" => "task"}
    ]

    for envelope <- malformed do
      assert :ok = TaskStates.put(envelope, server: store)
    end

    assert TaskStates.snapshot(store) == %{}
  end

  test "未知の kind は upsert も削除もせず drop する", %{store: store} do
    TaskStates.put(task_envelope("t1", "started"), server: store)

    assert :ok =
             TaskStates.put(task_envelope("t1", "bogus_kind"), server: store)

    assert %{"agent-a" => %{"t1" => envelope}} = TaskStates.snapshot(store)
    # まだ started の envelope のまま — bogus_kind に上書きされていない。
    assert envelope["payload"]["kind"] == "started"
  end

  test "task 以外の type は無視され drop する (このモジュールに来る想定はないが防御的に確認)", %{
    store: store
  } do
    assert :ok = TaskStates.put(%{"type" => "state_change", "payload" => %{}}, server: store)
    assert TaskStates.snapshot(store) == %{}
  end

  # S2 fix-round (2026-08-09, ふじ round1 should-fix): 上限に達したら
  # 新規 (agent_id, task_id) は reject。既存 pair の update は budget 内
  # であれば成功する (「常に成功」は M1 fix-round — 下記 — で撤回された。
  # ここで使う envelope は小さく、5000 件でも @max_task_snapshot_bytes
  # には遠く届かないため cardinality cap だけが効く)。
  describe "cap (S2 fix-round)" do
    test "上限到達後、新規 (agent_id, task_id) は {:error, :too_many_tasks}", %{store: store} do
      for n <- 1..5000 do
        assert :ok = TaskStates.put(task_envelope("t#{n}", "started", "agent-a"), server: store)
      end

      assert {:error, :too_many_tasks} =
               TaskStates.put(task_envelope("t5001", "started", "agent-a"), server: store)

      assert map_size(TaskStates.snapshot(store)["agent-a"]) == 5000
    end

    test "上限到達後も、budget 内であれば既存 (agent_id, task_id) の update は成功する", %{
      store: store
    } do
      for n <- 1..5000 do
        TaskStates.put(task_envelope("t#{n}", "started", "agent-a"), server: store)
      end

      assert :ok =
               TaskStates.put(
                 task_envelope("t1", "updated", "agent-a", %{"summary" => "still going"}),
                 server: store
               )

      assert TaskStates.snapshot(store)["agent-a"]["t1"]["payload"]["summary"] ==
               "still going"
    end

    test "上限到達後、completed で 1 件減れば次の新規は通る", %{store: store} do
      for n <- 1..5000 do
        TaskStates.put(task_envelope("t#{n}", "started", "agent-a"), server: store)
      end

      TaskStates.put(task_envelope("t1", "completed", "agent-a"), server: store)

      assert :ok =
               TaskStates.put(task_envelope("t5001", "started", "agent-a"), server: store)
    end
  end

  # M1 fix-round (2026-08-09, ふじ round 2): @max_tasks alone bounds
  # entry COUNT, not the join snapshot's actual JSON-encoded wire size —
  # ふじの実測 (62 件の ingress-cap 内 envelope が JSON で 8,072,535
  # bytes、Endpoint の max_frame_size 8_000_000 を突破) を再現するミニ
  # チュア規模で固定する。
  describe "snapshot byte budget (M1 fix-round)" do
    test "新規 task が budget を超えるなら {:error, :task_snapshot_too_large} で reject", %{
      store: store
    } do
      small = task_envelope("small1", "started", "agent-a")
      small_wire_size = entry_wire_size("small1", small)

      # Fill to within (small_size - 1) bytes of the ceiling, so `small`
      # alone pushes the total 1 byte past budget — deterministic
      # regardless of the exact baseline envelope size.
      big =
        padded_task_envelope_for_wire_size(
          "big1",
          "started",
          "agent-a",
          @max_task_snapshot_bytes - agent_outer_wire_size("agent-a") - small_wire_size + 1
        )

      assert :ok = TaskStates.put(big, server: store)
      assert {:error, :task_snapshot_too_large} = TaskStates.put(small, server: store)

      # The rejected transition must not have been applied.
      refute Map.has_key?(TaskStates.snapshot(store)["agent-a"], "small1")
    end

    test "既存 task の update が budget を超えるなら reject (update-常に成功 は撤回)", %{
      store: store
    } do
      assert :ok = TaskStates.put(task_envelope("t1", "started", "agent-a"), server: store)

      oversized_update =
        padded_task_envelope_for_wire_size("t1", "updated", "agent-a", @max_task_snapshot_bytes)

      assert {:error, :task_snapshot_too_large} =
               TaskStates.put(oversized_update, server: store)

      # The rejected update must not have replaced the original envelope.
      assert TaskStates.snapshot(store)["agent-a"]["t1"]["payload"]["kind"] == "started"
    end

    # M1 round-3 must-fix (2026-08-09, ふじ round 3): round-2 の accounting
    # は leaf JSON の和しか数えておらず、snapshot wire 上で task_id が
    # OUTER KEY としても現れる分(entry_wire_size)を見落としていた —
    # ふじ実測: task_id 長に上限が無かった頃、ingress cap 内の valid
    # envelope 96 件で実 snapshot 11.9MB(6MB budget を通過していたのに
    # 8MB frame を超過)。ここは WrapperChannel の ingress 上限
    # (@max_task_id_field_bytes = 256)に近い長さの task_id を使い、
    # その outer key 分が budget 判定へ正しく反映されることを固定する。
    test "長い task_id の外側キー分の wire 寄与も budget へ正しく計上される (M1 round-3 fix)",
         %{store: store} do
      long_task_id = String.duplicate("t", 256)

      small = task_envelope("s", "started", "agent-a")

      small_wire_size = entry_wire_size("s", small)

      # Fill so exactly (small_wire_size - 1) bytes of margin remain, AS
      # MEASURED BY entry_wire_size (leaf + long_task_id's own key
      # overhead) — if accounting only counted the leaf (pre-round-3),
      # this same padding would leave MORE apparent headroom than
      # actually exists on the wire, and `small` would wrongly be
      # accepted.
      big =
        padded_task_envelope_for_wire_size(
          long_task_id,
          "started",
          "agent-a",
          @max_task_snapshot_bytes - agent_outer_wire_size("agent-a") - small_wire_size + 1
        )

      assert :ok = TaskStates.put(big, server: store)
      assert {:error, :task_snapshot_too_large} = TaskStates.put(small, server: store)
    end

    test "agent_id の outer key は初回 task 時だけ budget へ正しく計上される", %{store: store} do
      first_agent = "agent-a"
      second_agent = String.duplicate("b", 256)
      second = task_envelope("second", "started", second_agent)

      first =
        padded_task_envelope_for_wire_size(
          "first",
          "started",
          first_agent,
          @max_task_snapshot_bytes - agent_outer_wire_size(first_agent) -
            agent_outer_wire_size(second_agent) - entry_wire_size("second", second) + 1
        )

      assert :ok = TaskStates.put(first, server: store)
      assert {:error, :task_snapshot_too_large} = TaskStates.put(second, server: store)
    end

    test "discard_for_agent は agent_id の outer key も refund する", %{store: store} do
      first_agent = "agent-a"
      second_agent = String.duplicate("b", 256)

      second =
        padded_task_envelope_for_wire_size(
          "second",
          "started",
          second_agent,
          @max_task_snapshot_bytes - agent_outer_wire_size(second_agent) -
            agent_outer_wire_size(first_agent) + 1
        )

      assert :ok = TaskStates.put(task_envelope("first", "started", first_agent), server: store)
      assert :ok = TaskStates.discard_for_agent(first_agent, server: store)
      assert :ok = TaskStates.put(second, server: store)
    end

    # S1 fix-round (2026-08-09, ふじ round 3): reject の Logger.warning が
    # task_id/agent_id を無制限に展開していた(ふじ実測: 62KB/行)。
    # `log_preview/1` (inspect + printable_limit) で bounded preview に
    # 落ちていることを、実際に capture_log で固定する。
    test "byte budget reject の log は task_id を bounded preview で出す (S1 round-3 fix)",
         %{store: store} do
      long_task_id = String.duplicate("z", 256)
      long_entry = task_envelope(long_task_id, "started", "agent-a")

      long_entry_wire_size =
        byte_size(Jason.encode!(long_task_id)) + 1 +
          (long_entry |> Jason.encode!() |> byte_size()) + 1

      big =
        padded_task_envelope_for_wire_size(
          "big1",
          "started",
          "agent-a",
          @max_task_snapshot_bytes - agent_outer_wire_size("agent-a") - long_entry_wire_size + 1
        )

      assert :ok = TaskStates.put(big, server: store)

      log =
        capture_log(fn ->
          assert {:error, :task_snapshot_too_large} = TaskStates.put(long_entry, server: store)
        end)

      assert log =~ "snapshot byte budget"
      refute log =~ long_task_id
      # A bounded preview, not merely "missing the raw string" — the log
      # line itself must stay short (well under the pre-fix 62KB ふじ
      # measured for an unbounded interpolation).
      assert byte_size(log) < 1000
    end

    test "completed で bytes が減れば、その分の budget は次の新規に開放される", %{store: store} do
      small = task_envelope("small1", "started", "agent-a")
      small_wire_size = entry_wire_size("small1", small)

      big =
        padded_task_envelope_for_wire_size(
          "big1",
          "started",
          "agent-a",
          @max_task_snapshot_bytes - agent_outer_wire_size("agent-a") - small_wire_size + 1
        )

      assert :ok = TaskStates.put(big, server: store)
      assert {:error, :task_snapshot_too_large} = TaskStates.put(small, server: store)

      assert :ok = TaskStates.put(task_envelope("big1", "completed", "agent-a"), server: store)
      assert :ok = TaskStates.put(small, server: store)
      assert small_wire_size <= @max_task_snapshot_bytes
    end

    # ふじ round 2 の受け入れ条件3点目(round 3 で長い task_id へ差し替え
    # — ふじ round3 の指定どおり): cap 直前の snapshot が実際の JSON
    # エンコードで 8MB 未満に収まること(同居分の余白込み)。round-3 の
    # `entry_wire_size/2` により tracked `bytes` は task_id の outer key
    # 分も含むようになったが、それでも「本当に実測と一致するか」は
    # 実際に Jason.encode! した snapshot で固定するのが筋 — ここでは
    # WrapperChannel の ingress 上限(256 bytes)に近い長さの task_id を
    # 使い、round-2 の短い task_id ("t1" 等)では露呈しなかった
    # outer-key 分の乖離を実際に検出できる形にする。
    test "task_id が長くても、cap 直前 snapshot の実 JSON エンコード bytes は 8MB 未満 (M1 round-3 fix)",
         %{store: store} do
      for n <- 1..40 do
        task_id = "t#{n}-" <> String.duplicate("x", 256 - String.length("t#{n}-"))

        assert :ok =
                 TaskStates.put(
                   padded_task_envelope_for_wire_size(task_id, "started", "agent-a", 149_000),
                   server: store
                 )
      end

      encoded = TaskStates.snapshot(store) |> Jason.encode!() |> byte_size()
      assert encoded < TransportLimits.max_frame_bytes()
      # Explicit margin, not just barely under the hard wire limit.
      assert encoded < 7_000_000
    end
  end
end
