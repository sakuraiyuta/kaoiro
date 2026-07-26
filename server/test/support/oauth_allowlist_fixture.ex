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
  `nil` role. Callers still have to clear `:oauth_allowlist_path`
  themselves, which the OAuth suites already do in their own setup.
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

    File.write!(path, contents)
    ExUnit.Callbacks.on_exit(fn -> File.rm(path) end)
    Application.put_env(:kaoiro_server, :oauth_allowlist_path, path)

    path
  end
end
