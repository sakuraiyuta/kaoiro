defmodule KaoiroServer.FooterWatcherTest do
  # init/1 reads the :footer_dir config, so this cannot run alongside the
  # FooterAssets tests that mutate it.
  use ExUnit.Case, async: false

  alias KaoiroServer.FooterWatcher

  @root "/etc/kaoiro/footers"

  setup do
    original = Application.get_env(:kaoiro_server, :footer_dir)

    on_exit(fn ->
      if original == nil do
        Application.delete_env(:kaoiro_server, :footer_dir)
      else
        Application.put_env(:kaoiro_server, :footer_dir, original)
      end
    end)

    :ok
  end

  # ADR-0045 F4: root 直下の 2 ファイル名完全一致のみ。任意の *.md へは
  # 広げない (PersonaWatcher の拡張子マッチとは意図的に別物)。
  test "root 直下の system-footer.md / user-footer.md だけを拾う" do
    assert FooterWatcher.watched_event?("#{@root}/system-footer.md", @root)
    assert FooterWatcher.watched_event?("#{@root}/user-footer.md", @root)
  end

  test "他の名前・他の拡張子は拾わない" do
    refute FooterWatcher.watched_event?("#{@root}/notes.md", @root)
    refute FooterWatcher.watched_event?("#{@root}/system-footer.md.swp", @root)
    refute FooterWatcher.watched_event?("#{@root}/user-footer.ao.md", @root)
    refute FooterWatcher.watched_event?("#{@root}/system-footer", @root)
  end

  test "サブディレクトリや root 外は拾わない" do
    refute FooterWatcher.watched_event?("#{@root}/sub/system-footer.md", @root)
    refute FooterWatcher.watched_event?("/etc/kaoiro/system-footer.md", @root)
  end

  test "path は正規化してから比較する" do
    assert FooterWatcher.watched_event?("#{@root}/./system-footer.md", @root)
    assert FooterWatcher.watched_event?("#{@root}/sub/../system-footer.md", @root)
  end

  # ADR-0045 F1/F4 / ふじ S3: file-based footers are opt-in and the root is
  # a `:ro` mount, so both "not configured" and "not there" must drop the
  # watcher out of the tree without creating anything.
  describe "init/1 の縮退" do
    test "KAOIRO_FOOTER_DIR 未設定なら :ignore" do
      Application.delete_env(:kaoiro_server, :footer_dir)

      assert :ignore = FooterWatcher.init([])
    end

    @tag :tmp_dir
    test "設定済みでも dir が無ければ :ignore、mkdir もしない", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "not-there")
      Application.put_env(:kaoiro_server, :footer_dir, dir)

      assert :ignore = FooterWatcher.init([])
      assert :ignore = FooterWatcher.init(dir: dir)
      refute File.exists?(dir)
    end

    @tag :tmp_dir
    test "footer dir がファイルでも :ignore", %{tmp_dir: tmp} do
      path = Path.join(tmp, "a-file")
      File.write!(path, "not a dir")

      assert :ignore = FooterWatcher.init(dir: path)
      assert File.regular?(path)
    end
  end
end
