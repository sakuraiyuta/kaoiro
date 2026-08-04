defmodule KaoiroServer.PersonaAssetsTest do
  # Mutates the :persona_dir config and the persistent_term cache.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.FooterAssets
  alias KaoiroServer.PersonaAssets

  @states ~w(idle thinking tool_running waiting_input
             waiting_permission done error)

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

    # cold start でも raise しないこと (application.ex は :ok を assert する)。
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
end
