defmodule KaoiroServer.OAuthAllowlistFixture do
  @moduledoc """
  Writes a throwaway OAuth allow-list file and points
  `:oauth_allowlist_path` at it for the duration of the test (ADR-0042).

  The file name carries a suffix that is unique ACROSS BEAMs, and
  `on_exit` removes it. `System.unique_integer/1` alone is not enough:
  `config/test.exs` records that it collides between concurrent
  `mix test` invocations (measured), which is why every DETS store there
  uses an OS-pid + crypto run nonce. Two runs sharing a path here would
  have one overwrite or delete the other's allow-list mid-assertion —
  and the allow-list is fail-closed, so the victim run sees a spurious
  `nil` role.

  `on_exit` also puts `:oauth_allowlist_path` back to the value it had
  before the call (unset stays unset). A key left pointing at the removed
  file outlived its test and, once another test restarted the application,
  started a module-named `OAuthAllowlistWatcher` under the application
  supervisor (issue 923). `on_exit` callbacks run last-registered-first, so
  a `delete_env` a caller registers after this call runs before the
  restore; both end unset when the key was unset before.
  """

  @doc "Writes `contents` and configures it as the allow-list. Returns the path."
  @spec put_allowlist(binary()) :: binary()
  def put_allowlist(contents) do
    nonce = Base.url_encode64(:crypto.strong_rand_bytes(8), padding: false)

    path =
      Path.join(
        System.tmp_dir!(),
        "kaoiro_test_allowlist_#{System.pid()}_#{nonce}"
      )

    previous = Application.fetch_env(:kaoiro_server, :oauth_allowlist_path)
    File.write!(path, contents)

    ExUnit.Callbacks.on_exit(fn ->
      File.rm(path)
      restore_allowlist_path(previous)
    end)

    Application.put_env(:kaoiro_server, :oauth_allowlist_path, path)

    path
  end

  defp restore_allowlist_path(:error),
    do: Application.delete_env(:kaoiro_server, :oauth_allowlist_path)

  defp restore_allowlist_path({:ok, value}),
    do: Application.put_env(:kaoiro_server, :oauth_allowlist_path, value)

  @doc """
  Replaces the allow-list at `path` with `contents` while the watcher may be
  reading it. The new content goes to a temp file in the same directory,
  which is then renamed over `path`, so a concurrent reader sees the old or
  the new file and never a truncated one (issue 554). The temp file is
  removed if the rename fails.
  """
  @spec rewrite!(binary(), binary()) :: :ok
  def rewrite!(path, contents) do
    tmp = "#{path}.tmp-#{System.unique_integer([:positive])}"

    try do
      File.write!(tmp, contents)
      File.rename!(tmp, path)
    after
      _ = File.rm(tmp)
    end

    :ok
  end
end
