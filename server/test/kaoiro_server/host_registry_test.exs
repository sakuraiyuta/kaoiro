defmodule KaoiroServer.HostRegistryTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.HostRegistry

  defp attrs(extra \\ %{}) do
    Map.merge(%{personas: [%{"id" => "mio"}], cwd_allowlist: ["/home/user/proj"]}, extra)
  end

  describe "register/4" do
    test "ホストを登録し owner と申告内容を保持する" do
      store = start_supervised!({HostRegistry, name: :host_reg_register_test})

      assert :ok =
               HostRegistry.register(
                 "lab-pc-1",
                 attrs(%{capabilities: ["resume"]}),
                 self(),
                 store
               )

      entry = HostRegistry.get("lab-pc-1", store)
      assert entry.personas == [%{"id" => "mio"}]
      assert entry.cwd_allowlist == ["/home/user/proj"]
      assert entry.capabilities == ["resume"]
      assert entry.runner_pid == self()
      assert is_binary(entry.registered_at)
      assert entry.last_heartbeat == entry.registered_at
    end

    test "再登録は上書きし owner を取り直す" do
      store = start_supervised!({HostRegistry, name: :host_reg_reregister_test})

      :ok = HostRegistry.register("h", attrs(), self(), store)
      new_owner = spawn(fn -> :ok end)
      :ok = HostRegistry.register("h", attrs(%{personas: [%{"id" => "ao"}]}), new_owner, store)

      entry = HostRegistry.get("h", store)
      assert entry.personas == [%{"id" => "ao"}]
      assert entry.runner_pid == new_owner
    end

    test "新規 host_id が上限を超えると拒否し、既知 host の更新は通す" do
      store = start_supervised!({HostRegistry, name: :host_reg_cap_test})

      for n <- 1..1000 do
        assert :ok = HostRegistry.register("host-#{n}", attrs(), self(), store)
      end

      assert {:error, :too_many_hosts} =
               HostRegistry.register("host-1001", attrs(), self(), store)

      # Re-registration of a known host still succeeds at the cap.
      assert :ok = HostRegistry.register("host-1", attrs(), self(), store)
      assert map_size(HostRegistry.snapshot(store)) == 1000
    end
  end

  describe "heartbeat/2" do
    test "既知ホストの last_heartbeat を更新する" do
      store = start_supervised!({HostRegistry, name: :host_reg_hb_test})
      :ok = HostRegistry.register("h", attrs(), self(), store)
      before = HostRegistry.get("h", store).last_heartbeat

      # Force a later timestamp; ISO8601 has sub-second resolution here.
      Process.sleep(10)
      assert :ok = HostRegistry.heartbeat("h", store)

      assert HostRegistry.get("h", store).last_heartbeat >= before
    end

    test "未知ホストは noop" do
      store = start_supervised!({HostRegistry, name: :host_reg_hb_noop_test})
      assert :noop = HostRegistry.heartbeat("ghost", store)
    end
  end

  describe "get/2 と snapshot/1" do
    test "get は未知ホストで nil" do
      store = start_supervised!({HostRegistry, name: :host_reg_get_test})
      assert HostRegistry.get("none", store) == nil
    end

    test "snapshot は全ホストの host_id => entry を返す" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_test})
      :ok = HostRegistry.register("a", attrs(), self(), store)
      :ok = HostRegistry.register("b", attrs(), self(), store)

      snapshot = HostRegistry.snapshot(store)
      assert Map.keys(snapshot) |> Enum.sort() == ["a", "b"]
      # snapshot is the operator-facing view: the internal runner_pid is
      # stripped so it stays JSON-serialisable for the "hosts" push.
      refute Map.has_key?(snapshot["a"], :runner_pid)
      # The owner pid is still retained internally (get/2) for drop/3 fencing.
      assert HostRegistry.get("a", store).runner_pid == self()
    end

    test "snapshot は default ペルソナを各 host の先頭に注入する (#35)" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_default_test})
      :ok = HostRegistry.register("a", attrs(), self(), store)
      :ok = HostRegistry.register("b", attrs(%{personas: []}), self(), store)

      snapshot = HostRegistry.snapshot(store)

      default = %{"id" => "default", "name" => "デフォルト", "sprite_set" => "default"}
      assert [^default | _] = snapshot["a"].personas
      assert snapshot["a"].personas == [default, %{"id" => "mio"}]
      # default は personas が空の host にも入る (常に選択肢に出す)
      assert snapshot["b"].personas == [default]
      # 注入は snapshot view のみ; store の raw データは触らない
      assert HostRegistry.get("a", store).personas == [%{"id" => "mio"}]
    end

    test "host が宣言した id=default は server 側標準で置換される (#35)" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_default_dedup_test})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{
            personas: [
              %{"id" => "default", "name" => "勝手な名前", "sprite_set" => "x"},
              %{"id" => "mio"}
            ]
          }),
          self(),
          store
        )

      snapshot = HostRegistry.snapshot(store)
      default = %{"id" => "default", "name" => "デフォルト", "sprite_set" => "default"}
      # runner 宣言の default は除外され、標準 default が先頭に置かれる
      assert snapshot["a"].personas == [default, %{"id" => "mio"}]
    end
  end

  describe "personas/1" do
    test "全ホストの persona を集約し重複を排除する" do
      store = start_supervised!({HostRegistry, name: :host_reg_personas_test})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{personas: [%{"id" => "mio"}, %{"id" => "ao"}]}),
          self(),
          store
        )

      :ok =
        HostRegistry.register(
          "b",
          # mio appears on both hosts; dedup keeps a single entry.
          attrs(%{personas: [%{"id" => "mio"}, %{"id" => "yui"}]}),
          self(),
          store
        )

      personas = HostRegistry.personas(store)
      assert length(personas) == 3
      assert %{"id" => "mio"} in personas
      assert %{"id" => "ao"} in personas
      assert %{"id" => "yui"} in personas
    end

    test "ホストが無ければ空リスト" do
      store = start_supervised!({HostRegistry, name: :host_reg_personas_empty_test})
      assert HostRegistry.personas(store) == []
    end
  end

  describe "drop/3 owner フェンシング" do
    test "owner が一致すれば削除する" do
      store = start_supervised!({HostRegistry, name: :host_reg_drop_test})
      :ok = HostRegistry.register("h", attrs(), self(), store)

      assert :ok = HostRegistry.drop("h", self(), store)
      assert HostRegistry.get("h", store) == nil
    end

    test "owner 不一致 (再接続後の stale terminate) は noop" do
      store = start_supervised!({HostRegistry, name: :host_reg_drop_stale_test})
      :ok = HostRegistry.register("h", attrs(), self(), store)
      stale_owner = spawn(fn -> :ok end)

      assert :noop = HostRegistry.drop("h", stale_owner, store)
      # The newer owner's entry survives.
      assert HostRegistry.get("h", store).runner_pid == self()
    end

    test "未知ホストは noop" do
      store = start_supervised!({HostRegistry, name: :host_reg_drop_unknown_test})
      assert :noop = HostRegistry.drop("none", self(), store)
    end
  end
end
