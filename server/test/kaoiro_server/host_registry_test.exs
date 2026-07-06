defmodule KaoiroServer.HostRegistryTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.HostRegistry

  # Fixture pool used by tests. Order mimics PersonaAssets.all_personas/0:
  # reserved default first, then id-sorted packs.
  @default_persona %{"id" => "default", "name" => "デフォルト", "sprite_set" => "default"}
  @ao %{"id" => "ao", "name" => "あお", "sprite_set" => "ao"}
  @mio %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"}
  @yui %{"id" => "yui", "name" => "ゆい", "sprite_set" => "yui"}
  @pool [@default_persona, @ao, @mio, @yui]

  defp attrs(extra \\ %{}) do
    Map.merge(%{policy: :accept_all, cwd_allowlist: ["/home/user/proj"]}, extra)
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
      assert entry.policy == :accept_all
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

      :ok =
        HostRegistry.register(
          "h",
          attrs(%{policy: {:allowlist, MapSet.new(["ao"])}}),
          new_owner,
          store
        )

      entry = HostRegistry.get("h", store)
      assert entry.policy == {:allowlist, MapSet.new(["ao"])}
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
      assert map_size(HostRegistry.snapshot(@pool, store)) == 1000
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

  describe "get/2 と snapshot/2 (ADR-0031 policy 適用)" do
    test "get は未知ホストで nil" do
      store = start_supervised!({HostRegistry, name: :host_reg_get_test})
      assert HostRegistry.get("none", store) == nil
    end

    test "snapshot は全ホストの host_id => entry を返し runner_pid を落とす" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_test})
      :ok = HostRegistry.register("a", attrs(), self(), store)
      :ok = HostRegistry.register("b", attrs(), self(), store)

      snapshot = HostRegistry.snapshot(@pool, store)
      assert Map.keys(snapshot) |> Enum.sort() == ["a", "b"]
      refute Map.has_key?(snapshot["a"], :runner_pid)
      # The owner pid is still retained internally (get/2) for drop/3 fencing.
      assert HostRegistry.get("a", store).runner_pid == self()
    end

    test "snapshot は :policy を含めず Jason で serialise 可能である" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_json})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{policy: {:allowlist, MapSet.new(["ao"])}}),
          self(),
          store
        )

      snapshot = HostRegistry.snapshot(@pool, store)
      refute Map.has_key?(snapshot["a"], :policy)
      # `hosts` channel push encodes with Jason; a leaked tuple would raise
      # Protocol.UndefinedError here (kills the operator socket at after_join).
      assert {:ok, _} = Jason.encode(%{"hosts" => snapshot})
    end

    test "accept-all は pool 全体を返す (default 含む)" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_accept_all})
      :ok = HostRegistry.register("a", attrs(), self(), store)

      snapshot = HostRegistry.snapshot(@pool, store)
      assert snapshot["a"].personas == @pool
    end

    test "allowlist は列挙 id のみに絞り込む (default も対象)" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_allow})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{policy: {:allowlist, MapSet.new(["ao", "default"])}}),
          self(),
          store
        )

      snapshot = HostRegistry.snapshot(@pool, store)
      # 順序は pool 順を保つ (default → ao)
      assert snapshot["a"].personas == [@default_persona, @ao]
    end

    test "blocklist は列挙 id を除いた pool を返す (default も除外可)" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_block})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{policy: {:blocklist, MapSet.new(["default", "yui"])}}),
          self(),
          store
        )

      snapshot = HostRegistry.snapshot(@pool, store)
      assert snapshot["a"].personas == [@ao, @mio]
    end

    test "allowlist で全て除外される場合は spawnable 空 (canary 合法状態)" do
      store = start_supervised!({HostRegistry, name: :host_reg_snap_empty})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{policy: {:allowlist, MapSet.new(["nonexistent"])}}),
          self(),
          store
        )

      snapshot = HostRegistry.snapshot(@pool, store)
      assert snapshot["a"].personas == []
    end
  end

  describe "get_public/3" do
    test "get_public は policy を適用した personas を返し runner_pid を落とす" do
      store = start_supervised!({HostRegistry, name: :host_reg_get_public_test})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{policy: {:blocklist, MapSet.new(["default"])}}),
          self(),
          store
        )

      entry = HostRegistry.get_public("a", @pool, store)
      assert entry.personas == [@ao, @mio, @yui]
      refute Map.has_key?(entry, :runner_pid)
      # snapshot と整合する: 同じ host を単一スライスとして取り出した形
      assert entry == HostRegistry.snapshot(@pool, store)["a"]
    end

    test "未知 host は nil を返す" do
      store = start_supervised!({HostRegistry, name: :host_reg_get_public_unknown_test})
      assert HostRegistry.get_public("none", @pool, store) == nil
    end
  end

  describe "personas/2 (集約)" do
    test "全ホストの spawnable を集約し重複を排除する" do
      store = start_supervised!({HostRegistry, name: :host_reg_personas_test})

      :ok =
        HostRegistry.register(
          "a",
          attrs(%{policy: {:allowlist, MapSet.new(["mio", "ao"])}}),
          self(),
          store
        )

      :ok =
        HostRegistry.register(
          "b",
          # mio appears via both hosts; dedup keeps a single entry.
          attrs(%{policy: {:allowlist, MapSet.new(["mio", "yui"])}}),
          self(),
          store
        )

      personas = HostRegistry.personas(@pool, store)
      assert length(personas) == 3
      assert @mio in personas
      assert @ao in personas
      assert @yui in personas
    end

    test "ホストが無ければ空リスト" do
      store = start_supervised!({HostRegistry, name: :host_reg_personas_empty_test})
      assert HostRegistry.personas(@pool, store) == []
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
