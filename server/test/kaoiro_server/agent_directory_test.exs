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

  setup do
    # Isolated DETS file + table name per test so cases don't share state.
    name = :"ad_#{System.unique_integer([:positive])}"
    path = Path.join(System.tmp_dir!(), "#{name}.dets")
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

  test "record してから get すると persona が返る (last_seen は nil、revision は 0)", %{
    server: server
  } do
    AgentDirectory.record("a.1", persona("ao"), server)

    assert AgentDirectory.get("a.1", server) == %{
             persona: persona("ao"),
             last_seen: nil,
             revision: 0
           }
  end

  test "未知 agent は nil", %{server: server} do
    assert AgentDirectory.get("a.none", server) == nil
  end

  # record/3 は create-only (issue #197 段階3、ふじ MF-2 レビュー指摘):
  # 既存 agent_id への再 record は persona/revision とも一切変更しない
  # (異なる persona が来ても無視)。以前は「異なる persona なら revision
  # を進めて上書き」だったが、これは rename/3 との revision 競合を招き
  # (遅延 record が rename を高い revision で巻き戻し得た)、逆効果
  # だった。
  test "再 record は既存 entry を一切変更しない (create-only、issue #197 段階3 MF-2)", %{
    server: server
  } do
    AgentDirectory.record("a.2", persona("ao", "青"), server)
    AgentDirectory.record("a.2", persona("ao", "青(改)"), server)

    assert %{persona: %{"name" => "青"}, revision: 0} = AgentDirectory.get("a.2", server)
  end

  # MF-2 が防ぐ具体的なシナリオ: rename 後に届いた「遅延 record」が
  # rename の結果を巻き戻さないこと。
  test "rename 後に届いた遅延 record は rename の name/revision を巻き戻さない (MF-2)", %{
    server: server
  } do
    AgentDirectory.record("a.2b", persona("ao", "青"), server)
    assert {:ok, %{revision: 1}} = AgentDirectory.rename("a.2b", "青(改名)", server)

    # spawn 直後の重複/遅延 cast が、rename 適用後に届く想定。
    AgentDirectory.record("a.2b", persona("ao", "青"), server)

    assert %{persona: %{"name" => "青(改名)"}, revision: 1} = AgentDirectory.get("a.2b", server)
  end

  test "touch で last_seen が更新される", %{server: server} do
    AgentDirectory.record("a.3", persona("ao"), server)
    assert %{last_seen: nil} = AgentDirectory.get("a.3", server)

    AgentDirectory.touch("a.3", server)
    # cast の完了を確認するため call を挟む
    _ = AgentDirectory.all(server)
    entry = AgentDirectory.get("a.3", server)
    assert is_integer(entry.last_seen)
  end

  test "touch は persona 未 record の agent を作らない", %{server: server} do
    AgentDirectory.touch("a.ghost", server)
    _ = AgentDirectory.all(server)
    assert AgentDirectory.get("a.ghost", server) == nil
  end

  test "同一 DETS ファイルからの再起動で persona が残る (last_seen は nil に戻る)", %{
    server: server,
    path: path
  } do
    AgentDirectory.record("a.4", persona("kuroe"), server)
    AgentDirectory.touch("a.4", server)
    _ = AgentDirectory.all(server)
    :ok = GenServer.stop(server)

    name2 = :"ad_restart_#{System.unique_integer([:positive])}"
    {:ok, _pid} = AgentDirectory.start_link(name: name2, path: path)

    # persona / revision は復元、last_seen はプロセス再起動でリセット
    # (memory-only)
    assert AgentDirectory.get("a.4", name2) == %{
             persona: persona("kuroe"),
             last_seen: nil,
             revision: 0
           }

    GenServer.stop(name2)
  end

  test "all は全 entry を返す", %{server: server} do
    AgentDirectory.record("a.5", persona("ao"), server)
    AgentDirectory.record("a.6", persona("momo"), server)
    all = AgentDirectory.all(server)
    assert all["a.5"] == %{persona: persona("ao"), last_seen: nil, revision: 0}
    assert all["a.6"] == %{persona: persona("momo"), last_seen: nil, revision: 0}
  end

  test "delete で entry が消え、再起動後も残らない", %{server: server, path: path} do
    AgentDirectory.record("a.7", persona("ao"), server)
    assert %{persona: _} = AgentDirectory.get("a.7", server)

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

  # issue #197 段階3 (D12): 稼働中 rename の永続化ターゲット。
  describe "rename/3 (issue #197 段階3)" do
    test "persona の name を書き換え、revision を 1 進めて返す", %{server: server} do
      AgentDirectory.record("a.8", persona("ao", "あお"), server)

      assert {:ok, entry} = AgentDirectory.rename("a.8", "あお(改名)", server)
      assert entry.persona["name"] == "あお(改名)"
      assert entry.revision == 1
      # id / sprite_set は不変 (ADR-0030 D2 改訂、可変なのは name のみ)
      assert entry.persona["id"] == "ao"
      assert entry.persona["sprite_set"] == "ao"

      assert AgentDirectory.get("a.8", server) == entry
    end

    test "2 回 rename すると revision が単調に進む", %{server: server} do
      AgentDirectory.record("a.9", persona("momo"), server)

      assert {:ok, %{revision: 1}} = AgentDirectory.rename("a.9", "もも(1)", server)
      assert {:ok, %{revision: 2}} = AgentDirectory.rename("a.9", "もも(2)", server)
      assert %{persona: %{"name" => "もも(2)"}, revision: 2} = AgentDirectory.get("a.9", server)
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
      AgentDirectory.record("a.11", persona("ao"), server)

      results =
        [
          Task.async(fn -> AgentDirectory.rename("a.11", "並行1", server) end),
          Task.async(fn -> AgentDirectory.rename("a.11", "並行2", server) end)
        ]
        |> Enum.map(&Task.await/1)

      revisions = Enum.map(results, fn {:ok, %{revision: r}} -> r end) |> Enum.sort()
      assert revisions == [1, 2]

      {:ok, winner} = Enum.max_by(results, fn {:ok, %{revision: r}} -> r end)
      assert winner.revision == 2
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
    # 分離 read+broadcast) へ戻すと、稀にこの順序が崩れる。
    test "concurrent rename の directory broadcast は revision 逆転無く届く (issue #197 段階3 MF-3)",
         %{server: server} do
      AgentDirectory.record("a.12", persona("ao"), server)
      :ok = Phoenix.PubSub.subscribe(KaoiroServer.PubSub, "agents:lobby")

      [
        Task.async(fn -> AgentDirectory.rename("a.12", "並行1", server) end),
        Task.async(fn -> AgentDirectory.rename("a.12", "並行2", server) end)
      ]
      |> Enum.each(&Task.await/1)

      revisions = for _ <- 1..2, do: receive_directory_revision("a.12")

      assert revisions == Enum.sort(revisions)
    end

    test "rename 後の再起動で新しい name と revision が残る", %{server: server, path: path} do
      AgentDirectory.record("a.10", persona("kuroe"), server)
      assert {:ok, %{revision: 1}} = AgentDirectory.rename("a.10", "くろえ(改)", server)
      :ok = GenServer.stop(server)

      name2 = :"ad_rename_restart_#{System.unique_integer([:positive])}"
      {:ok, _pid} = AgentDirectory.start_link(name: name2, path: path)

      assert AgentDirectory.get("a.10", name2) == %{
               persona: persona("kuroe", "くろえ(改)"),
               last_seen: nil,
               revision: 1
             }

      GenServer.stop(name2)
    end

    # MF-5 (ふじ レビュー指摘): revision が @max_safe_revision に達した
    # entry を rename すると +1 で wire domain (0..@max_safe_revision)
    # を超える。fail-closed で拒否し、entry は完全に不変のまま (DETS
    # 書き込み・directory broadcast・persona_sync relay のいずれも
    # 発生しない) ことを pin する。record/3 は revision 0 からしか
    # entry を作れないので、専用 DETS ファイルへ直接 raw 3-tuple を
    # 書き込んで上限直下の state を作る (MF-4 の後方互換テストと同じ
    # 手法)。
    test "revision が上限 (@max_safe_revision) の entry は rename が :revision_exhausted で拒否され、entry は不変のまま" do
      table_name = :"ad_max_rev_#{System.unique_integer([:positive])}"
      path = Path.join(System.tmp_dir!(), "#{table_name}.dets")
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.maxrev", persona("fuji"), @max_safe_revision})
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
      path = Path.join(System.tmp_dir!(), "#{table_name}.dets")
      File.rm(path)

      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.nearmax", persona("fuji"), @max_safe_revision - 1})
      :ok = :dets.close(table_name)

      name = :"ad_near_max_rev_load_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      assert {:ok, %{revision: revision}} = AgentDirectory.rename("a.nearmax", "藤(改)", name)
      assert revision == @max_safe_revision

      GenServer.stop(pid)
      File.rm(path)
    end
  end

  # 段階3 以前に書かれた DETS ファイル (revision の無い bare 2-tuple) を
  # 新コードが読んでもクラッシュしない後方互換パス。
  describe "旧形式 DETS (revision 無し 2-tuple) からの読み込み" do
    test "revision: 0 として読み込まれ、rename も正常に効く" do
      # 共有 setup の path とは独立の、このテスト専用の DETS ファイル
      # (setup 側の AgentDirectory が同じ path を既に開いているため、
      # 使い回すと :dets.open_file が競合する)。
      table_name = :"ad_legacy_raw_#{System.unique_integer([:positive])}"
      path = Path.join(System.tmp_dir!(), "#{table_name}.dets")
      File.rm(path)

      # record/3 を経由せず、段階3以前のコードが書いていた生の 2-tuple を
      # 直接 DETS へ書き込む (issue #197 段階3 の後方互換テスト)。
      {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
      :ok = :dets.insert(table_name, {"a.legacy", persona("fuji")})
      :ok = :dets.close(table_name)

      name = :"ad_legacy_#{System.unique_integer([:positive])}"
      {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

      assert AgentDirectory.get("a.legacy", name) == %{
               persona: persona("fuji"),
               last_seen: nil,
               revision: 0
             }

      assert {:ok, %{revision: 1, persona: %{"name" => "藤(改)"}}} =
               AgentDirectory.rename("a.legacy", "藤(改)", name)

      GenServer.stop(pid)
      File.rm(path)
    end

    # MF-4/MF-5 (ふじ レビュー指摘): 3-tuple 形式でも revision が
    # 0..@max_safe_revision の integer domain 外なら 0 へフォール
    # バックし、クラッシュも unsafe な値の持ち越しもしない。MF-5 で
    # 追加した `@max_safe_revision + 1` ケースは上限側の回帰 pin —
    # MF-5 前は下限 (負数/非整数) しかチェックしておらず、上限超過の
    # persisted 値をそのまま採用して `persona_sync` へ流していた
    # (どの wrapper の narrow にも drop され、その agent の persona が
    # 永久に収束不能になる)。
    test "revision が破損している (負数/非整数/上限超過) 3-tuple は revision: 0 へフォールバックする" do
      for bad_revision <- [-1, "1", 1.5, nil, @max_safe_revision + 1] do
        table_name = :"ad_legacy_bad_rev_#{System.unique_integer([:positive])}"
        path = Path.join(System.tmp_dir!(), "#{table_name}.dets")
        File.rm(path)

        {:ok, ^table_name} = :dets.open_file(table_name, file: String.to_charlist(path))
        :ok = :dets.insert(table_name, {"a.badrev", persona("fuji"), bad_revision})
        :ok = :dets.close(table_name)

        name = :"ad_legacy_bad_rev_load_#{System.unique_integer([:positive])}"
        {:ok, pid} = AgentDirectory.start_link(name: name, path: path)

        assert %{revision: 0} = AgentDirectory.get("a.badrev", name)
        # rename が revision + 1 でクラッシュしないことも確認する。
        assert {:ok, %{revision: 1}} = AgentDirectory.rename("a.badrev", "藤(改)", name)

        GenServer.stop(pid)
        File.rm(path)
      end
    end
  end
end
