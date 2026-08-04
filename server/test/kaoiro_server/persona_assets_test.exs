defmodule KaoiroServer.PersonaAssetsTest do
  # Mutates the :persona_dir config and the persistent_term cache.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.FooterAssets
  alias KaoiroServer.PersonaAssets

  @states ~w(idle thinking tool_running waiting_input
             waiting_permission done error)

  # DOS date 1980-01-01 (day 1, month 1, year 0 = 1980). 手組み zip で日付を
  # 0 にすると 1980-00-00 という無効日付になり、展開そのものは成功した直後の
  # `write_file_info` が :badarg で落ちる — 展開まで到達するテストが必要。
  @dos_date 0x0021

  setup do
    original = Application.get_env(:kaoiro_server, :persona_dir)
    original_cache = Application.get_env(:kaoiro_server, :persona_cache_dir)

    on_exit(fn ->
      restore_env(:persona_dir, original)
      restore_env(:persona_cache_dir, original_cache)
      PersonaAssets.rebuild()
    end)

    :ok
  end

  defp restore_env(key, nil), do: Application.delete_env(:kaoiro_server, key)
  defp restore_env(key, value), do: Application.put_env(:kaoiro_server, key, value)

  # Builds a minimal-but-valid pack zip at `<dir>/<name>.zip`. The zip's
  # top-level entries are `manifest.json`, `personality.md`, `sprites/
  # <state>.png × 7` per persona-pack-schema.md.
  defp write_pack(dir, name, manifest, personality) do
    src = Path.join(dir, "_stage_" <> name)
    File.mkdir_p!(Path.join(src, "sprites"))
    File.write!(Path.join(src, "manifest.json"), Jason.encode!(manifest))
    File.write!(Path.join(src, "personality.md"), personality)

    for state <- @states do
      File.write!(Path.join([src, "sprites", "#{state}.png"]), "png-#{name}-#{state}")
    end

    zip_path = String.to_charlist(Path.join(dir, "#{name}.zip"))

    files =
      ["manifest.json", "personality.md" | Enum.map(@states, &"sprites/#{&1}.png")]
      |> Enum.map(&String.to_charlist/1)

    {:ok, _} = :zip.create(zip_path, files, cwd: String.to_charlist(src))
    File.rm_rf!(src)
    :ok
  end

  # `:zip.create/3` の `{name, body, file_info}` 形は、アーカイブ側が mode を
  # 宣言する唯一の作り方 (実ファイル経由だと mode 0 のファイルは create 自身が
  # 読めない)。敵対的な pack が取る経路そのもの。
  #
  #   :manifest    — manifest.json を mode 0 で宣言する
  #   :sprites_dir — sprites/ を mode 0 のディレクトリとして宣言する
  #   :abort       — mode 0 の manifest.json を書かせた直後、必ず open に
  #                  失敗する 300 byte 名で展開を中断させる
  defp write_poisoned_pack(dir, name, manifest, poison) do
    body = Jason.encode!(manifest)
    sprites = Enum.map(@states, &{String.to_charlist("sprites/#{&1}.png"), "png-#{name}-#{&1}"})
    unreadable = mode_record(dir, :regular, 0o100000, byte_size(body))

    entries =
      case poison do
        :manifest ->
          [{~c"manifest.json", body, unreadable}, {~c"personality.md", "body-#{name}"} | sprites]

        :sprites_dir ->
          [
            {~c"manifest.json", body},
            {~c"personality.md", "body-#{name}"},
            {~c"sprites/", "", mode_record(dir, :directory, 0o040000, 0)}
            | sprites
          ]

        :abort ->
          [
            {~c"manifest.json", body, unreadable},
            {String.to_charlist(String.duplicate("n", 300)), "x"}
          ]
      end

    {:ok, _} = :zip.create(String.to_charlist(Path.join(dir, "#{name}.zip")), entries)
    :ok
  end

  defp mode_record(dir, type, mode, size) do
    probe = Path.join(dir, "_mode_probe")
    File.write!(probe, "x")
    stat = %{File.stat!(probe) | type: type, mode: mode, size: size}
    File.rm!(probe)
    File.Stat.to_record(stat)
  end

  # 実装が退行すると mode 0 のディレクトリが tmp_dir に残り、ExUnit が次回
  # 起動時に走らせる `File.rm_rf!/1` が降りられずに落ちる — つまりそのテストが
  # 二度と走らなくなる。退行の報告は 1 回で済ませたいので、後片付けで必ず
  # 広げておく。ファイルの mode は unlink に効かないのでディレクトリだけでよい。
  defp widen_dir_modes(path) do
    case File.lstat(path) do
      {:ok, %File.Stat{type: :directory}} ->
        File.chmod(path, 0o700)

        case File.ls(path) do
          {:ok, names} -> Enum.each(names, &widen_dir_modes(Path.join(path, &1)))
          {:error, _} -> :ok
        end

      _ ->
        :ok
    end
  end

  # 仕掛けが本当に仕掛けとして働いているかの確認。`:zip.unzip/2` が宣言 mode を
  # 復元しなくなったら、下のアサーションは「元から制限が無かった」だけで通って
  # しまう (レビュー: premise を検査していない回帰テストは空回りする)。
  defp assert_declared_mode_survives(tmp, zip, entry) do
    out = Path.join(tmp, "premise_#{System.unique_integer([:positive])}")
    File.mkdir_p!(out)

    assert {:ok, _files} = :zip.unzip(String.to_charlist(zip), cwd: String.to_charlist(out)),
           "仕掛けた zip の展開自体が失敗した — premise の検査になっていない"

    on_exit(fn -> File.chmod(Path.join(out, entry), 0o700) end)

    assert {:ok, %File.Stat{mode: mode}} = File.lstat(Path.join(out, entry))

    assert Bitwise.band(mode, 0o777) == 0,
           "#{entry} が mode #{Integer.to_string(mode, 8)} で展開された — " <>
             "OTP がアーカイブ宣言の mode を復元しなくなった可能性がある"
  end

  defp base_manifest(id, overrides \\ %{}) do
    Map.merge(
      %{
        "id" => id,
        "name" => "name-#{id}",
        "sprite_set" => id,
        "version" => "1.0.0",
        "license" => "CC-BY-4.0",
        "min_kaoiro_version" => "0.1.0",
        "states" => @states,
        "description" => "d-#{id}"
      },
      overrides
    )
  end

  defp use_ingest(dir) do
    Application.put_env(:kaoiro_server, :persona_dir, dir)
    PersonaAssets.rebuild()
  end

  @tag :tmp_dir
  test "1 pack を取り込んで manifest と personality を返す", %{tmp_dir: tmp} do
    :ok = write_pack(tmp, "ao-1.0.0", base_manifest("ao"), "body-ao")
    use_ingest(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()
    assert Map.keys(personas) == ["ao"]
    entry = personas["ao"]
    assert entry["name"] == "name-ao"
    assert entry["pack_version"] == "1.0.0"
    assert entry["description"] == "d-ao"
    assert Map.keys(entry["states"]) |> Enum.sort() == Enum.sort(@states)

    assert PersonaAssets.known_persona?("ao")

    assert PersonaAssets.prompt("ao") ==
             "body-ao\n\n" <> FooterAssets.built_in_system_footer()
  end

  @tag :tmp_dir
  test "reserved default は pack 不要で known / footer のみが prompt", %{tmp_dir: tmp} do
    use_ingest(tmp)

    assert PersonaAssets.known_persona?("default")
    assert PersonaAssets.prompt("default") == FooterAssets.built_in_system_footer()
    refute PersonaAssets.known_persona?("unknown")
    assert PersonaAssets.prompt("unknown") == nil
  end

  # ADR-0045 F2: personality → system-footer → user-footer を空行で連結。
  @tag :tmp_dir
  test "prompt は personality → system → user の 3 層を空行で結合する", %{tmp_dir: tmp} do
    footer_dir = Path.join(tmp, "footers")
    File.mkdir_p!(footer_dir)
    File.write!(Path.join(footer_dir, "system-footer.md"), "system 層")
    File.write!(Path.join(footer_dir, "user-footer.md"), "user 層")

    original_footer_dir = Application.get_env(:kaoiro_server, :footer_dir)

    on_exit(fn ->
      if original_footer_dir == nil do
        Application.delete_env(:kaoiro_server, :footer_dir)
      else
        Application.put_env(:kaoiro_server, :footer_dir, original_footer_dir)
      end

      FooterAssets.rebuild()
    end)

    Application.put_env(:kaoiro_server, :footer_dir, footer_dir)
    :ok = FooterAssets.rebuild()

    :ok = write_pack(tmp, "mm-1.0.0", base_manifest("mm"), "body-mm")
    use_ingest(tmp)

    assert PersonaAssets.prompt("mm") == "body-mm\n\nsystem 層\n\nuser 層"
    assert PersonaAssets.prompt("default") == "system 層\n\nuser 層"
  end

  @tag :tmp_dir
  test "manifest.id 'default' の pack は取り込み拒否", %{tmp_dir: tmp} do
    :ok = write_pack(tmp, "default-1.0.0", base_manifest("default"), "body")
    use_ingest(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()
    assert personas == %{}
  end

  @tag :tmp_dir
  test "manifest 必須フィールド欠落は skip", %{tmp_dir: tmp} do
    :ok =
      write_pack(
        tmp,
        "broken-1.0.0",
        base_manifest("broken") |> Map.delete("license"),
        "body"
      )

    :ok = write_pack(tmp, "ok-1.0.0", base_manifest("ok"), "body-ok")
    use_ingest(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()
    assert Map.keys(personas) == ["ok"]
  end

  @tag :tmp_dir
  test "sprites/ の PNG が 1 枚欠けても pack ごと skip", %{tmp_dir: tmp} do
    # Build a valid pack directory, then delete one PNG before zipping to
    # exercise the sprite check (the write_pack helper is complete by
    # design).
    src = Path.join(tmp, "_stage_partial")
    File.mkdir_p!(Path.join(src, "sprites"))
    File.write!(Path.join(src, "manifest.json"), Jason.encode!(base_manifest("partial")))
    File.write!(Path.join(src, "personality.md"), "body")

    for state <- @states, state != "error" do
      File.write!(Path.join([src, "sprites", "#{state}.png"]), "x")
    end

    files =
      ["manifest.json", "personality.md" | Enum.map(@states -- ["error"], &"sprites/#{&1}.png")]
      |> Enum.map(&String.to_charlist/1)

    {:ok, _} =
      :zip.create(
        String.to_charlist(Path.join(tmp, "partial-1.0.0.zip")),
        files,
        cwd: String.to_charlist(src)
      )

    File.rm_rf!(src)
    use_ingest(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()
    refute Map.has_key?(personas, "partial")
  end

  @tag :tmp_dir
  test "min_kaoiro_version が server より高い pack は skip", %{tmp_dir: tmp} do
    :ok =
      write_pack(
        tmp,
        "future-1.0.0",
        base_manifest("future", %{"min_kaoiro_version" => "999.0.0"}),
        "body"
      )

    use_ingest(tmp)
    %{"personas" => personas} = PersonaAssets.manifest()
    refute Map.has_key?(personas, "future")
  end

  @tag :tmp_dir
  test "同 id の重複は先勝ちで 1 件だけ通す", %{tmp_dir: tmp} do
    :ok = write_pack(tmp, "aa-1.0.0", base_manifest("dup"), "first")
    # Second zip has the same manifest.id but a bumped version to force
    # a distinct content hash / extraction dir.
    :ok = write_pack(tmp, "zz-2.0.0", base_manifest("dup", %{"version" => "2.0.0"}), "second")
    use_ingest(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()
    assert Map.keys(personas) == ["dup"]
    # Sorted zip listing means the first-alphabetical (`aa-`) wins.
    assert PersonaAssets.prompt("dup") =~ "first"
  end

  @tag :tmp_dir
  test "fetch_file はマニフェスト掲載ファイルのみ解決する", %{tmp_dir: tmp} do
    :ok = write_pack(tmp, "kk-1.0.0", base_manifest("kk"), "body")
    use_ingest(tmp)

    assert {:ok, %{path: path, hash: hash}} =
             PersonaAssets.fetch_file("kk", "idle.png")

    assert File.exists?(path)
    assert hash =~ ~r/^[0-9a-f]{64}$/
    assert :error = PersonaAssets.fetch_file("kk", "missing.png")
    assert :error = PersonaAssets.fetch_file("..", "idle.png")
  end

  @tag :tmp_dir
  test "url とハッシュが content-addressed 形式に従う", %{tmp_dir: tmp} do
    :ok = write_pack(tmp, "cc-1.0.0", base_manifest("cc"), "body")
    use_ingest(tmp)

    %{"version" => version, "personas" => personas} = PersonaAssets.manifest()
    assert version =~ ~r/^[0-9a-f]{16}$/

    %{"url" => url, "hash" => "sha256:" <> hex} =
      personas["cc"]["states"]["idle"]

    assert hex =~ ~r/^[0-9a-f]{64}$/
    assert url == "/personas/cc/idle.png?v=#{String.slice(hex, 0, 12)}"
  end

  @tag :tmp_dir
  test "version はアセット内容の変化で変わる", %{tmp_dir: tmp} do
    :ok = write_pack(tmp, "vv-1.0.0", base_manifest("vv"), "body")
    use_ingest(tmp)
    %{"version" => before_version} = PersonaAssets.manifest()

    # Replace with a bumped pack that flips sprite bytes (write_pack's
    # deterministic sprite content includes the pack name, so a new zip
    # basename changes the bytes).
    File.rm!(Path.join(tmp, "vv-1.0.0.zip"))
    :ok = write_pack(tmp, "vv-2.0.0", base_manifest("vv", %{"version" => "2.0.0"}), "body")
    PersonaAssets.rebuild()
    %{"version" => after_version} = PersonaAssets.manifest()

    refute before_version == after_version
  end

  @tag :tmp_dir
  test "存在しない ingest dir でも起動できる (空 manifest)", %{tmp_dir: tmp} do
    use_ingest(Path.join(tmp, "nonexistent"))

    %{"personas" => personas} = PersonaAssets.manifest()
    assert personas == %{}
    # default は pack 不要で常に known。
    assert PersonaAssets.known_persona?("default")
  end

  # --- extraction cache の外出し (ADR-0046 / #183) ---

  @tag :tmp_dir
  test "ingest dir へは一切書き込まない (:ro でも rebuild が通る)", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "ro-1.0.0", base_manifest("ro"), "body-ro")

    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(tmp, "cache"))
    File.chmod!(ingest, 0o500)
    on_exit(fn -> File.chmod(ingest, 0o700) end)

    use_ingest(ingest)

    %{"personas" => personas} = PersonaAssets.manifest()
    assert Map.keys(personas) == ["ro"]
    assert PersonaAssets.prompt("ro") =~ "body-ro"
    refute File.exists?(Path.join(ingest, ".cache"))
  end

  @tag :tmp_dir
  test "既定 cache path は expand 後の ingest dir から導出する", %{tmp_dir: tmp} do
    Application.delete_env(:kaoiro_server, :persona_cache_dir)
    ingest = Path.join(tmp, "packs")
    File.mkdir_p!(ingest)

    Application.put_env(:kaoiro_server, :persona_dir, ingest)
    expected = PersonaAssets.cache_dir()

    assert Path.dirname(expected) == System.tmp_dir!() |> Path.expand()
    assert Path.basename(expected) =~ ~r/^kaoiro-persona-cache-[0-9a-f]{16}$/

    # 相対要素や末尾スラッシュで namespace が揺れない (ADR-0046 F1)。
    for equivalent <- [
          Path.join(tmp, "./packs"),
          Path.join(tmp, "packs/"),
          Path.join(tmp, "packs/sub/..")
        ] do
      Application.put_env(:kaoiro_server, :persona_dir, equivalent)
      assert PersonaAssets.cache_dir() == expected
    end
  end

  @tag :tmp_dir
  test "reclaim は cache-key 形式の entry だけを消す", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    File.mkdir_p!(cache)
    :ok = write_pack(ingest, "rc-1.0.0", base_manifest("rc"), "body-rc")

    # 無関係な dir/file と、live でない cache-key 形式の dir を並べる。
    bystanders = ["important-data", "0123456789abcde", "0123456789abcdefg", "not_hex_16chars_"]
    for name <- bystanders, do: File.mkdir_p!(Path.join(cache, name))
    File.write!(Path.join(cache, "notes.txt"), "keep me")
    stale = Path.join(cache, String.duplicate("a", 16))
    File.mkdir_p!(stale)

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    use_ingest(ingest)

    refute File.exists?(stale), "live でない cache-key dir は消えるべき"
    assert File.exists?(Path.join(cache, "notes.txt"))

    for name <- bystanders do
      assert File.exists?(Path.join(cache, name)), "#{name} を消してはいけない"
    end
  end

  @tag :tmp_dir
  test "cold start で cache root が作れなければ raise する", %{tmp_dir: tmp} do
    parent = Path.join(tmp, "locked")
    File.mkdir_p!(parent)
    File.chmod!(parent, 0o500)
    on_exit(fn -> File.chmod(parent, 0o700) end)

    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(parent, "cache"))
    Application.put_env(:kaoiro_server, :persona_dir, tmp)

    # cold start = persistent_term に cache が無い状態。
    :persistent_term.erase({PersonaAssets, :cache})

    assert_raise RuntimeError, ~r/cold start.*cache dir unusable/, fn ->
      PersonaAssets.rebuild()
    end
  end

  # ふじ裁定 (2026-08-03): 明示 root は強制 chmod せず warning に留める。
  @tag :tmp_dir
  test "group/world-writable な明示 root は warn するが mode は変えない", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    File.mkdir_p!(cache)
    File.chmod!(cache, 0o777)
    :persistent_term.erase({PersonaAssets, :warned_cache_root})

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)

    log = capture_log(fn -> use_ingest(ingest) end)

    assert log =~ "group/world-writable"
    assert log =~ "mode 777"

    %File.Stat{mode: mode} = File.stat!(cache)
    assert Bitwise.band(mode, 0o7777) == 0o777, "明示 root の mode を変えてはいけない"

    # 同じ root/mode では鳴り続けない。
    refute capture_log(fn -> PersonaAssets.rebuild() end) =~ "group/world-writable"
  end

  @tag :tmp_dir
  test "既定 root は 0700 へ落とす", %{tmp_dir: tmp} do
    Application.delete_env(:kaoiro_server, :persona_cache_dir)
    ingest = Path.join(tmp, "packs")
    File.mkdir_p!(ingest)
    Application.put_env(:kaoiro_server, :persona_dir, ingest)

    default_root = PersonaAssets.cache_dir()
    File.mkdir_p!(default_root)
    File.chmod!(default_root, 0o777)
    on_exit(fn -> File.rm_rf(default_root) end)

    PersonaAssets.rebuild()

    %File.Stat{mode: mode} = File.stat!(default_root)
    assert Bitwise.band(mode, 0o7777) == 0o700
  end

  @tag :tmp_dir
  test "cache root が symlink なら unusable として弾く", %{tmp_dir: tmp} do
    real = Path.join(tmp, "real")
    File.mkdir_p!(real)
    link = Path.join(tmp, "linked-cache")
    :ok = File.ln_s(real, link)

    Application.put_env(:kaoiro_server, :persona_cache_dir, link)
    Application.put_env(:kaoiro_server, :persona_dir, tmp)
    :persistent_term.erase({PersonaAssets, :cache})

    assert_raise RuntimeError, ~r/not_a_directory/, fn -> PersonaAssets.rebuild() end
  end

  # --- cache infra error と pack validation error の分離 (ふじ M1) ---

  # `:zip.unzip` の書き込み失敗は通常の FS では決定論的に作れない
  # (ensure_cache_dir の probe が root の writable を先に証明するので、
  # 残るのは disk full か rebuild 途中の remount だけ)。実際に OTP が返す
  # term を実測で固定し、分類器へ直接通す。
  describe "classify_zip_error/2" do
    @tag :tmp_dir
    test "cache 配下への書き込み不能 (:eacces) は cache_error", %{tmp_dir: tmp} do
      zip = build_zip(tmp, "z1")
      cache = Path.join(tmp, "cache")
      target = Path.join(cache, "abcdef0123456789")
      File.mkdir_p!(target)
      File.chmod!(target, 0o500)
      on_exit(fn -> File.chmod(target, 0o700) end)

      reason = unzip_error(zip, target)

      # OTP がこの形を返すこと自体の回帰テスト (末端の posix atom が
      # 分類の唯一の手掛かりなので、形が変わったら気付く必要がある)。
      assert {_path, {{:file, :open, _args}, :eacces}} = reason
      assert {:cache_error, message} = PersonaAssets.classify_zip_error(reason, cache)
      assert message =~ "unzip failed writing the cache"
    end

    # ふじ S1 (2 巡目): root そのものを指す error path が「配下でない」と
    # 誤判定されて pack error に落ちていた。
    test "error path が cache root そのものでも cache_error" do
      reason = {~c"/cache", {{:file, :open, []}, :eacces}}

      assert {:cache_error, _} = PersonaAssets.classify_zip_error(reason, "/cache")
      assert {:cache_error, _} = PersonaAssets.classify_zip_error(reason, "/cache/")
    end

    test "兄弟 path (/cache-old) は cache root 配下と見なさない" do
      reason = {~c"/cache-old/x", {{:file, :open, []}, :eacces}}

      assert {:error, _} = PersonaAssets.classify_zip_error(reason, "/cache")
    end

    test "error path が binary で来ても解釈する" do
      reason = {"/cache/x", {{:file, :open, []}, :eacces}}

      assert {:cache_error, _} = PersonaAssets.classify_zip_error(reason, "/cache")
    end

    @tag :tmp_dir
    test "cache 外の :eacces (source zip が読めない等) は pack error", %{tmp_dir: tmp} do
      zip = build_zip(tmp, "z2")
      outside = Path.join(tmp, "elsewhere")
      File.mkdir_p!(outside)
      File.chmod!(outside, 0o500)
      on_exit(fn -> File.chmod(outside, 0o700) end)

      reason = unzip_error(zip, outside)

      assert {:error, _} = PersonaAssets.classify_zip_error(reason, Path.join(tmp, "cache"))
    end

    @tag :tmp_dir
    test "壊れた zip (:einval) は pack error のまま", %{tmp_dir: tmp} do
      broken = Path.join(tmp, "broken.zip")
      File.write!(broken, "this is not a zip archive")
      target = Path.join(tmp, "out")
      File.mkdir_p!(target)

      reason = unzip_error(broken, target)

      assert {:error, message} = PersonaAssets.classify_zip_error(reason, target)
      assert message =~ "unzip failed"
    end

    # アーカイブの中身が原因の errno を cache 障害へ倒すと、不正 zip 1 本で
    # rebuild が止まり cold start が raise する。:enotdir / :eloop は必ず
    # pack error 側であること。
    test "アーカイブ形状由来の errno は cache_error にしない" do
      for errno <- [:enotdir, :eloop, :eisdir, :einval, :enoent] do
        reason = {~c"/cache/0123456789abcdef/x", {{:file, :open, []}, errno}}

        assert {:error, _} = PersonaAssets.classify_zip_error(reason, "/cache"),
               "#{errno} を cache_error に分類してはいけない"
      end
    end

    # 上は合成 term。こちらは OTP に実際に壊れたアーカイブを食わせて term を
    # 取り、分類まで通す。posix_in?/2 が term を無制限に走査してよい根拠が
    # 「アーカイブ形状由来の term には cache 側 errno atom が現れない」こと
    # なので、その前提が OTP 更新で崩れたらここが最初に落ちる。
    @tag :tmp_dir
    test "実測: アーカイブ形状由来の失敗はどれも cache_error にならない", %{tmp_dir: tmp} do
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(cache)
      cl = &String.to_charlist/1

      collide = Path.join(tmp, "collide.zip")
      {:ok, _} = :zip.create(cl.(collide), [{~c"a", "x"}, {~c"a/b", "y"}])

      long_name = Path.join(tmp, "long.zip")
      {:ok, _} = :zip.create(cl.(long_name), [{cl.(String.duplicate("n", 300)), "x"}])

      garbage = Path.join(tmp, "garbage.zip")
      File.write!(garbage, :crypto.strong_rand_bytes(512))

      valid = Path.join(tmp, "valid.zip")
      {:ok, _} = :zip.create(cl.(valid), [{~c"a.txt", "hello"}])
      truncated = Path.join(tmp, "truncated.zip")
      File.write!(truncated, binary_part(File.read!(valid), 0, 40))

      for zip <- [collide, long_name, garbage, truncated] do
        out = Path.join(cache, "out_#{System.unique_integer([:positive])}")
        File.mkdir_p!(out)

        assert {:error, reason} = :zip.unzip(cl.(zip), cwd: cl.(out))

        assert {:error, _} = PersonaAssets.classify_zip_error(reason, cache),
               "#{Path.basename(zip)}: #{inspect(reason, limit: 4)} を cache_error にしてはいけない"
      end
    end
  end

  defp build_zip(dir, name) do
    src = Path.join(dir, "_zipsrc_" <> name)
    File.mkdir_p!(src)
    File.write!(Path.join(src, "a.txt"), "hello")
    zip = Path.join(dir, "#{name}.zip")

    {:ok, _} =
      :zip.create(String.to_charlist(zip), [~c"a.txt"], cwd: String.to_charlist(src))

    zip
  end

  defp unzip_error(zip, target) do
    {:error, reason} =
      :zip.unzip(String.to_charlist(zip), cwd: String.to_charlist(target))

    reason
  end

  # cache 内の展開物が読めなくなった場合、以前は cache_error に倒して LKG を
  # 維持していた。normalize_modes/1 の導入後は rebuild の冒頭で mode が戻され、
  # そのまま読み直される。「manifest が変わらない」だけでは修復と LKG 据え置きが
  # 区別できず空振りになるので (レビュー R2)、修復されたことを直接見る。
  # cache_error → LKG 維持の契約自体は下の cache root テストと
  # classify_cache_read/3 の単体テストで張る。
  for {label, target} <- [
        {"manifest.json", "manifest.json"},
        {"personality.md", "personality.md"},
        {"sprites/", "sprites"}
      ] do
    @tag :tmp_dir
    test "cache 内 #{label} が読めなくなっても rebuild が mode を戻して読み直す",
         %{tmp_dir: tmp} do
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      on_exit(fn -> widen_dir_modes(tmp) end)
      :ok = write_pack(ingest, "ce-1.0.0", base_manifest("ce"), "body-ce")

      Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
      use_ingest(ingest)
      assert Map.keys(PersonaAssets.manifest()["personas"]) == ["ce"]

      blocked =
        cache
        |> Path.join("*/#{unquote(target)}")
        |> Path.wildcard()
        |> hd()

      File.chmod!(blocked, 0o000)

      log = capture_log(fn -> assert :ok = PersonaAssets.rebuild() end)

      refute log =~ "unreadable in the cache"
      assert Map.keys(PersonaAssets.manifest()["personas"]) == ["ce"]

      assert {:ok, %File.Stat{mode: mode, type: type}} = File.lstat(blocked)
      needed = if type == :directory, do: 0o500, else: 0o400

      assert Bitwise.band(mode, needed) == needed,
             "#{blocked} が mode #{Integer.to_string(mode, 8)} のまま残っている"
    end
  end

  # 上の統合テストが修復側を張るようになったので、cache_error 側の契約は
  # ここで直接固定する (実際のボリューム障害は fault injection なしには
  # 起こせない)。分類を緩めると 1 本の不正 pack が全体を止める側へ倒れる。
  # cache slot を消せない理由の切り分け。他ユーザ所有のディレクトリを作るには
  # 2 つ目の OS ユーザが要り単一ユーザのテストでは再現できないので、判定だけを
  # ここで固定する。緩めると仕込まれた 1 ディレクトリで全体が止まる。
  # ふじ M1/S2: 元 error と後片付け error の優先順位。cache 障害はどちら側に
  # あっても勝たないと、「pack を 1 本 skip した」形で build が続き、欠けた
  # manifest を公開してしまう。純関数なので表を直接張る (この状況を作るには
  # 壊れたボリュームが要り、単一ユーザのテストでは組めない)。
  describe "merge_cleanup_error/2" do
    test "cache 障害はどちら側にあっても勝つ" do
      pack = {:error, "pack"}
      volume = {:cache_error, "volume"}
      cleanup_pack = {:error, "cleanup"}
      cleanup_volume = {:cache_error, "cleanup"}

      assert PersonaAssets.merge_cleanup_error(pack, :ok) == pack
      assert PersonaAssets.merge_cleanup_error(pack, cleanup_pack) == pack
      assert PersonaAssets.merge_cleanup_error(pack, cleanup_volume) == cleanup_volume
      assert PersonaAssets.merge_cleanup_error(volume, :ok) == volume
      assert PersonaAssets.merge_cleanup_error(volume, cleanup_pack) == volume
      assert PersonaAssets.merge_cleanup_error(volume, cleanup_volume) == volume
    end
  end

  # ふじ M1 (2 巡目): discard→mkdir の窓で slot が「既存ディレクトリへの
  # symlink」として再占有されると、File.mkdir_p/1 は :ok を返し、続く chmod と
  # 展開がリンク先を辿る (ふじ実機再現: リンク先が 0700 に狭窄され、中に
  # manifest.json まで書かれた)。exclusive な File.mkdir/1 なら symlink でも
  # ディレクトリでも :eexist で、何も書く前に止まる。lstat で確かめる形では
  # check/use race が残るので不可。
  #
  # 「展開前に 0700」の順序も、別 UID の CI が無い以上ここで直接張るのが実効的
  # (ふじ助言)。
  describe "prepare_slot/2" do
    @tag :tmp_dir
    test "既存ディレクトリへの symlink はリンク先に触れず pack error", %{tmp_dir: tmp} do
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(cache)
      target = Path.join(tmp, "outside")
      File.mkdir_p!(target)
      File.chmod!(target, 0o755)
      slot = Path.join(cache, "0123456789abcdef")
      File.ln_s!(target, slot)

      assert {:error, message} = PersonaAssets.prepare_slot(slot, cache)
      assert message =~ "cache slot operation failed"

      # リンク先が狭窄されていないこと、中に何も書かれていないこと。
      assert {:ok, %File.Stat{mode: mode}} = File.lstat(target)
      assert Bitwise.band(mode, 0o777) == 0o755
      assert {:ok, []} = File.ls(target)

      # slot 自体も symlink のまま (辿って作り替えていない)。
      assert {:ok, %File.Stat{type: :symlink}} = File.lstat(slot)
    end

    @tag :tmp_dir
    test "空いている slot は 0700 で作られる", %{tmp_dir: tmp} do
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(cache)
      slot = Path.join(cache, "0123456789abcdef")

      assert :ok = PersonaAssets.prepare_slot(slot, cache)

      assert {:ok, %File.Stat{type: :directory, mode: mode}} = File.lstat(slot)

      assert Bitwise.band(mode, 0o777) == 0o700,
             "展開前に owner-only へ狭窄されていない (mode #{Integer.to_string(mode, 8)})"
    end

    @tag :tmp_dir
    test "既に実ディレクトリが居る slot も pack error", %{tmp_dir: tmp} do
      cache = Path.join(tmp, "cache")
      slot = Path.join(cache, "0123456789abcdef")
      File.mkdir_p!(slot)

      assert {:error, _} = PersonaAssets.prepare_slot(slot, cache)
    end
  end

  describe "classify_discard/3" do
    # ADR-0046 F4 の errno 表は読み替えず、cache root がまだ書けるかで切り分ける。
    # 実測: 非空ディレクトリの書き込みビットが無いと rm_rf は :eexist を返して
    # ツリーが残る (ファイル単体なら :eacces / :eperm)。これは他ユーザが置いた
    # slot でも起きるので、errno だけで cache 障害へ倒すと 1 ディレクトリで
    # 全体が止まる。
    test "cache root がまだ書けるなら該当 pack だけ skip" do
      for reason <- [:eexist, :eacces, :eperm, :enotdir] do
        assert {:error, message} =
                 PersonaAssets.classify_discard(reason, "/cache/0123456789abcdef", :ok)

        assert message =~ "cache slot operation failed"
      end
    end

    # F4 の errno 表は slot 固有の理由にしか譲らない。slot だけの I/O 障害や
    # stale NFS handle は root を無傷で残すので、probe が通っても pack skip に
    # 倒すと「pack が黙って欠けた manifest」を公開してしまう。
    test "slot 固有でない errno は root が書けても cache_error" do
      for reason <- [:eio, :estale, :enospc, :erofs, :enomem] do
        assert {:cache_error, _} =
                 PersonaAssets.classify_discard(reason, "/cache/0123456789abcdef", :ok),
               "#{reason} は root が書けても cache_error であるべき"
      end
    end

    test "cache root ごと書けないなら cache_error" do
      for reason <- [:eacces, :erofs, :eio, :eexist] do
        assert {:cache_error, _} =
                 PersonaAssets.classify_discard(
                   reason,
                   "/cache/0123456789abcdef",
                   {:error, :erofs}
                 ),
               "root が死んでいるなら #{reason} は cache_error であるべき"
      end
    end
  end

  describe "classify_cache_read/3" do
    test "cache 側の errno は cache_error" do
      for errno <- [:eacces, :erofs, :eio, :enospc, :enomem] do
        assert {:cache_error, message} =
                 PersonaAssets.classify_cache_read("manifest.json", "/cache/x", errno)

        assert message =~ "unreadable in the cache"
      end
    end

    test "pack 側の errno は pack error のまま" do
      for errno <- [:enoent, :eisdir, :enotdir, :eloop, :einval] do
        assert {:error, _} = PersonaAssets.classify_cache_read("manifest.json", "/cache/x", errno),
               "#{errno} を cache_error に分類してはいけない"
      end
    end
  end

  @tag :tmp_dir
  test "壊れた zip 1 本は他の pack を巻き込まず skip される", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")
    File.write!(Path.join(ingest, "bad-1.0.0.zip"), "not a zip archive")

    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(tmp, "cache"))
    use_ingest(ingest)

    # cache_error なら build 全体が止まって空 manifest のままになる。
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]
  end

  # entry 名が自己衝突する zip (`a` と `a/b/c`) は展開中に :enotdir を出す。
  # これを cache 障害に倒すと、ingest dir にそれを置くだけで cold start が
  # raise し、稼働中も rebuild が永久に失敗する (可用性の DoS)。
  @tag :tmp_dir
  test "entry が自己衝突する zip は skip され、cold start も通る", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")
    write_colliding_zip(Path.join(ingest, "zcollide-1.0.0.zip"))

    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(tmp, "cache"))
    Application.put_env(:kaoiro_server, :persona_dir, ingest)
    :persistent_term.erase({PersonaAssets, :cache})

    # cold start でも raise しないこと (PersonaRebuildLock.init/1 の warm
    # rebuild が :ok を assert する)。
    assert :ok = PersonaAssets.rebuild()
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]
  end

  @tag :tmp_dir
  test "sprites が通常ファイルの pack は skip される (:enotdir)", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    src = Path.join(tmp, "_stage_flat")
    File.mkdir_p!(ingest)
    File.mkdir_p!(src)
    File.write!(Path.join(src, "manifest.json"), Jason.encode!(base_manifest("flat")))
    File.write!(Path.join(src, "personality.md"), "body")
    File.write!(Path.join(src, "sprites"), "a regular file, not a dir")

    {:ok, _} =
      :zip.create(
        String.to_charlist(Path.join(ingest, "flat-1.0.0.zip")),
        Enum.map(["manifest.json", "personality.md", "sprites"], &String.to_charlist/1),
        cwd: String.to_charlist(src)
      )

    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")
    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(tmp, "cache"))
    use_ingest(ingest)

    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]
  end

  # zip slip (CWE-22): `..` を含むエントリ名は cwd の外を指す。ADR-0046 で
  # cache が認証 DETS 台帳と同じ volume に載ったので、逸脱の blast radius が
  # 失効リストまで届く。
  #
  # 実測 (OTP 29.0.2 / stdlib 8.0.1) では :zip.unzip 自身も "Illegal path"
  # で拒否するので、「外にファイルが出ない」だけを見ても guard の有無を
  # 区別できない (展開先 dir も reclaim が掃除してしまう)。防御が発動した
  # ことの観測点は skip 理由のログなので、そこを固定する — OTP 任せに
  # 退行したらメッセージが "unzip failed" に変わって落ちる。
  @tag :tmp_dir
  test "extraction dir の外へ出る entry を持つ pack は展開前に拒否する", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    victim = Path.join(tmp, "token_denylist.dets")
    File.mkdir_p!(ingest)
    File.write!(victim, "original ledger")

    write_escaping_zip(Path.join(ingest, "evil-1.0.0.zip"), "../../token_denylist.dets")
    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    log = capture_log(fn -> use_ingest(ingest) end)

    assert log =~ "skip persona pack evil-1.0.0.zip: entry escapes the extraction dir"
    assert File.read!(victim) == "original ledger", "cache の外へ書き出された"
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]
  end

  # ZIP は名前を central directory と local header の 2 箇所に持ち、
  # `:zip.list_dir/1` は前者、`:zip.unzip/2` は後者で動く。central だけを
  # 見る guard は、central=safe / local=逸脱 の zip で素通りする
  # (ふじ M1 2 巡目、実機再現済み)。
  @tag :tmp_dir
  test "central と local で名前が食い違う pack は展開前に拒否する", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)

    File.write!(
      Path.join(ingest, "lslip-1.0.0.zip"),
      mismatched_zip("../../kaoiro-local-slip", "safe.txt", "PWNED")
    )

    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    log = capture_log(fn -> use_ingest(ingest) end)

    # 事前検証固有かつ local header を読んだ証拠になるメッセージ。central
    # だけを見る実装や OTP 任せへ退行すると出ない (後者は "unzip failed")。
    assert log =~
             "skip persona pack lslip-1.0.0.zip: " <>
               "entry escapes the extraction dir (local header): \"../../kaoiro-local-slip\""

    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]

    refute Enum.any?(Path.wildcard(Path.join(cache, "**"), match_dot: true), fn path ->
             Path.basename(path) == "kaoiro-local-slip"
           end)
  end

  # 展開前に弾いていることの直接確認 (E2E だけだと reclaim_cache が
  # 中途半端な展開先を消してしまい、guard 有無の痕跡が残らない)。
  @tag :tmp_dir
  test "verify_entry_names/1 は central・local の両方を検証する", %{tmp_dir: tmp} do
    ok_zip = Path.join(tmp, "ok.zip")
    File.write!(ok_zip, mismatched_zip("a.txt", "a.txt", "body"))
    assert :ok = PersonaAssets.verify_entry_names(ok_zip)

    central_bad = Path.join(tmp, "central.zip")
    File.write!(central_bad, mismatched_zip("../x", "../x", "body"))
    assert {:error, msg} = PersonaAssets.verify_entry_names(central_bad)
    assert msg =~ "central directory"

    local_bad = Path.join(tmp, "local.zip")
    File.write!(local_bad, mismatched_zip("../x", "safe.txt", "body"))
    assert {:error, msg} = PersonaAssets.verify_entry_names(local_bad)
    assert msg =~ "escapes the extraction dir (local header)" or msg =~ "entry name mismatch"

    mismatch = Path.join(tmp, "mismatch.zip")
    File.write!(mismatch, mismatched_zip("b.txt", "a.txt", "body"))
    assert {:error, msg} = PersonaAssets.verify_entry_names(mismatch)
    assert msg =~ "entry name mismatch"
  end

  # `:zip.create/3` は実ファイルからしか作れず `..` 名を通さないので、
  # zip を手組みする (store 無圧縮の最小構成)。
  defp write_escaping_zip(path, entry_name) do
    File.write!(path, minimal_zip(entry_name, "pwned"))
  end

  # local header と central directory に別々の名前を書く 1 entry zip。
  defp mismatched_zip(local_name, central_name, body) do
    crc = :erlang.crc32(body)
    size = byte_size(body)
    ln = byte_size(local_name)
    cn = byte_size(central_name)

    local =
      <<0x04034B50::little-32, 20::little-16, 0::little-16, 0::little-16, 0::little-16,
        0::little-16, crc::little-32, size::little-32, size::little-32, ln::little-16,
        0::little-16>> <> local_name <> body

    central =
      <<0x02014B50::little-32, 20::little-16, 20::little-16, 0::little-16, 0::little-16,
        0::little-16, 0::little-16, crc::little-32, size::little-32, size::little-32,
        cn::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-32,
        0::little-32>> <> central_name

    eocd =
      <<0x06054B50::little-32, 0::little-16, 0::little-16, 1::little-16, 1::little-16,
        byte_size(central)::little-32, byte_size(local)::little-32, 0::little-16>>

    local <> central <> eocd
  end

  defp write_colliding_zip(path) do
    # `a` を通常ファイルとして書いたあと `a/b` を要求する。展開側は
    # `a/` を作ろうとして :enotdir になる。
    File.write!(path, multi_entry_zip([{"a", "x"}, {"a/b", "y"}]))
  end

  defp minimal_zip(name, body), do: multi_entry_zip([{name, body}])

  # Store-only (無圧縮) zip を素で組む。local header → central directory →
  # EOCD の最小形。
  defp multi_entry_zip(entries) do
    {locals, centrals, _offset} =
      Enum.reduce(entries, {[], [], 0}, fn {name, body}, {locals, centrals, offset} ->
        crc = :erlang.crc32(body)
        n = byte_size(name)
        size = byte_size(body)

        local =
          <<0x04034B50::little-32, 20::little-16, 0::little-16, 0::little-16, 0::little-16,
            0::little-16, crc::little-32, size::little-32, size::little-32, n::little-16,
            0::little-16>> <> name <> body

        central =
          <<0x02014B50::little-32, 20::little-16, 20::little-16, 0::little-16, 0::little-16,
            0::little-16, 0::little-16, crc::little-32, size::little-32, size::little-32,
            n::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-32,
            offset::little-32>> <> name

        {[local | locals], [central | centrals], offset + byte_size(local)}
      end)

    local_blob = locals |> Enum.reverse() |> IO.iodata_to_binary()
    central_blob = centrals |> Enum.reverse() |> IO.iodata_to_binary()
    count = length(entries)

    eocd =
      <<0x06054B50::little-32, 0::little-16, 0::little-16, count::little-16, count::little-16,
        byte_size(central_blob)::little-32, byte_size(local_blob)::little-32, 0::little-16>>

    local_blob <> central_blob <> eocd
  end

  # `:zip.unzip/2` はアーカイブが宣言した mode を復元するので、pack 側が
  # cache 内のパーミッションを支配できてしまう。mode 0 の manifest.json を
  # 仕込むと File.read が :eacces になり、それは「cache が本当に読めない」
  # ケースと区別がつかないため cache_error に倒れ、rebuild 全体が止まる
  # (修正前の実測: 同居する健全 pack が一切読み込まれず LKG が固定された。
  # cold start なら ADR-0046 F4 で raise する)。展開直後に mode を正規化して
  # pack から支配権を取り上げる。
  @tag :tmp_dir
  test "アーカイブ宣言の mode 0 は cache へ持ち込まれない", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    on_exit(fn -> widen_dir_modes(tmp) end)

    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")
    :ok = write_poisoned_pack(ingest, "evilfile-1.0.0", base_manifest("evilfile"), :manifest)
    :ok = write_poisoned_pack(ingest, "evildir-1.0.0", base_manifest("evildir"), :sprites_dir)

    # ファイルだけでなくディレクトリ経路も塞げていること。mode 0 の sprites/ は
    # collect_sprites の File.ls を :eacces にする = 同じ DoS の第 2 経路で、
    # 走査が top-down でなければ (mode 0 のディレクトリは列挙できない) 直せない。
    assert_declared_mode_survives(tmp, Path.join(ingest, "evilfile-1.0.0.zip"), "manifest.json")
    assert_declared_mode_survives(tmp, Path.join(ingest, "evildir-1.0.0.zip"), "sprites")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    use_ingest(ingest)

    # 仕掛けた側が skip されるかどうかではなく、同居 pack が巻き添えに
    # ならないことが要点。mode を落とせば evil 自体も正当な pack になる。
    assert Enum.sort(Map.keys(PersonaAssets.manifest()["personas"])) ==
             ["evildir", "evilfile", "good"]

    for path <- Path.wildcard(Path.join(cache, "**"), match_dot: true) do
      assert {:ok, %File.Stat{mode: mode, type: type}} = File.lstat(path)
      needed = if type == :directory, do: 0o500, else: 0o400

      assert Bitwise.band(mode, needed) == needed,
             "#{path} (#{type}) が mode #{Integer.to_string(mode, 8)} で残っている"
    end
  end

  # 共有 cache root に `<root>/<hash>` を symlink として置かれると、
  # File.dir?/1 も File.exists?/1 も辿ってしまい「展開済み」と見なされる。
  # 仕込まれた personality.md がそのペルソナの全プロンプトに載る = DoS では
  # なく注入なので、slot は lstat で実体を確かめる。
  @tag :tmp_dir
  test "cache slot が symlink なら信頼せず作り直す", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "sl-1.0.0", base_manifest("sl"), "body-sl")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    use_ingest(ingest)
    assert PersonaAssets.prompt("sl") =~ "body-sl"

    slot = cache |> Path.join("*") |> Path.wildcard() |> Enum.find(&File.dir?/1)

    planted = Path.join(tmp, "planted")
    File.cp_r!(slot, planted)
    File.write!(Path.join(planted, "personality.md"), "PLANTED")
    File.rm_rf!(slot)
    File.ln_s!(planted, slot)

    capture_log(fn -> assert :ok = PersonaAssets.rebuild() end)

    refute PersonaAssets.prompt("sl") =~ "PLANTED"
    assert PersonaAssets.prompt("sl") =~ "body-sl"
    assert {:ok, %File.Stat{type: :directory}} = File.lstat(slot)
  end

  # ふじ M2: slot 全体だけでなく、中のファイル 1 枚を symlink に差し替える経路も
  # 塞げていること。ふじは実 pack の personality.md を外部 symlink に置き換えて
  # prompt への注入を実再現している。
  @tag :tmp_dir
  test "slot 内のファイルが symlink なら信頼せず作り直す", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "in-1.0.0", base_manifest("in"), "body-in")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    use_ingest(ingest)
    assert PersonaAssets.prompt("in") =~ "body-in"

    slot = cache |> Path.join("*") |> Path.wildcard() |> Enum.find(&File.dir?/1)
    planted = Path.join(tmp, "planted.txt")
    File.write!(planted, "PLANTED")
    swapped = ["personality.md", "sprites/idle.png"]

    for target <- swapped do
      path = Path.join(slot, target)
      File.rm!(path)
      File.ln_s!(planted, path)
    end

    capture_log(fn -> assert :ok = PersonaAssets.rebuild() end)

    refute PersonaAssets.prompt("in") =~ "PLANTED"
    assert PersonaAssets.prompt("in") =~ "body-in"

    for target <- swapped do
      assert {:ok, %File.Stat{type: :regular}} = File.lstat(Path.join(slot, target))
    end
  end

  # 上とは別に切る必要がある。必須パスを差し替えると完成判定の側が先に再展開を
  # 強制してしまい、normalize_modes/1 の special type 拒否を分離できない。
  # 必須パスは無傷のまま余分な symlink を 1 本置く形なら、拒否だけが効く。
  @tag :tmp_dir
  test "必須パス以外の symlink でも slot を作り直す", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "ex-1.0.0", base_manifest("ex"), "body-ex")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    use_ingest(ingest)

    slot = cache |> Path.join("*") |> Path.wildcard() |> Enum.find(&File.dir?/1)
    planted = Path.join(tmp, "outside.txt")
    File.write!(planted, "PLANTED")
    extra = Path.join(slot, "extra.txt")
    File.ln_s!(planted, extra)

    capture_log(fn -> assert :ok = PersonaAssets.rebuild() end)

    assert PersonaAssets.prompt("ex") =~ "body-ex"

    assert {:error, :enoent} = File.lstat(extra),
           "必須パス以外の symlink が cache に残っている"
  end

  # ふじ S1: 完成判定が manifest.json の存在だけだったので、sprite を 1 枚
  # 失った tree が再展開されず、その pack だけ skip されて known_persona? が
  # false になっていた (partial extraction / SIGKILL でも同じ状態になる)。
  @tag :tmp_dir
  test "sprite が 1 枚欠けた cache は skip せず作り直す", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "mi-1.0.0", base_manifest("mi"), "body-mi")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    use_ingest(ingest)
    assert PersonaAssets.known_persona?("mi")

    slot = cache |> Path.join("*") |> Path.wildcard() |> Enum.find(&File.dir?/1)
    missing = Path.join([slot, "sprites", "idle.png"])
    File.rm!(missing)

    capture_log(fn -> assert :ok = PersonaAssets.rebuild() end)

    assert PersonaAssets.known_persona?("mi")
    assert {:ok, %File.Stat{type: :regular}} = File.lstat(missing)
  end

  # レビュー must-fix: `:zip.unzip/2` はエントリを書くたびに宣言 mode を適用
  # するので、展開が途中で失敗すると mode 0 の manifest.json だけが残る。
  # freshness check は stat ベースなのでそれを「完成した展開」と見なし、以後
  # 正規化が二度と走らない。同一バイトの zip を 2 本置くと 1 回の rebuild 内で
  # 決定的に踏める (2 本目が残骸を掴み cache_error → build 全体が停止 →
  # reclaim も走らないので自己増殖する)。
  @tag :tmp_dir
  test "展開が途中で失敗しても毒入りの残骸を掴まない", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)

    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")
    :ok = write_poisoned_pack(ingest, "abort-a", base_manifest("abort"), :abort)

    # 同一バイト = 同一 cache key。コピーで作らないと mtime 差で hash がずれる。
    File.cp!(Path.join(ingest, "abort-a.zip"), Path.join(ingest, "abort-b.zip"))

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    log = capture_log(fn -> use_ingest(ingest) end)

    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]
    refute log =~ "unreadable in the cache"

    # 2 巡目も同じ。残骸が残っていれば cache_error でここが空になる。
    capture_log(fn -> PersonaAssets.rebuild() end)
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]
  end

  # 展開済みの sprite が読めなくなった場合。以前は collect_sprites の bang が
  # raise して rebuild 失敗 → LKG 維持だったが、normalize_modes/1 が冒頭で
  # mode を戻すので今は素直に読み直される。どちらでも manifest は同じなので、
  # 修復されたことを直接見る (レビュー R2)。
  @tag :tmp_dir
  test "展開済み sprite が読めなくなっても rebuild が mode を戻して読み直す", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    on_exit(fn -> widen_dir_modes(tmp) end)
    :ok = write_pack(ingest, "io-1.0.0", base_manifest("io"), "body-io")

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    use_ingest(ingest)
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["io"]

    sprite =
      cache
      |> Path.join("*/sprites/idle.png")
      |> Path.wildcard()
      |> hd()

    File.chmod!(sprite, 0o000)

    log = capture_log(fn -> assert :ok = PersonaAssets.rebuild() end)

    refute log =~ "unreadable in the cache"
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["io"]
    assert {:ok, "png-io-1.0.0-idle"} = File.read(sprite)
  end

  @tag :tmp_dir
  test "稼働中に cache root が使えなくなっても現 manifest を維持する", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    parent = Path.join(tmp, "vol")
    File.mkdir_p!(ingest)
    File.mkdir_p!(parent)
    :ok = write_pack(ingest, "lkg-1.0.0", base_manifest("lkg"), "body-lkg")

    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(parent, "cache"))
    use_ingest(ingest)
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["lkg"]

    # volume が読み取り専用になった、のような稼働中の失敗。
    File.rm_rf!(Path.join(parent, "cache"))
    File.chmod!(parent, 0o500)
    on_exit(fn -> File.chmod(parent, 0o700) end)

    assert :ok = PersonaAssets.rebuild()
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["lkg"]
  end

  # ---- 展開上限 (#189, ADR-0046 F8) ----
  #
  # 上限は「アーカイブが申告するサイズ」では張れない。申告は攻撃者が書ける
  # フィールドで、`:zip.unzip/2` はそれを一切参照しない (OTP 29.0.2 実測:
  # local header と central directory の双方で 100 byte と申告したエントリが
  # エラーなしで 10,000,000 byte 書き出された)。よって実 inflate で測る。
  #
  # 本番の上限は 1 GiB なので、境界・drain・方式別の会計は小さい上限を渡す
  # `measure_archive/2` で張り、本番の配線 (@max_extracted_bytes を渡して
  # いること) は下の E2E 1 本で張る。
  describe "measure_archive/2" do
    @tag :tmp_dir
    test "申告サイズを偽装しても実展開量で弾かれる", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "forged.zip")
      body = String.duplicate("Z", 50_000)

      File.write!(
        zip,
        custom_zip(name: "big.bin", body: deflate(body), method: 8, declared_size: 100)
      )

      # 申告は 100 byte。申告を読む実装ならこの上限を素通りする。
      assert {:error, msg} = PersonaAssets.measure_archive(zip, 49_999)
      assert msg =~ "extracted size exceeds 49999 bytes"
      assert msg =~ "reached 50000"
    end

    @tag :tmp_dir
    test "上限ちょうどは通り、1 byte 超過で落ちる", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "boundary.zip")
      File.write!(zip, custom_zip(name: "b.bin", body: deflate(String.duplicate("Z", 50_000))))

      assert :ok = PersonaAssets.measure_archive(zip, 50_000)
      assert {:error, _msg} = PersonaAssets.measure_archive(zip, 49_999)
    end

    # `:zlib.safeInflate/2` の `:finished` は「stream 終端」ではなく「queue
    # した input を使い切った」の意味 (OTP 29.0.2 実測: 500 KB を 8 チャンクで
    # 供給すると 8 回返る)。終端と誤読して 1 チャンク目で打ち切る実装は
    # 8 KB 程度しか数えず、この上限を超えられない。
    @tag :tmp_dir
    test "64 KiB を超えるエントリも全チャンク合算される", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "multichunk.zip")

      # 非圧縮データ = csize が 64 KiB を大きく超え、複数チャンクの供給が要る。
      payload = :crypto.strong_rand_bytes(500_000)
      File.write!(zip, custom_zip(name: "r.bin", body: deflate(payload), method: 8))

      assert :ok = PersonaAssets.measure_archive(zip, 500_000)
      assert {:error, msg} = PersonaAssets.measure_archive(zip, 499_999)
      assert msg =~ "reached 500000"
    end

    @tag :tmp_dir
    test "STORE エントリも会計に載る", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "stored.zip")
      File.write!(zip, custom_zip(name: "s.bin", body: String.duplicate("x", 10_000), method: 0))

      assert :ok = PersonaAssets.measure_archive(zip, 10_000)
      assert {:error, _msg} = PersonaAssets.measure_archive(zip, 9_999)
    end

    # OTP 29.0.2 実測: `:zip.unzip/2` は暗号化ビットを無視して暗号文をその
    # まま書き出す。inflate では実量を測れないので、展開前に pack ごと拒否する。
    @tag :tmp_dir
    test "暗号化エントリは測れないので pack ごと拒否する", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "enc.zip")

      File.write!(
        zip,
        custom_zip(name: "e.bin", body: deflate("x"), method: 8, flags: 0x0001)
      )

      assert {:error, msg} = PersonaAssets.measure_archive(zip, 1_000_000)
      assert msg =~ "encrypted entry cannot be size-checked"
    end

    # レビュー must-fix (2026-08-04)。GPBF bit 3 の entry は local header の
    # size が placeholder で、OTP は central directory の comp_size を使って
    # 展開する (stdlib 8.0.1 `zip.erl` get_z_file/9)。local だけを読む実装は
    # この entry を 0 byte と数え、展開側は実データを全部展開する — 実測で
    # local csize 0 の申告に対し 10,000,000 byte が書き出された。
    @tag :tmp_dir
    test "data descriptor entry は central の comp_size で測る", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "descriptor.zip")
      payload = String.duplicate("Z", 50_000)

      File.write!(
        zip,
        custom_zip(
          name: "d.bin",
          body: deflate(payload),
          method: 8,
          flags: 0x0008,
          local_compressed: 0,
          crc: :erlang.crc32(payload)
        )
      )

      # 仕掛けの premise: OTP が本当にこの entry を展開できること。bit 3 で
      # central を見なくなったら、下のアサーションは「元から穴が無かった」
      # だけで通ってしまう。
      out = Path.join(tmp, "premise")
      File.mkdir_p!(out)

      assert {:ok, _files} =
               :zip.unzip(String.to_charlist(zip), cwd: String.to_charlist(out)),
             "仕掛けた zip の展開自体が失敗した — premise の検査になっていない"

      assert File.stat!(Path.join(out, "d.bin")).size == 50_000

      assert {:error, msg} = PersonaAssets.measure_archive(zip, 49_999)
      assert msg =~ "reached 50000"
    end

    # ふじ本レビュー must M1。ZIP64 の 32-bit size field は sentinel
    # (0xffffffff) で、実サイズは local の ZIP64 extra (0x0001) にある。OTP は
    # それを読んでから展開するので、32-bit 値を生で使うと 4,294,967,295 byte と
    # 数え、valid な pack を 1 GiB 超過として誤 reject する。bypass ではなく
    # 正当な pack の欠落だが、「extractor と同じ field を読む」が全経路で
    # 成立していないことの現れなので blocker 扱い。
    @tag :tmp_dir
    test "ZIP64 STORE は local extra の 64-bit comp_size で測る", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "zip64.zip")
      File.write!(zip, zip64_zip(name: "s.bin", body: "hello world", method: 0))

      # premise: OTP はこの pack を問題なく展開する。
      out = Path.join(tmp, "zip64_premise")
      File.mkdir_p!(out)

      assert {:ok, _files} =
               :zip.unzip(String.to_charlist(zip), cwd: String.to_charlist(out)),
             "仕掛けた ZIP64 の展開自体が失敗した — premise の検査になっていない"

      assert File.stat!(Path.join(out, "s.bin")).size == 11

      assert :ok = PersonaAssets.measure_archive(zip, 11)
      assert {:error, msg} = PersonaAssets.measure_archive(zip, 10)
      assert msg =~ "reached 11"
      assert :ok = PersonaAssets.verify_archive(zip)
    end

    # bit 3 が無ければ comp_size の正本は local 側 (32-bit field、sentinel なら
    # local ZIP64 extra)。central で代用すると両者を食い違わせられる。
    @tag :tmp_dir
    test "bit 3 なしの ZIP64 は central ではなく local extra を正本にする", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "zip64_split.zip")

      File.write!(
        zip,
        zip64_zip(name: "s.bin", body: "hello world", method: 0, central_compressed: 4096)
      )

      # premise: local 11 / central 4096 と食い違わせた唯一の fixture なので、
      # OTP がどちらを正本にしているかはここでしか判別できない。上の ZIP64
      # STORE テストは両者が一致しているため判別に使えない (レビュー round 4)。
      out = Path.join(tmp, "zip64_split_premise")
      File.mkdir_p!(out)

      assert {:ok, _files} =
               :zip.unzip(String.to_charlist(zip), cwd: String.to_charlist(out)),
             "仕掛けた zip の展開自体が失敗した — premise の検査になっていない"

      assert File.stat!(Path.join(out, "s.bin")).size == 11,
             "central の 4096 で展開された — OTP が bit 3 なしでも central を " <>
               "comp_size の正本としなくなった可能性がある"

      assert :ok = PersonaAssets.measure_archive(zip, 11)
      assert {:error, msg} = PersonaAssets.measure_archive(zip, 10)
      assert msg =~ "reached 11"
    end

    # レビュー round 4 must-fix (Critical)。OTP の `update_zip64/2`
    # (stdlib 8.0.1 `zip.erl`) は 8 byte 消費するたびに「その field はまだ
    # sentinel か」を再評価する **ループ** であり、ZIP64 の 64-bit
    # uncompressed 値それ自体が 0xffffffff なら、さらに 8 byte を同じ field
    # として消費する。固定位置で読む実装は comp_size を 1 つ手前から取り、
    # extractor が実際に読む span より小さく数える = 上限を素通りさせる。
    @tag :tmp_dir
    test "ZIP64 の 64-bit uncompressed が sentinel でも OTP と同じ位置から測る",
         %{tmp_dir: tmp} do
      zip = Path.join(tmp, "zip64_loop.zip")
      payload = :binary.copy(<<0>>, 1_000_000)
      body = deflate(payload)

      # 1 番目は 64-bit の sentinel なので OTP はこれを uncompressed として
      # 消費し、まだ sentinel なので 2 番目も uncompressed として消費する。
      # comp_size になるのは 3 番目。固定位置で読むと 2 番目 (100) を取る。
      File.write!(
        zip,
        zip64_zip(
          name: "s.bin",
          body: body,
          method: 8,
          crc: :erlang.crc32(payload),
          local_extra_payload:
            <<0xFFFFFFFF::little-64, 100::little-64, byte_size(body)::little-64>>
        )
      )

      # premise: OTP はこの pack を 1,000,000 byte として展開しきる。
      out = Path.join(tmp, "zip64_loop_premise")
      File.mkdir_p!(out)

      assert {:ok, _files} =
               :zip.unzip(String.to_charlist(zip), cwd: String.to_charlist(out)),
             "仕掛けた zip の展開自体が失敗した — premise の検査になっていない"

      assert File.stat!(Path.join(out, "s.bin")).size == 1_000_000,
             "OTP が update_zip64 のループをやめた可能性がある"

      assert {:error, msg} = PersonaAssets.measure_archive(zip, 999_999)
      assert msg =~ "reached 1000000"
    end

    @tag :tmp_dir
    test "未対応の圧縮方式は pack ごと拒否する", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "bzip2.zip")
      File.write!(zip, custom_zip(name: "b.bin", body: "whatever", method: 12))

      assert {:error, msg} = PersonaAssets.measure_archive(zip, 1_000_000)
      assert msg =~ "unsupported compression method 12"
    end

    # method は local header が正本 (OTP 29.0.2 実測: central が STORE、local が
    # DEFLATE のエントリは inflate された)。central を読む実装に退行すると、
    # 実データは deflate なのに STORE として csize 分しか数えなくなる。
    @tag :tmp_dir
    test "central が偽る method ではなく local header の method で測る", %{tmp_dir: tmp} do
      zip = Path.join(tmp, "lying_central.zip")
      payload = String.duplicate("Z", 50_000)

      # crc は展開後データのもの。既定 (格納バイト列の crc) のままだと下の
      # premise が :bad_crc で落ち、展開の検査にならない。
      File.write!(
        zip,
        custom_zip(
          name: "m.bin",
          body: deflate(payload),
          method: 8,
          central_method: 0,
          crc: :erlang.crc32(payload)
        )
      )

      # premise: OTP がこの fixture を local の DEFLATE として展開すること。
      # preflight の結果だけを見ていると、将来 OTP が central を正本へ変えた
      # 場合にテストは緑のまま bypass になる (ふじ S2)。
      out = Path.join(tmp, "method_premise")
      File.mkdir_p!(out)

      assert {:ok, _files} =
               :zip.unzip(String.to_charlist(zip), cwd: String.to_charlist(out)),
             "仕掛けた zip の展開自体が失敗した — premise の検査になっていない"

      assert File.stat!(Path.join(out, "m.bin")).size == 50_000,
             "central の STORE 宣言で展開された — OTP が local header を " <>
               "method の正本としなくなった可能性がある"

      assert {:error, msg} = PersonaAssets.measure_archive(zip, 49_999)
      assert msg =~ "reached 50000"
    end
  end

  @tag :tmp_dir
  test "エントリ数はちょうど 4096 まで通り、4097 で落ちる", %{tmp_dir: tmp} do
    ok = Path.join(tmp, "ok.zip")
    File.write!(ok, multi_entry_zip(for i <- 1..4096, do: {"f#{i}", ""}))
    assert :ok = PersonaAssets.verify_archive(ok)

    over = Path.join(tmp, "over.zip")
    File.write!(over, multi_entry_zip(for i <- 1..4097, do: {"f#{i}", ""}))
    assert {:error, msg} = PersonaAssets.verify_archive(over)

    # #194 以降、超過は列挙前の EOCD 先読みで弾かれる ("declares")。列挙後の
    # `verify_entry_count/1` ("holds") は、OTP の列挙件数が申告値と一致しなく
    # なった場合にだけ発火する backstop として残してある — その一致自体は
    # 下の premise assertion で固定している。
    assert msg =~ "archive declares 4097 entries, over the 4096 entry limit"
  end

  # premise assertion (ふじ 2026-08-04)。前検査が健全なのは「OTP の列挙件数が
  # EOCD の申告値そのもの」だからで、それは我々のコードでなく upstream の性質。
  # `get_central_dir/4` が `N = EOCD#eocd.entries` を `get_cd_loop/6` の
  # ループ回数に渡している (stdlib 8.0.1 zip.erl 1916-1921)。ここが変われば
  # 申告値による bound は無効になるので、同じテストで upstream を固定する。
  @tag :tmp_dir
  test "OTP は EOCD の申告 entry 数だけ列挙する (前検査の前提)", %{tmp_dir: tmp} do
    under = Path.join(tmp, "under.zip")
    File.write!(under, bounds_zip(records: 3, declared: 1))
    assert {:ok, listed} = :zip.list_dir(String.to_charlist(under))
    assert length(for {:zip_file, _, _, _, _, _} <- listed, do: 1) == 1

    over = Path.join(tmp, "over.zip")
    File.write!(over, bounds_zip(records: 3, declared: 5))
    assert {:error, :bad_central_directory} = :zip.list_dir(String.to_charlist(over))
  end

  # premise assertion。4 MiB という上限は「name/comment が charlist で返る」
  # ことから逆算した数字 (1 文字 16 byte、実測 16.5 倍)。binary で返るように
  # なれば上限は過剰に厳しくなるだけだが、逆算の根拠が消えたことに気付ける
  # ようにしておく。
  @tag :tmp_dir
  test "OTP は entry 名を charlist で返す (4 MiB 上限の逆算根拠)", %{tmp_dir: tmp} do
    path = Path.join(tmp, "long.zip")
    File.write!(path, bounds_zip(records: 1, namelen: 4096))
    assert {:ok, listed} = :zip.list_dir(String.to_charlist(path))
    [name] = for {:zip_file, n, _, _, _, _} <- listed, do: n
    assert is_list(name)
    assert length(name) == 4096
  end

  # #194 本体。申告 entry 数は実体と切り離して弾けること — このアーカイブは
  # 200 byte 程度しかなく、列挙コストでは弾きようがない。
  @tag :tmp_dir
  test "申告 entry 数が上限超なら列挙前に弾く", %{tmp_dir: tmp} do
    path = Path.join(tmp, "declared.zip")
    File.write!(path, bounds_zip(records: 1, declared: 4097))
    assert File.stat!(path).size < 1024

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "archive declares 4097 entries, over the 4096 entry limit"
  end

  # entry 数だけでは塞がらない経路。name/comment は 16-bit 長なので 1 entry で
  # 192KB 引ける上、charlist で 16 倍に膨らむ。4096 件以内・1 GiB 以内のまま
  # heap を数 GB 食わせられるので、central directory の span も bound する。
  @tag :tmp_dir
  test "central directory の span が上限超なら列挙前に弾く", %{tmp_dir: tmp} do
    path = Path.join(tmp, "wide.zip")
    File.write!(path, bounds_zip(records: 70, namelen: 60_000))

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "listing metadata spans"
    assert msg =~ "over the 4194304 byte limit"
  end

  @tag :tmp_dir
  test "span はちょうど 4 MiB まで通り、1 byte 超で落ちる", %{tmp_dir: tmp} do
    # span = central_blob + EOCD(22)。63 x (46+65535) + 1 x (46+62633) で
    # 4194282 になり、EOCD を足して丁度 4194304。
    full = for _ <- 1..63, do: 65_535
    at = Path.join(tmp, "at.zip")
    File.write!(at, bounds_zip(name_lengths: full ++ [62_633]))
    assert {:error, msg} = PersonaAssets.verify_archive(at)
    refute msg =~ "listing metadata spans"

    over = Path.join(tmp, "over.zip")
    File.write!(over, bounds_zip(name_lengths: full ++ [62_634]))
    assert {:error, msg} = PersonaAssets.verify_archive(over)
    assert msg =~ "listing metadata spans 4194305 bytes, over the 4194304 byte limit"
  end

  # ZIP64 経路。32-bit EOCD の entry 数は 0xffff が sentinel で、実数は EOCD64
  # の 64-bit field にある。sentinel をそのまま読むと 65535 件として通ってしまう。
  @tag :tmp_dir
  test "ZIP64 EOCD の 64-bit entry 数で弾く", %{tmp_dir: tmp} do
    path = Path.join(tmp, "z64.zip")
    File.write!(path, bounds_zip(records: 1, declared: 400_000, zip64: true))

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "archive declares 400000 entries, over the 4096 entry limit"
  end

  # ふじ指摘 (2026-08-04)。`find_eocd64/5` は locator 先の 12 byte を読んだ後、
  # central offset を得る **前に** 申告 EOCDSize バイトを read する。ZIP64 EOCD
  # をファイル前方へ置き、巨大 EOCDSize を申告しつつ central offset を EOF 近く
  # に申告すると、tail span の検査だけでは read が終わった後にしか効かない。
  @tag :tmp_dir
  test "ZIP64 EOCD の申告 body 長が予算超なら read 前に弾く", %{tmp_dir: tmp} do
    path = Path.join(tmp, "z64big.zip")

    File.write!(
      path,
      bounds_zip(records: 1, zip64: true, eocd64_front: true, eocd64_size: 7_000_000)
    )

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "ZIP64 end of central directory declares 7000012 bytes"
    assert msg =~ "over the 4194304 byte limit"
  end

  @tag :tmp_dir
  test "ZIP64 EOCD の申告 body 長が固定部未満なら弾く", %{tmp_dir: tmp} do
    path = Path.join(tmp, "z64short.zip")
    File.write!(path, bounds_zip(records: 1, zip64: true, eocd64_size: 43))

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "declares 43 bytes, under the 44 byte minimum"
  end

  @tag :tmp_dir
  test "ZIP64 EOCD の申告 body 長がファイル末尾を超えるなら弾く", %{tmp_dir: tmp} do
    path = Path.join(tmp, "z64past.zip")
    File.write!(path, bounds_zip(records: 1, zip64: true, eocd64_size: 100_000))

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "past the end of the archive"
  end

  # ふじ should-fix (2026-08-04)。上の 2 本は central tail 単独境界と ZIP64 body
  # 単独上限しか張っていないため、「両者を 1 本の予算に合算する」という設計判断
  # そのものが固定されていない — 合算をやめても領域別 cap へ戻しても、どちらの
  # 形も全テストを通ってしまう。各領域は上限内だが合算が limit+2 になる形を
  # 直接 pin する。
  @tag :tmp_dir
  test "central tail と ZIP64 body は 1 本の予算を共有する", %{tmp_dir: tmp} do
    over = Path.join(tmp, "over.zip")
    File.write!(over, budget_zip(2_097_132, 2_097_174))
    assert {:error, msg} = PersonaAssets.verify_archive(over)
    assert msg =~ "listing metadata spans 4194306 bytes, over the 4194304 byte limit"

    # 2 byte 削って丁度 4 MiB。合算検査は通り、以降の段で落ちる。
    at = Path.join(tmp, "at.zip")
    File.write!(at, budget_zip(2_097_132, 2_097_172))
    assert {:error, msg} = PersonaAssets.verify_archive(at)
    refute msg =~ "listing metadata spans"
  end

  # ZIP64 record の消費バイト数 (header 12 + 申告 body 長) と central tail
  # (filesize - 申告 central offset) を独立に指定できる zip。record の実体は
  # ディスク上に存在させる — 存在しないと合算検査より前に末尾超過で落ちる。
  defp budget_zip(eocd64_spent, tail_span) do
    declared_body = eocd64_spent - 12

    local =
      <<0x04034B50::little-32, 20::little-16, 0::little-16, 0::little-16, @dos_date::little-16,
        @dos_date::little-16, 0::little-32, 0::little-32, 0::little-32, 1::little-16,
        0::little-16, "a">>

    central =
      <<0x02014B50::little-32, 20::little-16, 20::little-16, 0::little-16, 0::little-16,
        @dos_date::little-16, @dos_date::little-16, 0::little-32, 0::little-32, 0::little-32,
        1::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-32,
        0::little-32, "b">>

    size = byte_size(local) + eocd64_spent + byte_size(central) + 20 + 22
    cd_offset = size - tail_span

    fixed =
      <<20, 3, 45::little-16, 0::little-32, 0::little-32, 1::little-64, 1::little-64,
        byte_size(central)::little-64, cd_offset::little-64>>

    record =
      <<0x06064B50::little-32, declared_body::little-64>> <>
        fixed <> :binary.copy(<<0>>, declared_body - byte_size(fixed))

    locator =
      <<0x07064B50::little-32, 0::little-32, byte_size(local)::little-64, 1::little-32>>

    eocd32 =
      <<0x06054B50::little-32, 0::little-16, 0::little-16, 0xFFFF::little-16, 0xFFFF::little-16,
        0xFFFFFFFF::little-32, 0xFFFFFFFF::little-32, 0::little-16>>

    local <> record <> central <> locator <> eocd32
  end

  # レビュー must-fix (2026-08-04)。OTP の ?END_OF_CENTRAL_DIR_64_LOCATOR_SZ は
  # `(4+8+4)` = 16 で、locator の物理サイズ 20 byte と一致しない。探索窓の上限は
  # `0xffff + 22 + 16` = 65573 になる。ここに 20 を書くと窓が 4 byte 広くなり、
  # OTP が決して見ない位置に置いた decoy を先読みだけが採る — 3 本の bound が
  # すべて decoy から計算されるので全部素通りし、#194 の欠陥がそのまま戻る
  # (実機再現済み)。境界を両側から張り、同じテストで OTP 側も premise として
  # 固定する。仕様上の幅ではなく実装の定数を写す、という #189 の教訓の再適用。
  @tag :tmp_dir
  test "EOCD 探索窓は OTP と同じ 65573 byte で切れる", %{tmp_dir: tmp} do
    inside = Path.join(tmp, "in.zip")
    File.write!(inside, window_zip(65_573))
    # premise: ここまでは OTP も EOCD を見つけ、列挙まで進む。
    assert {:error, :bad_central_directory} = :zip.list_dir(String.to_charlist(inside))
    assert {:error, msg} = PersonaAssets.verify_archive(inside)
    assert msg =~ "archive declares 200000 entries"

    outside = Path.join(tmp, "out.zip")
    File.write!(outside, window_zip(65_574))

    # premise: 1 byte 外側では OTP は EOCD を見つけられない。先読みも同じでなければ
    # ならない — 見つけてしまうと OTP と別のレコードを根拠に判定することになる。
    assert {:error, :bad_eocd} = :zip.list_dir(String.to_charlist(outside))
    assert {:error, msg} = PersonaAssets.verify_archive(outside)
    assert msg =~ "no end of central directory record"
  end

  # locator + EOCD32 の構造が EOF から `distance` byte 手前に始まる zip。
  # comment 長で末尾まで丁度使い切らせ、探索窓の境界だけを動かす。
  defp window_zip(distance) do
    comment_len = distance - 20 - 22

    local =
      <<0x04034B50::little-32, 20::little-16, 0::little-16, 0::little-16, @dos_date::little-16,
        @dos_date::little-16, 0::little-32, 0::little-32, 0::little-32, 1::little-16,
        0::little-16, "a">>

    central =
      <<0x02014B50::little-32, 20::little-16, 20::little-16, 0::little-16, 0::little-16,
        @dos_date::little-16, @dos_date::little-16, 0::little-32, 0::little-32, 0::little-32,
        1::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-32,
        0::little-32, "b">>

    record =
      <<0x06064B50::little-32, 44::little-64, 20, 3, 45::little-16, 0::little-32, 0::little-32,
        200_000::little-64, 200_000::little-64, byte_size(central)::little-64,
        byte_size(local)::little-64>>

    locator =
      <<0x07064B50::little-32, 0::little-32, byte_size(local) + byte_size(central)::little-64,
        1::little-32>>

    eocd32 =
      <<0x06054B50::little-32, 0::little-16, 0::little-16, 0xFFFF::little-16, 0xFFFF::little-16,
        0xFFFFFFFF::little-32, 0xFFFFFFFF::little-32, comment_len::little-16>>

    local <> central <> record <> locator <> eocd32 <> :binary.copy(<<0>>, comment_len)
  end

  # OTP の locator 節だけ entries_on_disk と entries を AND で結合している
  # (他の sentinel は OR)。この非対称は zip.erl の写しであって書き間違いでは
  # ないので、片方だけ sentinel の形が ZIP64 と見なされないことを固定する。
  # 先読みが OR で判定すると EOCD64 を読みに行き、OTP が列挙すらしない
  # アーカイブについて別の値を根拠に通す/弾くことになる。
  @tag :tmp_dir
  test "entries_on_disk だけ sentinel の EOCD は ZIP64 扱いしない", %{tmp_dir: tmp} do
    path = Path.join(tmp, "half.zip")
    File.write!(path, bounds_zip(records: 1, declared: 400_000, zip64: true, half_sentinel: true))

    # premise: OTP もこの形では EOCD を見つけられない。
    assert {:error, :bad_eocd} = :zip.list_dir(String.to_charlist(path))

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "no end of central directory record"
  end

  # #194 の bound 検査用。EOCD の申告値 (entry 数 / central offset) と ZIP64
  # 経路を個別に張れる最小 zip。実体の central record 数と申告値を独立に
  # 指定できるのが要点 — 「申告値で弾く」ことを実体と切り離して測る。
  defp bounds_zip(opts) do
    lengths =
      Keyword.get_lazy(opts, :name_lengths, fn ->
        List.duplicate(Keyword.get(opts, :namelen, 4), Keyword.get(opts, :records, 1))
      end)

    declared = Keyword.get(opts, :declared, length(lengths))
    zip64 = Keyword.get(opts, :zip64, false)
    eocd64_size = Keyword.get(opts, :eocd64_size, 44)
    front? = Keyword.get(opts, :eocd64_front, false)

    local =
      <<0x04034B50::little-32, 20::little-16, 0::little-16, 0::little-16, @dos_date::little-16,
        @dos_date::little-16, 0::little-32, 0::little-32, 0::little-32, 1::little-16,
        0::little-16, "a">>

    centrals =
      for len <- lengths do
        name = :binary.copy("a", len)

        <<0x02014B50::little-32, 20::little-16, 20::little-16, 0::little-16, 0::little-16,
          @dos_date::little-16, @dos_date::little-16, 0::little-32, 0::little-32, 0::little-32,
          len::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-16, 0::little-32,
          0::little-32>> <> name
      end

    central_blob = IO.iodata_to_binary(centrals)
    cd_offset = byte_size(local)

    if zip64 do
      # record の実体は magic(4) + size(8) + 固定部(44)。`eocd64_size` は
      # ヘッダが申告する長さで、実体と独立に張れる。
      record_body = fn cd_start ->
        <<20, 3, 45::little-16, 0::little-32, 0::little-32, declared::little-64,
          declared::little-64, byte_size(central_blob)::little-64, cd_start::little-64>>
      end

      record = fn cd_start ->
        <<0x06064B50::little-32, eocd64_size::little-64>> <> record_body.(cd_start)
      end

      record_size = 12 + 44

      # front? は EOCD64 をファイル先頭へ置き、central offset を EOF 近くに
      # 申告する配置 — tail span の検査だけでは read 後にしか効かない形。
      {record_offset, cd_start} =
        if front?,
          do: {0, record_size + byte_size(local)},
          else: {byte_size(local) + byte_size(central_blob), cd_offset}

      locator = <<0x07064B50::little-32, 0::little-32, record_offset::little-64, 1::little-32>>

      # half_sentinel: entries_on_disk だけ sentinel にし、他の field は実値の
      # まま。OTP の locator 節は entries_on_disk と entries を AND で見るので
      # これは ZIP64 と見なされない (他の節は OR)。
      eocd32 =
        if Keyword.get(opts, :half_sentinel, false) do
          <<0x06054B50::little-32, 0::little-16, 0::little-16, 0xFFFF::little-16,
            declared::little-16, byte_size(central_blob)::little-32, cd_offset::little-32,
            0::little-16>>
        else
          <<0x06054B50::little-32, 0::little-16, 0::little-16, 0xFFFF::little-16,
            0xFFFF::little-16, 0xFFFFFFFF::little-32, 0xFFFFFFFF::little-32, 0::little-16>>
        end

      if front? do
        record.(cd_start) <> local <> central_blob <> locator <> eocd32
      else
        local <> central_blob <> record.(cd_start) <> locator <> eocd32
      end
    else
      eocd =
        <<0x06054B50::little-32, 0::little-16, 0::little-16, declared::little-16,
          declared::little-16, byte_size(central_blob)::little-32, cd_offset::little-32,
          0::little-16>>

      local <> central_blob <> eocd
    end
  end

  # レビュー must-fix (round 2)。`:zlib.safeInflate/2` は壊れた圧縮データに対し
  # `{:error, _}` を返さず :data_error を raise する。preflight がこれを捕まえ
  # 損ねると例外が rebuild/0 まで抜け (その rescue は File.Error 限定)、pack を
  # 1 本置くだけで cold start が起動不能・稼働中は PersonaWatcher が crash
  # ループする。導入前は `:zip.unzip/2` が `{:error, {:EXIT, _}}` を返して当該
  # pack のみ skip していたので、これは preflight が持ち込む退行だった。
  # 攻撃者が要らないのも重要 — 配布中の切り詰めや bit rot で踏める。
  @tag :tmp_dir
  test "deflate が壊れた pack は skip され、同居する健全 pack は残る (cold start も通る)",
       %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")

    # method=8 と宣言しつつ中身は deflate ですらないバイト列。
    File.write!(
      Path.join(ingest, "rot-1.0.0.zip"),
      custom_zip(name: "rot.bin", body: :crypto.strong_rand_bytes(300), method: 8)
    )

    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(tmp, "cache"))
    Application.put_env(:kaoiro_server, :persona_dir, ingest)
    :persistent_term.erase({PersonaAssets, :cache})

    log = capture_log(fn -> assert :ok = PersonaAssets.rebuild() end)

    assert log =~ "skip persona pack rot-1.0.0.zip: cannot inflate"
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]
  end

  # STORE には stream 終端が無く、その長さは偽装可能な申告フィールドにしか
  # 無い。偽装できないのはアーカイブ自身のサイズで、STORE は膨張しないので
  # ファイルを縛れば STORE 由来の展開量も縛れる (ふじ案 a)。sparse file なので
  # 実ディスクは消費しない。
  @tag :tmp_dir
  test "アーカイブ自体が 1 GiB を超えていれば中身を読む前に拒否する", %{tmp_dir: tmp} do
    path = Path.join(tmp, "huge.zip")
    {:ok, fd} = File.open(path, [:write, :binary])
    :ok = :file.pwrite(fd, 1024 * 1024 * 1024, "x")
    :ok = File.close(fd)

    assert {:error, msg} = PersonaAssets.verify_archive(path)
    assert msg =~ "over the 1073741824 byte limit"
  end

  # クロエ/ふじ指示: 検査は「書き込み開始前の拒否」層にある。順序を入れ替えても
  # この不変条件は保たれること。
  #
  # 2 経路を別々に張る。名前で弾かれる pack は inflate まで到達しないので、
  # 1 本にまとめると実測側の不変条件が張れていないのに張れているように読める
  # (レビュー round 3 advisory: 元のこのテストが実際にそうなっていた)。
  @tag :tmp_dir
  test "検査は 1 byte も書かない (zip-slip 経路・inflate 経路の双方)", %{tmp_dir: tmp} do
    work = Path.join(tmp, "work")
    File.mkdir_p!(work)

    # (1) 名前で弾かれる経路。inflate までは走らない。
    slip = Path.join(work, "slip.zip")
    File.write!(slip, custom_zip(name: "../escaped", body: deflate("x"), method: 8))

    before = snapshot(work)
    assert {:error, msg} = PersonaAssets.verify_archive(slip)
    assert msg =~ "escapes the extraction dir"
    assert snapshot(work) == before

    # (2) 名前は安全で、inflate 実測まで走ってから上限で弾かれる経路。
    big = Path.join(work, "big.zip")

    File.write!(
      big,
      custom_zip(name: "big.bin", body: deflate(String.duplicate("Z", 50_000)), method: 8)
    )

    before = snapshot(work)
    assert {:error, msg} = PersonaAssets.measure_archive(big, 49_999)
    assert msg =~ "reached 50000"
    assert snapshot(work) == before
  end

  # 本番の配線 (verify_archive/1 が @max_extracted_bytes を渡していること) は
  # 実物の bomb でしか張れない。ADR-0029 の「1 本の不正 pack が全体を止めない」
  # も同時に見る。
  @tag :tmp_dir
  test "1 GiB を超えて展開される pack は skip され、同居する健全 pack は残る", %{tmp_dir: tmp} do
    ingest = Path.join(tmp, "packs")
    cache = Path.join(tmp, "cache")
    File.mkdir_p!(ingest)
    :ok = write_pack(ingest, "good-1.0.0", base_manifest("good"), "body-good")

    {bomb, bomb_crc} = deflate_bomb(1024 * 1024 * 1024 + 1_048_576)

    File.write!(
      Path.join(ingest, "bomb-1.0.0.zip"),
      custom_zip(name: "bomb.bin", body: bomb, method: 8, crc: bomb_crc)
    )

    Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
    log = capture_log(fn -> use_ingest(ingest) end)

    assert log =~ "skip persona pack bomb-1.0.0.zip: extracted size exceeds 1073741824 bytes"
    assert Map.keys(PersonaAssets.manifest()["personas"]) == ["good"]

    # 展開されかけた痕跡が cache に残っていないこと。
    assert cache |> Path.join("*/bomb.bin") |> Path.wildcard() == []
  end

  defp snapshot(dir) do
    dir
    |> Path.join("**")
    |> Path.wildcard(match_dot: true)
    |> Enum.sort()
    |> Enum.map(&{&1, File.lstat!(&1).size})
  end

  # raw deflate (zip が entry に格納する、zlib/gzip の枠無しの生ストリーム)。
  defp deflate(payload) do
    z = :zlib.open()
    :ok = :zlib.deflateInit(z, :best_speed, :deflated, -15, 8, :default)
    out = IO.iodata_to_binary([:zlib.deflate(z, payload), :zlib.deflate(z, "", :finish)])
    :zlib.close(z)
    out
  end

  # 1 GiB 級の展開量を持つ raw deflate ストリーム。全量をメモリに載せずに
  # 作るためチャンクで食わせる (:best_speed で約 1.8 秒)。
  #
  # crc は展開後データのものを返す。これを正しく入れておかないと、上限検査を
  # 外した mutation が :bad_crc で弾かれて「検査が効いている」ように見えて
  # しまう — 検査が無ければ本当に 1 GiB が書かれる、という前提を保つ。
  defp deflate_bomb(total_bytes) do
    z = :zlib.open()
    :ok = :zlib.deflateInit(z, :best_speed, :deflated, -15, 8, :default)
    chunk = :binary.copy(<<0>>, 1_048_576)

    {body, crc} =
      Enum.reduce(1..ceil(total_bytes / 1_048_576), {[], 0}, fn _i, {acc, crc} ->
        {[acc, :zlib.deflate(z, chunk)], :erlang.crc32(crc, chunk)}
      end)

    out = IO.iodata_to_binary([body, :zlib.deflate(z, "", :finish)])
    :zlib.close(z)
    {out, crc}
  end

  # ZIP64: 32-bit の size field を sentinel (0xffffffff) にし、実サイズを
  # ZIP64 extended information extra field (header id 0x0001) へ置く。
  # payload の順序は固定 (uncompressed, compressed, offset, disk) で、対応する
  # 32-bit field が sentinel のものだけが現れる。ここでは両方 sentinel にする。
  defp zip64_zip(opts) do
    name = Keyword.fetch!(opts, :name)
    body = Keyword.fetch!(opts, :body)
    method = Keyword.get(opts, :method, 0)
    csize = byte_size(body)
    usize = Keyword.get(opts, :declared_size, byte_size(body))
    central_csize = Keyword.get(opts, :central_compressed, csize)
    crc = Keyword.get(opts, :crc, :erlang.crc32(body))
    n = byte_size(name)
    sentinel = 0xFFFFFFFF

    # 既定は仕様どおり (uncompressed, compressed) の 16 byte。攻撃側の形を
    # 張るテストのために payload を直接差し替えられるようにしてある。
    local_payload =
      Keyword.get(opts, :local_extra_payload, <<usize::little-64, csize::little-64>>)

    local_extra =
      <<0x0001::little-16, byte_size(local_payload)::little-16>> <> local_payload

    central_extra =
      <<0x0001::little-16, 16::little-16, usize::little-64, central_csize::little-64>>

    local =
      <<0x04034B50::little-32, 45::little-16, 0::little-16, method::little-16, 0::little-16,
        @dos_date::little-16, crc::little-32, sentinel::little-32, sentinel::little-32,
        n::little-16, byte_size(local_extra)::little-16>> <> name <> local_extra <> body

    central =
      <<0x02014B50::little-32, 45::little-16, 45::little-16, 0::little-16, method::little-16,
        0::little-16, @dos_date::little-16, crc::little-32, sentinel::little-32,
        sentinel::little-32, n::little-16, byte_size(central_extra)::little-16, 0::little-16,
        0::little-16, 0::little-16, 0::little-32, 0::little-32>> <> name <> central_extra

    eocd =
      <<0x06054B50::little-32, 0::little-16, 0::little-16, 1::little-16, 1::little-16,
        byte_size(central)::little-32, byte_size(local)::little-32, 0::little-16>>

    local <> central <> eocd
  end

  # `:zip.create/3` では method / general purpose flag / 申告 size を指定できず、
  # central と local で別の値を書くこともできないので手組みする。`body` は
  # 「アーカイブに格納されるバイト列」(deflate 済みならその圧縮データ)。
  defp custom_zip(opts) do
    name = Keyword.fetch!(opts, :name)
    body = Keyword.fetch!(opts, :body)
    method = Keyword.get(opts, :method, 8)
    central_method = Keyword.get(opts, :central_method, method)
    flags = Keyword.get(opts, :flags, 0)
    declared = Keyword.get(opts, :declared_size, byte_size(body))
    crc = Keyword.get(opts, :crc, :erlang.crc32(body))
    csize = byte_size(body)
    # data descriptor (GPBF bit 3) を張るとき、local header 側だけ別の
    # (placeholder の) 値を書けるようにする。central には真値が残る。
    local_csize = Keyword.get(opts, :local_compressed, csize)
    n = byte_size(name)

    local =
      <<0x04034B50::little-32, 20::little-16, flags::little-16, method::little-16, 0::little-16,
        @dos_date::little-16, crc::little-32, local_csize::little-32, declared::little-32,
        n::little-16, 0::little-16>> <> name <> body

    central =
      <<0x02014B50::little-32, 20::little-16, 20::little-16, flags::little-16,
        central_method::little-16, 0::little-16, @dos_date::little-16, crc::little-32,
        csize::little-32, declared::little-32, n::little-16, 0::little-16, 0::little-16,
        0::little-16, 0::little-16, 0::little-32, 0::little-32>> <> name

    eocd =
      <<0x06054B50::little-32, 0::little-16, 0::little-16, 1::little-16, 1::little-16,
        byte_size(central)::little-32, byte_size(local)::little-32, 0::little-16>>

    local <> central <> eocd
  end

  # issue #195 テスト共通ヘルパー群 (ふじ 2026-08-05 spec)。

  defp sha256_hex(path) do
    path |> File.read!() |> then(&:crypto.hash(:sha256, &1)) |> Base.encode16(case: :lower)
  end

  defp assert_no_stage_leftover(cache_dir) do
    entries =
      case File.ls(cache_dir) do
        {:ok, names} -> names
        {:error, _} -> []
      end

    refute Enum.any?(entries, &String.starts_with?(&1, ".stage-")),
           "cache root に .stage-* が残っている: #{inspect(entries)}"
  end

  describe "issue #195: staging (TOCTOU 対策)" do
    @tag :tmp_dir
    test "stage_archive/3: exact limit は受理、limit+1 は明示 oversize で拒否 (must-2)", %{
      tmp_dir: tmp
    } do
      ingest = Path.join(tmp, "packs")
      File.mkdir_p!(ingest)
      :ok = write_pack(ingest, "sz-1.0.0", base_manifest("sz"), "body-sz")
      zip = Path.join(ingest, "sz-1.0.0.zip")
      {:ok, %File.Stat{size: size}} = File.stat(zip)

      dest_ok = Path.join(tmp, "staged-ok.zip")
      assert {:ok, ^size, hash} = PersonaAssets.stage_archive(zip, dest_ok, size)
      assert hash == sha256_hex(zip)
      assert {:ok, %File.Stat{size: ^size}} = File.stat(dest_ok)

      dest_over = Path.join(tmp, "staged-over.zip")
      assert {:oversize, ^size} = PersonaAssets.stage_archive(zip, dest_over, size - 1)
    end

    @tag :tmp_dir
    test "stage 確定後の元 path rename は staged bytes に影響しない (must-3)", %{tmp_dir: tmp} do
      ingest = Path.join(tmp, "packs")
      File.mkdir_p!(ingest)
      :ok = write_pack(ingest, "orig-1.0.0", base_manifest("orig"), "body-orig")
      zip = Path.join(ingest, "orig-1.0.0.zip")
      {:ok, original_bytes} = File.read(zip)

      dest = Path.join(tmp, "staged.zip")
      assert {:ok, _total, _hash} = PersonaAssets.stage_archive(zip, dest, 10_000_000)

      :ok = write_pack(ingest, "swap-1.0.0", base_manifest("swap"), "body-swap")
      File.rename!(Path.join(ingest, "swap-1.0.0.zip"), zip)
      refute File.read!(zip) == original_bytes, "premise: rename 後は元 path の内容が変わっている"

      assert File.read!(dest) == original_bytes
    end

    @tag :tmp_dir
    test "stage 確定後の元 path 同 inode 上書きは staged bytes に影響しない (must-3)", %{
      tmp_dir: tmp
    } do
      ingest = Path.join(tmp, "packs")
      File.mkdir_p!(ingest)
      :ok = write_pack(ingest, "orig2-1.0.0", base_manifest("orig2"), "body-orig2")
      zip = Path.join(ingest, "orig2-1.0.0.zip")
      {:ok, original_bytes} = File.read(zip)

      dest = Path.join(tmp, "staged2.zip")
      assert {:ok, _total, staged_hash} = PersonaAssets.stage_archive(zip, dest, 10_000_000)

      # 同一 path への File.write! は truncate+write で同一 inode を書き換える
      # (rename ではなく in-place overwrite)。
      File.write!(zip, "junk-not-a-zip-anymore")

      assert File.read!(dest) == original_bytes
      assert staged_hash == sha256_hex_bytes(original_bytes)
    end

    @tag :tmp_dir
    test "digest 不一致は予定 slot へ展開せず、race と分かる文言で報告する (must-1, 追補)", %{
      tmp_dir: tmp
    } do
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      File.mkdir_p!(cache)
      :ok = write_pack(ingest, "race-1.0.0", base_manifest("race"), "body-race")
      zip = Path.join(ingest, "race-1.0.0.zip")
      extracted_dir = Path.join(cache, "deadbeefdeadbeef")
      wrong_hash = String.duplicate("0", 64)

      assert {:error, msg} = PersonaAssets.extract(zip, wrong_hash, extracted_dir, cache)
      assert msg =~ "digest mismatch"
      assert msg =~ "update race"
      refute msg =~ "unzip failed", "malformed archive と同じ文言に落ちてはいけない"

      refute File.exists?(extracted_dir)
      assert_no_stage_leftover(cache)
    end

    @tag :tmp_dir
    test "success 経路で stage が消える (must-4)", %{tmp_dir: tmp} do
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      File.mkdir_p!(cache)
      :ok = write_pack(ingest, "ok-1.0.0", base_manifest("ok"), "body-ok")
      zip = Path.join(ingest, "ok-1.0.0.zip")
      extracted_dir = Path.join(cache, "cafecafecafecafe")

      assert :ok = PersonaAssets.extract(zip, sha256_hex(zip), extracted_dir, cache)
      assert File.dir?(extracted_dir)
      assert_no_stage_leftover(cache)
    end

    @tag :tmp_dir
    test "pack error 経路で stage が消える (must-4)", %{tmp_dir: tmp} do
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      File.mkdir_p!(cache)
      zip = Path.join(ingest, "bad.zip")
      File.write!(zip, "not a valid zip archive")
      extracted_dir = Path.join(cache, "badbadbadbadbad0")

      assert {:error, _msg} = PersonaAssets.extract(zip, sha256_hex(zip), extracted_dir, cache)
      refute File.dir?(extracted_dir)
      assert_no_stage_leftover(cache)
    end

    @tag :tmp_dir
    test "exception raise 経路でも stage が消える (must-4)", %{tmp_dir: tmp} do
      # digest 一致後、`discard/2` (`normalize_modes/1` → `File.lstat/1`) に
      # 渡る `extracted_dir` を非バイナリにして FunctionClauseError を確実に
      # raise させる — 実測(2026-08-05): この OTP (29.0.2) の `:zip.unzip/2`
      # は date=0 の不正エントリでも `write_file_info` の `:badarg` を内部で
      # 捕まえて `{:error, {...}}` タプルへ落とす(raise しない、既存コメント
      # が想定していた挙動とは異なる)ので、archive 由来では raise を再現
      # できなかった。この型ミスマッチは exception / raise 経路そのもの
      # (`extract/4` の try/rescue が正しく動くか)を検証する目的には十分。
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      File.mkdir_p!(cache)
      :ok = write_pack(ingest, "raiser-1.0.0", base_manifest("raiser"), "body-raiser")
      zip = Path.join(ingest, "raiser-1.0.0.zip")

      assert_raise FunctionClauseError, fn ->
        PersonaAssets.extract(zip, sha256_hex(zip), _not_a_path = 12345, cache)
      end

      assert_no_stage_leftover(cache)
    end

    @tag :tmp_dir
    test "staging dir/file は 0700/0600、exclusive create で symlink を辿らない (must-4)", %{
      tmp_dir: tmp
    } do
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      File.mkdir_p!(cache)
      :ok = write_pack(ingest, "perm-1.0.0", base_manifest("perm"), "body-perm")
      zip = Path.join(ingest, "perm-1.0.0.zip")

      assert {:ok, stage_dir, stage_path} = PersonaAssets.new_stage(cache)
      on_exit(fn -> File.rm_rf(stage_dir) end)

      assert {:ok, %File.Stat{mode: dir_mode}} = File.lstat(stage_dir)
      assert Bitwise.band(dir_mode, 0o777) == 0o700

      assert {:ok, _total, _hash} = PersonaAssets.stage_archive(zip, stage_path, 10_000_000)
      assert {:ok, %File.Stat{mode: file_mode}} = File.lstat(stage_path)
      assert Bitwise.band(file_mode, 0o777) == 0o600

      # 事前に symlink を仕込んだ path への stage は辿らず失敗する。
      target = Path.join(tmp, "symlink-target")
      File.write!(target, "should-not-be-touched")
      planted = Path.join(tmp, "planted-dest.zip")
      File.ln_s!(target, planted)

      assert {:write_error, _reason} = PersonaAssets.stage_archive(zip, planted, 10_000_000)
      assert File.read!(target) == "should-not-be-touched"
    end

    @tag :tmp_dir
    test "stage_archive/3: source read 失敗と destination write 失敗は別側に分類される (must-3)", %{
      tmp_dir: tmp
    } do
      missing = Path.join(tmp, "nope.zip")
      dest1 = Path.join(tmp, "dest1.zip")
      assert {:read_error, _reason} = PersonaAssets.stage_archive(missing, dest1, 1000)
      refute File.exists?(dest1)

      ingest = Path.join(tmp, "packs")
      File.mkdir_p!(ingest)
      :ok = write_pack(ingest, "wf-1.0.0", base_manifest("wf"), "body-wf")
      zip = Path.join(ingest, "wf-1.0.0.zip")
      bad_dest = Path.join([tmp, "no-such-dir", "dest2.zip"])
      assert {:write_error, _reason} = PersonaAssets.stage_archive(zip, bad_dest, 10_000_000)

      # extract/4 経由でも read 失敗は cache_error ではなく pack error(=archive
      # の問題)として報告される — cache 側の障害と取り違えてはいけない。
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(cache)
      extracted_dir = Path.join(cache, "readfailreadfail")
      assert {:error, msg} = PersonaAssets.extract(missing, "irrelevant", extracted_dir, cache)
      assert msg =~ "reading source archive failed"
      assert_no_stage_leftover(cache)
    end

    @tag :tmp_dir
    test "crash 残骸の .stage-* は厳密な shape のものだけ age に関わらず即時 reclaim される (must-1, must-2)",
         %{tmp_dir: tmp} do
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      File.mkdir_p!(cache)
      :ok = write_pack(ingest, "orphan-1.0.0", base_manifest("orphan"), "body-orphan")

      # 正確な shape(`.stage-` + 22 文字、charset A-Za-z0-9_-)。
      # `PersonaRebuildLock` による直列化(must-1)で build/1 開始時点では
      # live な staging 領域があり得ないため、mtime を更新せず「作られた
      # ばかり」のままにしても即時 reclaim される — age-gate 撤廃の pin。
      fresh_exact = Path.join(cache, ".stage-" <> String.duplicate("a", 22))
      File.mkdir_p!(fresh_exact)

      # 前方一致はするが厳密な shape に合わない entry(ふじ round-2 レビュー
      # 2026-08-05 が挙げた具体例)。`.stage-` っぽく見えても正規表現に
      # 一致しない限り永続として扱う(ADR-0046 F3 追補、must-2)。
      important = Path.join(cache, ".stage-important")
      File.mkdir_p!(important)
      on_exit(fn -> File.rm_rf(important) end)

      freshtest = Path.join(cache, ".stage-freshtest")
      File.mkdir_p!(freshtest)
      on_exit(fn -> File.rm_rf(freshtest) end)

      # 内部レビュー指摘 (2026-08-05): 末尾改行付きの 22 文字 entry。
      # `~r/.../{22}$/` の `$` は PCRE 流儀では文字列末尾の直前の1個の
      # 改行にもマッチする(`\z` ではない)ため、`random_stage_name/0` が
      # 絶対に生成しない「22 文字 + 改行」という shape が exact-match を
      # すり抜けて reclaim されてしまう穴だった。Linux のファイル名は
      # `/` と NUL 以外の任意バイトを許すため、この directory は実際に
      # 作成できる。
      trailing_newline = Path.join(cache, ".stage-" <> String.duplicate("a", 22) <> "\n")
      File.mkdir_p!(trailing_newline)
      on_exit(fn -> File.rm_rf(trailing_newline) end)

      Application.put_env(:kaoiro_server, :persona_cache_dir, cache)
      use_ingest(ingest)

      refute File.exists?(fresh_exact),
             "厳密な shape の stage orphan は age に関わらず即時 reclaim されるべき"

      assert File.exists?(important), "前方一致だけの entry (.stage-important) は消してはいけない"
      assert File.exists?(freshtest), "前方一致だけの entry (.stage-freshtest) は消してはいけない"

      assert File.exists?(trailing_newline),
             "末尾改行付きの 22 文字 entry は random_stage_name/0 が生成し得ない形なので消してはいけない"
    end

    @tag :tmp_dir
    test "new_stage/1: chmod 失敗時は作成済みの stage_dir を discard する (must-3)", %{
      tmp_dir: tmp
    } do
      # 単一 UID では genuine な chmod 失敗を再現できない(new_stage/1 自身
      # の既存コメント参照)。discard_new_stage/3 を synthetic reason で
      # 直接駆動し、「実在する stage_dir が discard_stage/2 で本当に消える
      # こと」(配線そのもの)を pin する — merge_cleanup_error/2 の純粋な
      # ロジックは別 describe (line 701 付近) で既に検証済み。
      stage_dir = Path.join(tmp, ".stage-" <> String.duplicate("b", 22))
      :ok = File.mkdir(stage_dir)

      assert {:error, _msg} = PersonaAssets.discard_new_stage(:eacces, stage_dir, tmp)
      refute File.exists?(stage_dir), "chmod 失敗時も stage_dir は discard されるべき"
    end
  end

  defp sha256_hex_bytes(bytes) do
    :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
  end
end
