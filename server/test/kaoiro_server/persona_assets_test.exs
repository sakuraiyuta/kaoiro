defmodule KaoiroServer.PersonaAssetsTest do
  # Mutates the :persona_dir config and the persistent_term cache.
  use ExUnit.Case, async: false

  alias KaoiroServer.PersonaAssets

  @bundled_sets ~w(ao kuroe momo)
  @states ~w(done error idle thinking tool_running waiting_input waiting_permission)

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

  defp use_overlay(dir) do
    Application.put_env(:kaoiro_server, :persona_dir, dir)
    PersonaAssets.rebuild()
  end

  test "同梱パックの 3 セット x 7 状態がマニフェストに載る" do
    %{"personas" => personas} = PersonaAssets.manifest()

    assert Map.keys(personas) |> Enum.sort() == @bundled_sets

    for set <- @bundled_sets do
      assert personas[set]["states"] |> Map.keys() |> Enum.sort() == @states
    end
  end

  test "url とハッシュが content-addressed 形式に従う" do
    %{"version" => version, "personas" => personas} = PersonaAssets.manifest()

    assert version =~ ~r/^[0-9a-f]{16}$/

    %{"url" => url, "hash" => "sha256:" <> hex} =
      personas["ao"]["states"]["idle"]

    assert hex =~ ~r/^[0-9a-f]{64}$/
    assert url == "/personas/ao/idle.png?v=#{String.slice(hex, 0, 12)}"

    bundled = Application.app_dir(:kaoiro_server, "priv/personas")

    expected =
      :crypto.hash(:sha256, File.read!(Path.join(bundled, "ao/idle.png")))
      |> Base.encode16(case: :lower)

    assert hex == expected
  end

  test "fetch_file はマニフェスト掲載ファイルのみ解決する" do
    assert {:ok, %{path: path, hash: hash}} =
             PersonaAssets.fetch_file("ao", "idle.png")

    assert File.exists?(path)
    assert hash =~ ~r/^[0-9a-f]{64}$/
    assert :error = PersonaAssets.fetch_file("ao", "missing.png")
    assert :error = PersonaAssets.fetch_file("..", "idle.png")
  end

  @tag :tmp_dir
  test "オーバーレイはスプライトセット単位で同梱に勝つ", %{tmp_dir: tmp} do
    File.mkdir_p!(Path.join(tmp, "ao"))
    File.write!(Path.join(tmp, "ao/idle.png"), "overlay-bytes")
    use_overlay(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()

    # ao is replaced entirely (one state only); bundled sets remain.
    assert Map.keys(personas) |> Enum.sort() == @bundled_sets
    assert Map.keys(personas["ao"]["states"]) == ["idle"]
    assert personas["momo"]["states"] |> map_size() == 7

    overlay_hash =
      :crypto.hash(:sha256, "overlay-bytes") |> Base.encode16(case: :lower)

    assert personas["ao"]["states"]["idle"]["hash"] == "sha256:#{overlay_hash}"

    assert {:ok, %{path: path}} = PersonaAssets.fetch_file("ao", "idle.png")
    assert path == Path.join(tmp, "ao/idle.png")
  end

  @tag :tmp_dir
  test "オーバーレイの新規セットが追加される", %{tmp_dir: tmp} do
    File.mkdir_p!(Path.join(tmp, "mio"))
    File.write!(Path.join(tmp, "mio/idle.png"), "mio-idle")
    use_overlay(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()
    assert Map.keys(personas) |> Enum.sort() == ["ao", "kuroe", "mio", "momo"]
  end

  @tag :tmp_dir
  test "URL 非安全な名前と非 PNG は走査から除外される", %{tmp_dir: tmp} do
    File.mkdir_p!(Path.join(tmp, "bad name"))
    File.write!(Path.join(tmp, "bad name/idle.png"), "x")
    File.mkdir_p!(Path.join(tmp, "mio"))
    File.write!(Path.join(tmp, "mio/note.txt"), "x")
    File.write!(Path.join(tmp, "mio/bad name.png"), "x")
    use_overlay(tmp)

    %{"personas" => personas} = PersonaAssets.manifest()
    refute Map.has_key?(personas, "bad name")
    refute Map.has_key?(personas, "mio")
  end

  test "存在しないオーバーレイは同梱のみで動作する" do
    use_overlay("/nonexistent/persona/dir")

    %{"personas" => personas} = PersonaAssets.manifest()
    assert Map.keys(personas) |> Enum.sort() == @bundled_sets
  end

  @tag :tmp_dir
  test "version はアセット内容の変化で変わる", %{tmp_dir: tmp} do
    %{"version" => before_version} = PersonaAssets.manifest()

    File.mkdir_p!(Path.join(tmp, "ao"))
    File.write!(Path.join(tmp, "ao/idle.png"), "changed")
    use_overlay(tmp)

    %{"version" => after_version} = PersonaAssets.manifest()
    refute before_version == after_version
  end
end
