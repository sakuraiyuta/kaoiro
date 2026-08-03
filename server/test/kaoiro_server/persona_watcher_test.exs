defmodule KaoiroServer.PersonaWatcherTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.PersonaWatcher

  # ADR-0046 F2 / ふじ S3: the ingest dir may be a `:ro` mount, so a
  # missing one must degrade rather than get created. Pinned here because
  # the old init did `File.mkdir_p!` and nothing caught the regression.
  @tag :tmp_dir
  test "存在しない ingest dir では :ignore を返し、作成もしない", %{tmp_dir: tmp} do
    dir = Path.join(tmp, "not-there")

    assert :ignore = PersonaWatcher.init(dir: dir)
    refute File.exists?(dir)
  end

  @tag :tmp_dir
  test "ingest dir がファイルでも :ignore (dir 化しない)", %{tmp_dir: tmp} do
    path = Path.join(tmp, "a-file")
    File.write!(path, "not a dir")

    assert :ignore = PersonaWatcher.init(dir: path)
    assert File.regular?(path)
  end
end
