defmodule KaoiroServer.DetsStorePath do
  @moduledoc false

  @default_dir "kaoiro-dets"

  def default_path(filename) when is_binary(filename) do
    Path.join([System.tmp_dir!(), @default_dir, filename])
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
