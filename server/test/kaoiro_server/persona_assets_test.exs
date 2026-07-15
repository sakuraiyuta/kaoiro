defmodule KaoiroServer.PersonaAssetsTest do
  # Mutates the :persona_dir config and the persistent_term cache.
  use ExUnit.Case, async: false

  alias KaoiroServer.PersonaAssets

  @states ~w(idle thinking tool_running waiting_input
             waiting_permission done error)

  setup do
    original = Application.get_env(:kaoiro_server, :persona_dir)

    on_exit(fn ->
      if original == nil do
        Application.delete_env(:kaoiro_server, :persona_dir)
      else
        Application.put_env(:kaoiro_server, :persona_dir, original)
      end

      PersonaAssets.rebuild()
    end)

    :ok
  end

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
             "body-ao\n\n" <> PersonaAssets.common_footer()
  end

  @tag :tmp_dir
  test "reserved default は pack 不要で known / footer のみが prompt", %{tmp_dir: tmp} do
    use_ingest(tmp)

    assert PersonaAssets.known_persona?("default")
    assert PersonaAssets.prompt("default") == PersonaAssets.common_footer()
    refute PersonaAssets.known_persona?("unknown")
    assert PersonaAssets.prompt("unknown") == nil
  end

  test "common footer は peer-routing contract (ADR-0038) を含む" do
    footer = PersonaAssets.common_footer()
    assert footer =~ "list_agents"
    assert footer =~ "kaoiro peer"
    assert footer =~ "代替生成しない"
    assert footer =~ "役割名"
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
end
