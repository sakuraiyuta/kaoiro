defmodule KaoiroServer.PersonaAssets do
  @moduledoc """
  Persona sprite scanning and manifest building (ADR-0008 stage 1).

  The bundled reference pack lives in `priv/personas`; the overlay
  directory (`KAOIRO_PERSONA_DIR` via the `:persona_dir` config) takes
  precedence per sprite set — a bundled set is used only when the
  overlay has no directory of the same name (specs/personas.md).

  The scan result is cached in `:persistent_term` at boot. `rebuild/0`
  rescans; with no upload API yet (ADR-0008 stage 2), assets change
  only on deploy or restart.
  """

  require Logger

  @cache_key {__MODULE__, :cache}

  # Set/file names become URL path segments; allow the same safe
  # charset as agent_id (protocol.md) and skip anything else.
  @safe_name ~r/^[A-Za-z0-9._-]+$/

  @doc "Manifest map as served by `GET /api/personas` (string keys)."
  def manifest, do: cache().manifest

  @doc """
  Resolved file entry (`%{path: abs_path, hash: hex}`) for a scanned
  sprite file, or `:error`. Serving only manifest-known files keeps
  request paths away from the filesystem (no traversal surface).
  """
  def fetch_file(sprite_set, file_name) do
    Map.fetch(cache().files, {sprite_set, file_name})
  end

  @doc "Rescans the sprite roots and replaces the cache."
  def rebuild do
    :persistent_term.put(@cache_key, build(roots()))
    :ok
  end

  @doc """
  Short content-hash used as the `?v=` cache-busting param. Single
  source for manifest URL generation and the controller's check that
  only manifest-issued `?v=` values earn immutable caching.
  """
  def version_param(hash), do: String.slice(hash, 0, 12)

  defp cache do
    with nil <- :persistent_term.get(@cache_key, nil) do
      rebuild()
      :persistent_term.get(@cache_key)
    end
  end

  defp roots do
    bundled = Application.app_dir(:kaoiro_server, "priv/personas")

    case Application.get_env(:kaoiro_server, :persona_dir) do
      nil ->
        [bundled]

      overlay ->
        unless File.dir?(overlay) do
          Logger.warning("persona overlay dir not found: #{overlay}")
        end

        [overlay, bundled]
    end
  end

  defp build(roots) do
    sets =
      roots
      |> Enum.flat_map(&sprite_set_dirs/1)
      # Overlay root comes first, so its sets win over bundled ones.
      |> Enum.uniq_by(fn {set, _dir} -> set end)
      |> Enum.sort()

    files =
      for {set, dir} <- sets, file <- sprite_files(dir), into: %{} do
        path = Path.join(dir, file)

        hash =
          :crypto.hash(:sha256, File.read!(path))
          |> Base.encode16(case: :lower)

        {{set, file}, %{path: path, hash: hash}}
      end

    %{manifest: build_manifest(files), files: files}
  end

  defp build_manifest(files) do
    personas =
      files
      |> Enum.sort()
      |> Enum.group_by(fn {{set, _file}, _entry} -> set end)
      |> Map.new(fn {set, entries} ->
        states =
          Map.new(entries, fn {{^set, file}, %{hash: hash}} ->
            state = Path.rootname(file)

            {state,
             %{
               "url" => "/personas/#{set}/#{file}?v=#{version_param(hash)}",
               "hash" => "sha256:#{hash}"
             }}
          end)

        {set, %{"states" => states}}
      end)

    %{"version" => manifest_version(files), "personas" => personas}
  end

  # Content-derived manifest version: clients re-fetch sprite URLs only
  # when this changes (ADR-0008 incremental sync).
  defp manifest_version(files) do
    files
    |> Enum.map(fn {{set, file}, %{hash: hash}} -> "#{set}/#{file}:#{hash}" end)
    |> Enum.sort()
    |> Enum.join("\n")
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
    |> String.slice(0, 16)
  end

  defp sprite_set_dirs(root) do
    case File.ls(root) do
      {:ok, names} ->
        for name <- Enum.sort(names),
            Regex.match?(@safe_name, name),
            File.dir?(Path.join(root, name)),
            do: {name, Path.join(root, name)}

      {:error, _reason} ->
        []
    end
  end

  defp sprite_files(dir) do
    case File.ls(dir) do
      {:ok, names} ->
        for name <- Enum.sort(names),
            Path.extname(name) == ".png",
            Regex.match?(@safe_name, name),
            File.regular?(Path.join(dir, name)),
            do: name

      {:error, _reason} ->
        []
    end
  end
end
