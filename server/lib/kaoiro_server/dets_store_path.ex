defmodule KaoiroServer.DetsStorePath do
  @moduledoc false

  @default_dir "kaoiro-dets"

  @doc """
  The fallback path for `filename` when its store's env var is unset.

  Refuses a filename that `KaoiroServer.PersistencePaths` does not declare.
  A store reaching this function is one whose env var is NOT wired, i.e.
  exactly the deployment that would keep its data in the container's
  temporary directory and lose it on the next recreation; if such a store
  is also absent from the canonical list it escapes docker-compose, the
  sample `.env` and the backup set at the same time, silently. That is
  issue #217 (the user ledger), so it fails at the call instead.

  Passing an explicit `:path` does not avoid this: every store resolves its
  path as `Keyword.get(opts, :path, default_path())`, whose default is
  evaluated eagerly, so an undeclared filename raises even when the caller
  never uses the result. Declare the store in `PersistencePaths` — do not
  route around the check with `Keyword.get_lazy/3`, which would reopen
  exactly the silent escape above.
  """
  def default_path(filename) when is_binary(filename) do
    if not declared?(filename) do
      raise ArgumentError,
            "#{filename} is not declared in KaoiroServer.PersistencePaths. " <>
              "A DETS store missing from that list escapes docker-compose, " <>
              "server/.env.example and the backup set (issue #217). Add an " <>
              "entry there. An explicit :path does not help — the default " <>
              "is evaluated eagerly at every store's start_link."
    end

    Path.join([System.tmp_dir!(), @default_dir, filename])
  end

  defp declared?(filename) do
    Enum.any?(KaoiroServer.PersistencePaths.stores(), &(&1.default_file == filename))
  end

  def prepare_parent!(path) when is_binary(path) do
    parent = Path.dirname(path)

    if Path.expand(parent) == Path.expand(System.tmp_dir!()) do
      raise ArgumentError,
            "DETS files must be placed below a dedicated directory, not directly in #{System.tmp_dir!()}"
    end

    File.mkdir_p!(parent)
    # DETS has no creation-mode option; the owner-only parent protects the
    # post-open file chmod window.
    File.chmod!(parent, 0o700)
  end
end
