defmodule KaoiroServer.OAuthAllowlistFixtureTest do
  # rewrite!/2 must never expose a truncated allow-list to a concurrent reader
  # (issue 554). A fixture that rewrites in place fails the first test.
  use ExUnit.Case, async: false

  import KaoiroServer.OAuthAllowlistFixture

  @full "github:ao:operator\ngoogle:a@example.com:viewer\ngoogle:b@example.com:viewer\ngithub:c:operator\n"
  @writes 3_000

  test "a concurrent reader never sees an empty or partial allow-list" do
    path = put_allowlist(@full)
    flag = :atomics.new(1, [])
    reader = Task.async(fn -> read_until_done(path, flag, {0, 0}) end)

    for _ <- 1..@writes, do: rewrite!(path, @full)
    :atomics.put(flag, 1, 1)

    assert {reads, bad} = Task.await(reader, 60_000)
    assert reads > 0
    assert bad == 0
  end

  test "a failed rewrite removes its temp file" do
    dir = Path.join(System.tmp_dir!(), "kaoiro-554-rewrite-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)

    # A directory at the target makes the rename fail after the temp file exists.
    target = Path.join(dir, "allowlist")
    File.mkdir_p!(target)

    assert_raise File.RenameError, fn -> rewrite!(target, @full) end
    assert Path.wildcard(target <> ".tmp-*") == []
  end

  defp read_until_done(path, flag, {reads, bad}) do
    if :atomics.get(flag, 1) == 1 do
      {reads, bad}
    else
      bad =
        case File.read(path) do
          {:ok, @full} -> bad
          _ -> bad + 1
        end

      read_until_done(path, flag, {reads + 1, bad})
    end
  end
end
