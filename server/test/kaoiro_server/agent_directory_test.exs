defmodule KaoiroServer.AgentDirectoryTest do
  use ExUnit.Case, async: true

  import KaoiroServer.TestTeardown

  alias KaoiroServer.AgentDirectory

  # Mirrors `AgentDirectory`'s private `@max_safe_revision` (issue #197
  # 段階3, ふじ MF-5 レビュー指摘) — the module attribute is not
  # accessible from the test, so the boundary is duplicated here
  # deliberately, matching the pattern of testing a private contract via
  # its public behavior.
  @max_safe_revision 9_007_199_254_740_991

  # Mirrors `AgentDirectory`'s private `@initial_revision` (issue #219
  # MF-2, クロエ実測検証) — same duplication rationale as
  # `@max_safe_revision` above. A fresh `record/4` entry, and any
  # persisted revision loaded below this floor (including a legitimate
  # pre-MF-2 `0`), starts/lands at this value, not 0.
  @initial_revision 1

  setup do
    # Isolated DETS file + table name per test so cases don't share state.
    name = :"ad_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{name}.dets"])
    File.rm(path)
    {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

    on_exit(fn ->
      # #169 / #171: ExUnit のリンク死と stop が競合して teardown だけが
      # 落ちる。良性の exit だけ吸収する (KaoiroServer.TestTeardown)。
      stop_quietly(pid)

      File.rm(path)
    end)

    %{server: name, path: path}
  end

  # issue #219 D19: `persona` in a legacy-DETS fixture (a full map, the
  # pre-#219 shape) vs `persona_id` (the string reference the new record/
  # rename API takes). Both helpers build the SAME underlying pack id.
  defp persona(id, name \\ nil) do
    %{"id" => id, "name" => name || id, "sprite_set" => id}
  end

  # Waits for a "directory" broadcast that mentions `agent_id` and
  # returns its revision, skipping unrelated broadcasts (async: true —
  # other concurrently-running test files' "agents:lobby" broadcasts can
  # land in this same mailbox since the topic is process-global).
  defp receive_directory_revision(agent_id) do
    receive do
      %Phoenix.Socket.Broadcast{
        topic: "agents:lobby",
        event: "directory",
        payload: %{"entries" => entries}
      } ->
        case Map.get(entries, agent_id) do
          nil -> receive_directory_revision(agent_id)
          %{revision: revision} -> revision
        end
    after
      1000 -> flunk("timeout waiting for \"directory\" broadcast for #{agent_id}")
    end
  end

  test "record してから get すると persona_id/display_name が返る (last_seen は nil、revision は @initial_revision)",
       %{server: server} do
    AgentDirectory.record("a.1", "ao", "ao", server)

    assert AgentDirectory.get("a.1", server) == %{
             persona_id: "ao",
             display_name: "ao",
             last_seen: nil,
             revision: @initial_revision
           }
  end

  test "未知 agent は nil", %{server: server} do
    assert AgentDirectory.get("a.none", server) == nil
  end

  # record/4 は create-only (issue #197 段階3、ふじ MF-2 レビュー指摘、
  # issue #219 で persona_id/display_name 引数へ改訂): 既存 agent_id へ
  # の再 record は persona_id/display_name/revision とも一切変更しない
  # (異なる値が来ても無視)。以前は「異なる persona が来ても無視」だった
  # が、これは rename/3 との revision 競合を招き (遅延 record が rename
  # を高い revision で巻き戻し得た)、逆効果だった。
  test "再 record は既存 entry を一切変更しない (create-only、issue #197 段階3 MF-2)", %{
    server: server
  } do
    AgentDirectory.record("a.2", "ao", "青", server)
    AgentDirectory.record("a.2", "ao", "青(改)", server)

    assert %{display_name: "青", revision: @initial_revision} = AgentDirectory.get("a.2", server)
  end

  # MF-2 が防ぐ具体的なシナリオ: rename 後に届いた「遅延 record」が
  # rename の結果を巻き戻さないこと。
  test "rename 後に届いた遅延 record は rename の display_name/revision を巻き戻さない (MF-2)",
       %{server: server} do
    AgentDirectory.record("a.2b", "ao", "青", server)
    assert {:ok, %{revision: 2}} = AgentDirectory.rename("a.2b", "青(改名)", server)

    # spawn 直後の重複/遅延 cast が、rename 適用後に届く想定。
    AgentDirectory.record("a.2b", "ao", "青", server)

    assert %{display_name: "青(改名)", revision: 2} = AgentDirectory.get("a.2b", server)
  end

  test "touch で last_seen が更新される", %{server: server} do
    AgentDirectory.record("a.3", "ao", "ao", server)
    assert %{last_seen: nil} = AgentDirectory.get("a.3", server)

    AgentDirectory.touch("a.3", server)
    # cast の完了を確認するため call を挟む
    _ = AgentDirectory.all(server)
    entry = AgentDirectory.get("a.3", server)
    assert is_integer(entry.last_seen)
  end

  test "touch は persona_id 未 record の agent を作らない", %{server: server} do
    AgentDirectory.touch("a.ghost", server)
    _ = AgentDirectory.all(server)
    assert AgentDirectory.get("a.ghost", server) == nil
  end

  test "同一 DETS ファイルからの再起動で persona_id/display_name が残る (last_seen は nil に戻る)",
       %{server: server, path: path} do
    AgentDirectory.record("a.4", "kuroe", "kuroe", server)
    AgentDirectory.touch("a.4", server)
    _ = AgentDirectory.all(server)
    :ok = GenServer.stop(server)

    name2 = :"ad_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = AgentDirectory.start_link(name: name2, path: path)

    # persona_id / display_name / revision は復元、last_seen はプロセス
    # 再起動でリセット (memory-only)
    assert AgentDirectory.get("a.4", name2) == %{
             persona_id: "kuroe",
             display_name: "kuroe",
             last_seen: nil,
             revision: @initial_revision
           }

    GenServer.stop(name2)
  end

  test "loader bounds current and legacy display_names by UTF-8 bytes" do
    table_name = :"ad_display_name_bound_#{System.unique_integer([:positive])}"
    path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
    File.rm(path)

    on_exit(fn -> File.rm(path) end)

    {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
    at_limit = String.duplicate("😀", 64)
    oversized = String.duplicate("😀", 63) <> "á̂"

    assert byte_size(at_limit) == 256
    assert byte_size(oversized) == 257

    :ok = :dets.insert(table_name, {"a.display-name-max", "ao", 1, at_limit})

    :ok =
      :dets.insert(table_name, {"a.display-name-oversized", "ao", 1, oversized})

    :ok =
      :dets.insert(
        table_name,
        {"a.display-name-legacy-max", %{"id" => "fuji", "name" => at_limit}, 2}
      )

    :ok =
      :dets.insert(
        table_name,
        {"a.display-name-legacy-oversized", %{"id" => "fuji", "name" => oversized}, 2}
      )

    :ok =
      :dets.insert(
        table_name,
        {"a.display-name-legacy-two-max", %{"id" => "momo", "name" => at_limit}}
      )

    :ok =
      :dets.insert(
        table_name,
        {"a.display-name-legacy-two-oversized", %{"id" => "momo", "name" => oversized}}
      )

    :ok = :dets.close(table_name)

    name = :"ad_display_name_bound_load_#{System.unique_integer([:positive])}"

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

        assert %{display_name: ^at_limit, revision: @initial_revision} =
                 AgentDirectory.get("a.display-name-max", name)

        assert AgentDirectory.get("a.display-name-oversized", name) == nil

        assert %{display_name: ^at_limit, revision: 2} =
                 AgentDirectory.get("a.display-name-legacy-max", name)

        assert AgentDirectory.get("a.display-name-legacy-oversized", name) == nil

        assert %{display_name: ^at_limit, revision: @initial_revision} =
                 AgentDirectory.get("a.display-name-legacy-two-max", name)

        assert AgentDirectory.get("a.display-name-legacy-two-oversized", name) == nil
        GenServer.stop(pid)
      end)

    assert log =~ "agent directory: skipping DETS record with oversized display_name"
  end

  test "all は全 entry を返す", %{server: server} do
    AgentDirectory.record("a.5", "ao", "ao", server)
    AgentDirectory.record("a.6", "momo", "momo", server)
    all = AgentDirectory.all(server)

    assert all["a.5"] == %{
             persona_id: "ao",
             display_name: "ao",
             last_seen: nil,
             revision: @initial_revision
           }

    assert all["a.6"] == %{
             persona_id: "momo",
             display_name: "momo",
             last_seen: nil,
             revision: @initial_revision
           }
  end

  test "delete で entry が消え、再起動後も残らない", %{server: server, path: path} do
    AgentDirectory.record("a.7", "ao", "ao", server)
    assert %{persona_id: "ao"} = AgentDirectory.get("a.7", server)

    assert AgentDirectory.delete("a.7", server) == :ok
    assert AgentDirectory.get("a.7", server) == nil

    :ok = GenServer.stop(server)
    name2 = :"ad_delete_#{System.unique_integer([:positive])}"
    {:ok, _pid} = AgentDirectory.start_link(name: name2, path: path)
    assert AgentDirectory.get("a.7", name2) == nil
    GenServer.stop(name2)
  end

  test "delete は未知 agent でも :ok (冪等)", %{server: server} do
    assert AgentDirectory.delete("a.none", server) == :ok
  end

  # issue #197 段階3 (D12), 改訂 issue #219 D19: 稼働中 rename の永続化
  # ターゲットは `display_name` のみ — `persona_id` (canonical への
  # stable reference) は rename で一切変わらない。
  describe "rename/3 (issue #197 段階3, revised issue #219)" do
    test "display_name を書き換え、revision を 1 進めて返す。persona_id は不変", %{
      server: server
    } do
      AgentDirectory.record("a.8", "ao", "あお", server)

      assert {:ok, entry} = AgentDirectory.rename("a.8", "あお(改名)", server)
      assert entry.display_name == "あお(改名)"
      # baseline @initial_revision(1) + 1 = 2 (issue #219 MF-2).
      assert entry.revision == 2
      # persona_id (canonical への stable reference) は rename で不変
      # (issue #219 D19 — ADR-0030 D2 改訂)
      assert entry.persona_id == "ao"

      assert AgentDirectory.get("a.8", server) == entry
    end

    test "2 回 rename すると revision が単調に進む", %{server: server} do
      AgentDirectory.record("a.9", "momo", "momo", server)

      # baseline @initial_revision = 1 (issue #219 MF-2), so 2 renames land
      # at 2 then 3.
      assert {:ok, %{revision: 2}} = AgentDirectory.rename("a.9", "もも(1)", server)
      assert {:ok, %{revision: 3}} = AgentDirectory.rename("a.9", "もも(2)", server)
      assert %{display_name: "もも(2)", revision: 3} = AgentDirectory.get("a.9", server)
    end

    test "未知 agent は :not_found", %{server: server} do
      assert AgentDirectory.rename("a.none", "x", server) == {:error, :not_found}
    end

    # D15 (ふじ指摘): 2 つの AgentsChannel process から同時に rename が
    # 来ても、単一 GenServer への直列化で revision が重複/欠落なく
    # 割り振られ、最終状態が「revision の大きい方」と一致することを
    # pin する。broadcast の到達順は wrapper 側の revision 比較 (unit A
    # の wrapper 側実装) が別途保証するので、ここは store 側の直列化
    # 正しさだけを見る。
    test "concurrent rename は revision の重複/欠落なく直列化され、最終状態は revision 最大の方と一致する", %{
      server: server
    } do
      AgentDirectory.record("a.11", "ao", "ao", server)

      results =
        [
          Task.async(fn -> AgentDirectory.rename("a.11", "並行1", server) end),
          Task.async(fn -> AgentDirectory.rename("a.11", "並行2", server) end)
        ]
        |> Enum.map(&Task.await/1)

      # baseline @initial_revision = 1 (issue #219 MF-2), so the 2
      # concurrent renames land at 2 and 3.
      revisions = Enum.map(results, fn {:ok, %{revision: r}} -> r end) |> Enum.sort()
      assert revisions == [2, 3]

      {:ok, winner} = Enum.max_by(results, fn {:ok, %{revision: r}} -> r end)
      assert winner.revision == 3
      assert AgentDirectory.get("a.11", server) == winner
    end

    # D16/MF-3 (ふじ レビュー指摘): rename ごとの "directory" broadcast が
    # AgentDirectory 自身の GenServer から、書き込みと同じ直列化された
    # call の中で同期的に発火することを pin する。以前は呼び出し元
    # (agents_channel.ex) が rename 呼び出し後に別途 `AgentDirectory.all/1`
    # を読んで broadcast していたため、2 つの並行 rename の write 順序は
    # 直列化されていても、その後の read+broadcast のペアが呼び出し元同士で
    # 競合し、古い snapshot の broadcast が新しい方より後着し得た
    # (dashboard は revision を見ず wholesale replace するため、stale な
    # 表示に戻ってしまう)。この pin は broadcast の到達順が revision の
    # 昇順(非減少)であることを確認する — MF-3 前の実装 (呼び出し元での
    # 分離 read+broadcast) へ戻すと、稀にこの順序が崩れる。broadcast
    # payload は persona_id/display_name の生の entries であり (issue
    # #219 D19)、canonical join を含まない — この test はそこを見ない。
    test "concurrent rename の directory broadcast は revision 逆転無く届く (issue #197 段階3 MF-3)",
         %{server: server} do
      AgentDirectory.record("a.12", "ao", "ao", server)
      :ok = Phoenix.PubSub.subscribe(KaoiroServer.PubSub, "agents:lobby")

      [
        Task.async(fn -> AgentDirectory.rename("a.12", "並行1", server) end),
        Task.async(fn -> AgentDirectory.rename("a.12", "並行2", server) end)
      ]
      |> Enum.each(&Task.await/1)

      revisions = for _ <- 1..2, do: receive_directory_revision("a.12")

      assert revisions == Enum.sort(revisions)
    end

    test "rename 後の再起動で新しい display_name と revision が残る", %{server: server, path: path} do
      AgentDirectory.record("a.10", "kuroe", "kuroe", server)
      # baseline @initial_revision(1) + 1 = 2 (issue #219 MF-2).
      assert {:ok, %{revision: 2}} = AgentDirectory.rename("a.10", "くろえ(改)", server)
      :ok = GenServer.stop(server)

      name2 = :"ad_rename_restart_#{System.unique_integer([:positive])}"
      {:ok, _pid} = AgentDirectory.start_link(name: name2, path: path)

      assert AgentDirectory.get("a.10", name2) == %{
               persona_id: "kuroe",
               display_name: "くろえ(改)",
               last_seen: nil,
               revision: 2
             }

      GenServer.stop(name2)
    end

    # MF-5 (ふじ レビュー指摘): revision が @max_safe_revision に達した
    # entry を rename すると +1 で wire domain (0..@max_safe_revision)
    # を超える。fail-closed で拒否し、entry は完全に不変のまま (DETS
    # 書き込み・directory broadcast・sync relay のいずれも発生しない)
    # ことを pin する。record/4 は revision 0 からしか entry を作れない
    # ので、専用 DETS ファイルへ直接 raw 4-tuple を書き込んで上限直下の
    # state を作る (MF-4 の後方互換テストと同じ手法)。
    test "revision が上限 (@max_safe_revision) の entry は rename が :revision_exhausted で拒否され、entry は不変のまま" do
      table_name = :"ad_max_rev_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.maxrev", "fuji", @max_safe_revision, "fuji"})
      :ok = :dets.close(table_name)

      name = :"ad_max_rev_load_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      before = AgentDirectory.get("a.maxrev", name)
      assert before.revision == @max_safe_revision

      assert AgentDirectory.rename("a.maxrev", "藤(改)", name) == {:error, :revision_exhausted}
      assert AgentDirectory.get("a.maxrev", name) == before

      GenServer.stop(pid)
      File.rm(path)
    end

    # 境界の反対側 (off-by-one が無いことの pin): 上限のちょうど 1 手前
    # なら通常どおり成功し、revision が上限ちょうどへ到達する。
    test "revision が上限-1 の entry は rename が成功し revision が上限ちょうどになる" do
      table_name = :"ad_near_max_rev_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.nearmax", "fuji", @max_safe_revision - 1, "fuji"})
      :ok = :dets.close(table_name)

      name = :"ad_near_max_rev_load_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      assert {:ok, %{revision: revision}} = AgentDirectory.rename("a.nearmax", "藤(改)", name)
      assert revision == @max_safe_revision

      GenServer.stop(pid)
      File.rm(path)
    end
  end

  # issue #219 D21: 段階3 以前に書かれた DETS ファイル (revision の無い
  # bare 2-tuple、または revision 付き 3-tuple、いずれも persona MAP を
  # 埋め込んだ旧形式) を新コードが読んでもクラッシュしない後方互換パス。
  # 移行は無条件 (推測しない) — 旧 persona["name"] は無条件に
  # display_name へコピーされ、canonical (name/sprite_set) は一切migrate
  # されない (persona_id だけが stable reference として引き継がれる)。
  describe "旧形式 DETS (issue #197 段階3以前、persona map 埋め込み) からの読み込み — issue #219 D21 unconditional migration" do
    test "2-tuple (revision 無し): persona_id/display_name へ無条件migrationされ、revision: @initial_revision になる" do
      # 共有 setup の path とは独立の、このテスト専用の DETS ファイル
      # (setup 側の AgentDirectory が同じ path を既に開いているため、
      # 使い回すと :dets.open_file が競合する)。
      table_name = :"ad_legacy_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      # record/3 を経由せず、段階3以前のコードが書いていた生の 2-tuple
      # (persona MAP を埋め込んだ旧形式) を直接 DETS へ書き込む。
      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.legacy", persona("fuji", "ふじ")})
      :ok = :dets.close(table_name)

      name = :"ad_legacy_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      # canonical (sprite_set 等) は保存されない — persona_id と
      # display_name(旧 persona["name"] のコピー) のみ。
      assert AgentDirectory.get("a.legacy", name) == %{
               persona_id: "fuji",
               display_name: "ふじ",
               last_seen: nil,
               revision: @initial_revision
             }

      # baseline @initial_revision(1) + 1 = 2 (issue #219 MF-2).
      assert {:ok, %{revision: 2, display_name: "藤(改)", persona_id: "fuji"}} =
               AgentDirectory.rename("a.legacy", "藤(改)", name)

      GenServer.stop(pid)
      File.rm(path)
    end

    test "3-tuple (revision 付き): persona_id/display_name へ無条件migrationされ、revision も引き継がれる" do
      table_name = :"ad_legacy3_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      # 段階3 の apply_custom_name/rename がすでに persona["name"] を
      # 書き換え済み ("藤(通称)") という、issue #219 が問題視する状態
      # そのものを fixture 化する。
      :ok = :dets.insert(table_name, {"a.legacy3", persona("fuji", "藤(通称)"), 3})
      :ok = :dets.close(table_name)

      name = :"ad_legacy3_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      assert AgentDirectory.get("a.legacy3", name) == %{
               persona_id: "fuji",
               display_name: "藤(通称)",
               last_seen: nil,
               revision: 3
             }

      GenServer.stop(pid)
      File.rm(path)
    end

    # MF-4/MF-5 (ふじ レビュー指摘、issue #219 でも維持): 3-tuple 形式
    # でも revision が @initial_revision..@max_safe_revision の integer
    # domain 外なら @initial_revision(issue #219 MF-2)へフォールバックし、
    # クラッシュも unsafe な値の持ち越しもしない。
    test "revision が破損している (負数/非整数/上限超過) 3-tuple は revision: @initial_revision へフォールバックする" do
      for bad_revision <- [-1, "1", 1.5, nil, @max_safe_revision + 1] do
        table_name = :"ad_legacy_bad_rev_#{System.unique_integer([:positive])}"
        path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
        File.rm(path)

        {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
        :ok = :dets.insert(table_name, {"a.badrev", persona("fuji"), bad_revision})
        :ok = :dets.close(table_name)

        name = :"ad_legacy_bad_rev_load_#{System.unique_integer([:positive])}"
        {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

        assert %{revision: @initial_revision} = AgentDirectory.get("a.badrev", name)
        # rename が revision + 1 でクラッシュしないことも確認する。
        assert {:ok, %{revision: 2}} = AgentDirectory.rename("a.badrev", "藤(改)", name)

        GenServer.stop(pid)
        File.rm(path)
      end
    end

    # issue #219 MF-2 acceptance pin (クロエ実測検証): a persisted
    # revision of exactly 0 — the legitimate PRE-MF-2 baseline, not a
    # corrupted value — must ALSO be lifted to @initial_revision on load,
    # not just clamped when out-of-domain. This is what closes the
    # new-server/old-wrapper gap: a legacy wrapper's own sync guard is
    # `if (revision <= this.#personaRevision) return;` starting at 0, so
    # a load-time revision that stayed at 0 would still be silently
    # dropped by that guard on the first post-restart rename push.
    test "既に revision: 0 で永続化された 4-tuple entry (pre-MF-2 baseline) は load 時に @initial_revision へ持ち上げられる" do
      table_name = :"ad_pre_mf2_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.premf2", "fuji", 0, "藤"})
      :ok = :dets.close(table_name)

      name = :"ad_pre_mf2_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      assert %{revision: @initial_revision} = AgentDirectory.get("a.premf2", name)

      # A rename after the lift bumps to @initial_revision + 1 = 2, past
      # a legacy wrapper's `revision <= 0` drop guard — the exact
      # scenario MF-2 exists to fix (unit A pins the wrapper-side half).
      assert {:ok, %{revision: 2}} = AgentDirectory.rename("a.premf2", "藤(改)", name)

      GenServer.stop(pid)
      File.rm(path)
    end

    # issue #219 MF-5 (クロエ実測検証): a legacy persona map with `"id"`
    # but no usable `"name"` must NOT invent a display_name from
    # `persona_id` — that is exactly the guessing D21 already rejected
    # for the canonical join, just relocated to this migration path. Such
    # a record falls through both the 3-tuple and 2-tuple legacy clauses
    # (now guard-gated on `"name"` being present and binary) to the
    # catch-all, and is skipped with a warning rather than migrated.
    test "\"name\" が欠落/非binary な legacy persona map は persona_id を display_name として発明せず catch-all でスキップされる" do
      table_name = :"ad_legacy_no_name_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      # 3-tuple: "name" キー自体が無い legacy persona map。
      :ok = :dets.insert(table_name, {"a.noname3", %{"id" => "fuji", "sprite_set" => "fuji"}, 2})
      # 2-tuple: "name" が非 binary (nil) な legacy persona map。
      :ok =
        :dets.insert(
          table_name,
          {"a.noname2", %{"id" => "momo", "name" => nil, "sprite_set" => "momo"}}
        )

      # 対照として、正常な legacy record も同じテーブルに混在させる —
      # 破損レコードが台帳全体の読み込みを止めないことも合わせて pin する。
      :ok = :dets.insert(table_name, {"a.wellformed", persona("ao", "あお"), 1})
      :ok = :dets.close(table_name)

      name = :"ad_legacy_no_name_#{System.unique_integer([:positive])}"

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

          # 発明されない: エントリごと存在しない (persona_id を display_name
          # に流用した nil でない値ではなく、entry 自体が nil)。
          assert AgentDirectory.get("a.noname3", name) == nil
          assert AgentDirectory.get("a.noname2", name) == nil

          assert %{persona_id: "ao", display_name: "あお", revision: 1} =
                   AgentDirectory.get("a.wellformed", name)

          GenServer.stop(pid)
        end)

      assert log =~ "skipping unrecognised DETS record"
      File.rm(path)
    end
  end

  # クロエ実測検証 must-fix (issue #219): 段階3 まで 2-tuple/3-tuple 節が
  # 無 guard だったため、壊れた/認識できないレコードでも読めていた。issue
  # #219 D21 でその 2 節に `is_binary` guard を付けたことで、guard を通ら
  # ない形の record は `:dets.foldl` 内で `FunctionClauseError` を起こし
  # かねない — catch-all 節がそれを防ぎ、破損レコード 1 件が台帳全体の
  # 起動失敗(再起動ループ)に波及しないことを pin する。
  describe "認識できない DETS レコードからの読み込み (catch-all fail-soft)" do
    test "guard に一致しない record はスキップされ、他の正常なレコードは読み込まれる" do
      table_name = :"ad_unknown_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      # どの load_fold/2 節にもマッチしない、破損/未知の shape。
      :ok = :dets.insert(table_name, {"a.broken", :not_a_persona_id, "not_an_integer"})
      # 正常な新形式レコードも同じテーブルに混在させ、破損レコードが
      # テーブル全体の読み込みを止めないことを確認する。
      :ok = :dets.insert(table_name, {"a.ok", "fuji", 0, "ふじ"})
      :ok = :dets.close(table_name)

      name = :"ad_unknown_#{System.unique_integer([:positive])}"

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

          assert AgentDirectory.get("a.broken", name) == nil

          # revision @initial_revision, not the raw-inserted 0 — same
          # load-time floor-lift as the pre-MF-2 baseline test above.
          assert AgentDirectory.get("a.ok", name) == %{
                   persona_id: "fuji",
                   display_name: "ふじ",
                   last_seen: nil,
                   revision: @initial_revision
                 }

          GenServer.stop(pid)
        end)

      assert log =~ "skipping unrecognised DETS record"
      File.rm(path)
    end
  end

  # issue #219 MF-6 (ふじ最終レビュー指摘, クロエ実測検証): round 1 の
  # catch-all は persona_id/display_name/revision の shape mismatch しか
  # 見ておらず、agent_id 自体は 3 節すべてで無条件に受理していた —
  # 特に legacy 節 (3-tuple/2-tuple) は `Logger.warning` 内で
  # `#{agent_id}` を直接補間するため、non-binary な agent_id (壊れた
  # map/atom 等) は catch-all へ落ちる前に `Protocol.UndefinedError` で
  # `:dets.foldl` ごと落ち、`AgentDirectory.init/1` を crash させる —
  # `bddbcec` (issue #219 以前) の `load_fold` は agent_id を一切補間
  # しておらず、この失敗モードが無かった (issue #219 が持ち込んだ回帰)。
  # current 4-tuple 節は補間こそ無いが、guard 無しでは non-binary な
  # agent_id がそのまま `entries` map のキーとして残り、directory
  # broadcast / JSON projection まで破損を持ち越す。3 形式それぞれで
  # 「起動する・破損行だけ skip・正常行は残る」を pin する。
  describe "agent_id が non-binary な DETS レコード (issue #219 MF-6)" do
    test "current 4-tuple: 破損行は skip され、正常な隣接行は読み込まれる" do
      table_name = :"ad_badid4_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {%{bad: true}, "fuji", 1, "藤"})
      :ok = :dets.insert(table_name, {"a.ok4", "fuji", 1, "藤"})
      :ok = :dets.close(table_name)

      name = :"ad_badid4_#{System.unique_integer([:positive])}"

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

          all = AgentDirectory.all(name)
          assert Map.keys(all) == ["a.ok4"]
          assert %{persona_id: "fuji", display_name: "藤"} = all["a.ok4"]

          GenServer.stop(pid)
        end)

      assert log =~ "skipping unrecognised DETS record"
      File.rm(path)
    end

    test "legacy 3-tuple: 破損行は skip され、正常な隣接行は読み込まれる" do
      table_name = :"ad_badid3_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {%{bad: true}, persona("fuji", "藤"), 2})
      :ok = :dets.insert(table_name, {"a.ok3", persona("fuji", "藤"), 2})
      :ok = :dets.close(table_name)

      name = :"ad_badid3_#{System.unique_integer([:positive])}"

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

          all = AgentDirectory.all(name)
          assert Map.keys(all) == ["a.ok3"]
          assert %{persona_id: "fuji", display_name: "藤"} = all["a.ok3"]

          GenServer.stop(pid)
        end)

      assert log =~ "skipping unrecognised DETS record"
      File.rm(path)
    end

    # クロエの実測どおり、MF-6 前はこの 2-tuple 形式が
    # `Protocol.UndefinedError` で `AgentDirectory.init/1` を crash させ
    # ていた (Logger.warning の `#{agent_id}` 補間) — is_binary(agent_id)
    # guard がそれより先に catch-all へ落とすことを pin する。
    test "legacy 2-tuple (補間 crash の再現ケース): 破損行は skip され、正常な隣接行は読み込まれる" do
      table_name = :"ad_badid2_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {%{bad: true}, persona("fuji", "藤")})
      :ok = :dets.insert(table_name, {"a.ok2", persona("fuji", "藤")})
      :ok = :dets.close(table_name)

      name = :"ad_badid2_#{System.unique_integer([:positive])}"

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

          all = AgentDirectory.all(name)
          assert Map.keys(all) == ["a.ok2"]
          assert %{persona_id: "fuji", display_name: "藤"} = all["a.ok2"]

          GenServer.stop(pid)
        end)

      assert log =~ "skipping unrecognised DETS record"
      File.rm(path)
    end
  end

  # issue #219 D19: 新形式 (4-tuple, persona_id/display_name/revision の
  # みで canonical 無し) からの読み込みが正しく丸めて復元されることを
  # pin する。旧形式との判別は tuple の要素数で行われる (persona map で
  # はなく binary な persona_id かどうかで区別する 2 clause 目のガード
  # 節がある) — この test はその新形式 clause 自体を直接 exercise する。
  describe "新形式 DETS (issue #219, persona_id 参照のみ) からの読み込み" do
    test "4-tuple はそのまま復元される" do
      table_name = :"ad_new_raw_#{System.unique_integer([:positive])}"
      path = Path.join([System.tmp_dir!(), "kaoiro_test_dets", "#{table_name}.dets"])
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.new", "ao", 5, "あお(通称)"})
      :ok = :dets.close(table_name)

      name = :"ad_new_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      assert AgentDirectory.get("a.new", name) == %{
               persona_id: "ao",
               display_name: "あお(通称)",
               last_seen: nil,
               revision: 5
             }

      GenServer.stop(pid)
      File.rm(path)
    end
  end
end
