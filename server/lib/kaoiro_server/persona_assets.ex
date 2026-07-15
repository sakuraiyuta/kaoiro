defmodule KaoiroServer.PersonaAssets do
  @moduledoc """
  Persona pack ingest and manifest builder (ADR-0029, phase-10).

  Reads zip persona packs from a single ingest directory (config
  `:persona_dir`, default `priv/persona-packs/` inside the app dir) and
  builds the derived state served over the wire: the sprite manifest for
  `GET /api/personas`, per-persona sprite hashes for byte serving, and
  per-persona personality prompts for the wrapper handshake push
  (`persona_prompt`, WrapperChannel).

  Extraction is content-addressed under `<ingest_dir>/.cache/<sha-prefix>/`
  so a rebuild after an unchanged zip is a hash check, not a re-extract;
  cache entries whose source zip is gone are collected on rebuild. Zip
  validation follows persona-pack-schema.md — required manifest fields,
  the 7 sprite states, `min_kaoiro_version` under the server's own
  version — and a zip that fails any check is dropped with a warning
  (partial ingest, not fatal, so one bad drop cannot lock the whole set).

  The result is cached in `:persistent_term`; `rebuild/0` rescans and
  replaces it. `KaoiroServer.PersonaWatcher` calls `rebuild/0` on
  filesystem events (ADR-0029 F6).
  """

  require Logger

  @cache_key {__MODULE__, :cache}

  # Set/file names become URL path segments; allow the same safe charset
  # as agent_id (protocol.md) and skip anything else.
  @safe_name ~r/^[A-Za-z0-9._-]+$/

  # Common footer appended after every pack's personality prompt (ADR-0029
  # D5). Server-side concat (F5); wrappers inject the received string
  # verbatim. Carries the peer-routing contract (ADR-0038) as a soft guard:
  # a proper-name collaboration request resolves to an existing kaoiro peer
  # via list_agents, never a same-named internal sub-agent.
  @common_footer """
  このエージェントは kaoiro クライアント越しに操作されています。

  固有名(人名・ペルソナ名)で他エージェントとの共同作業を指示されたら、
  相手は既存の kaoiro peer です。まず list_agents で解決すること。
  1件なら send_to_agent で委任、複数なら operator に確認、0件なら
  「該当ペルソナが見当たりません」と報告する。0件でも同名の内部サブ
  エージェントを代替生成しないこと。内部サブエージェントは、明示的に
  指示されたときに限り役割名(persona 名ではない)で作る。実際に
  send_to_agent で送受信するまで、共同作業・共同調査が済んだかのように
  報告しないこと。
  """

  # The 7 UI states a pack MUST provide sprites for (persona-pack-schema
  # states MUST). Order does not matter here — the check is set equality.
  @required_states ~w(idle thinking tool_running waiting_input
                       waiting_permission done error)

  # The reserved persona (personas.md「デフォルトペルソナ」, #35). Always
  # "known" for the join-time reject check even without a pack: it exists
  # to let a wrapper spawn without any personality (footer-only prompt).
  @default_persona_id "default"

  # Server-authoritative object for the reserved persona. Used by
  # `all_personas/0` so callers see the same shape as pack-derived entries
  # (ADR-0031: default is treated as a first-class id in policy checks).
  @default_persona %{
    "id" => @default_persona_id,
    "name" => "デフォルト",
    "sprite_set" => "default"
  }

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

  @doc "Rescans the ingest dir and replaces the cache."
  def rebuild do
    :persistent_term.put(@cache_key, build())
    :ok
  end

  @doc """
  Short content-hash used as the `?v=` cache-busting param. Single
  source for manifest URL generation and the controller's check that
  only manifest-issued `?v=` values earn immutable caching.
  """
  def version_param(hash), do: String.slice(hash, 0, 12)

  @doc """
  Whether `persona_id` is a spawnable persona: an ingested pack's id
  OR the reserved `default`. WrapperChannel gates join on this so a
  wrapper naming a persona server has never heard of is refused
  (ADR-0029 F3, wire in protocol.md「人格プロンプト配送」).
  """
  def known_persona?(persona_id) when is_binary(persona_id) do
    persona_id == @default_persona_id or
      MapSet.member?(cache().known_ids, persona_id)
  end

  def known_persona?(_), do: false

  @doc """
  All spawnable personas as `[%{"id" => ..., "name" => ..., "sprite_set"
  => ...}, ...]`, including the reserved `default` at the head. The
  server-authoritative pool that `HostRegistry` filters via each host's
  policy (ADR-0031). Order: `default` first, then pack entries sorted
  by id for stability.
  """
  def all_personas do
    packs =
      cache().personas_by_id
      |> Map.values()
      |> Enum.sort_by(& &1["id"])

    [@default_persona | packs]
  end

  @doc """
  Final prompt string for `persona_id` — the ready-to-inject `append`
  the wrapper hands to Claude Agent SDK's systemPrompt. Composes
  `personality.md` body + common footer (ADR-0029 F5). For the reserved
  `default` (no pack), returns the footer alone. Returns nil for an
  unknown id; the caller (WrapperChannel) checks `known_persona?/1`
  first so a nil here means "known but pack lost between rebuilds",
  which the caller handles as a fail-closed reject.
  """
  def prompt(persona_id) when is_binary(persona_id) do
    cond do
      persona_id == @default_persona_id ->
        @common_footer

      body = Map.get(cache().personalities, persona_id) ->
        body <> "\n\n" <> @common_footer

      true ->
        nil
    end
  end

  def prompt(_), do: nil

  @doc "Common footer, exposed for tests and diagnostics."
  def common_footer, do: @common_footer

  @doc "Ingest directory currently in use (absolute path)."
  def ingest_dir, do: resolve_ingest_dir()

  defp cache do
    with nil <- :persistent_term.get(@cache_key, nil) do
      rebuild()
      :persistent_term.get(@cache_key)
    end
  end

  # Ingest dir precedence: explicit env `:persona_dir` wins so an
  # operator can override; otherwise fall back to a bundled default that
  # ships with the app dir so `mix phx.server` from a fresh checkout still
  # sees the reference 4 packs without env setup (decision Q1-A).
  defp resolve_ingest_dir do
    case Application.get_env(:kaoiro_server, :persona_dir) do
      dir when is_binary(dir) and dir != "" -> dir
      _ -> Application.app_dir(:kaoiro_server, "priv/persona-packs")
    end
  end

  defp build do
    dir = resolve_ingest_dir()

    unless File.dir?(dir) do
      Logger.warning("persona ingest dir not found: #{dir}")
    end

    zips = list_zips(dir)
    cache_dir = Path.join(dir, ".cache")
    File.mkdir_p!(cache_dir)

    packs =
      zips
      |> Enum.map(&extract_and_load(&1, cache_dir))
      |> Enum.reject(&is_nil/1)

    packs = drop_duplicate_ids(packs)
    reclaim_cache(cache_dir, packs)

    files = build_files(packs)
    personalities = Map.new(packs, fn p -> {p.manifest["id"], p.personality} end)
    known_ids = MapSet.new(packs, fn p -> p.manifest["id"] end)

    personas_by_id =
      Map.new(packs, fn p ->
        {p.manifest["id"],
         %{
           "id" => p.manifest["id"],
           "name" => p.manifest["name"],
           "sprite_set" => p.manifest["sprite_set"]
         }}
      end)

    %{
      manifest: build_manifest(packs, files),
      files: files,
      personalities: personalities,
      known_ids: known_ids,
      personas_by_id: personas_by_id
    }
  end

  defp list_zips(dir) do
    case File.ls(dir) do
      {:ok, names} ->
        for name <- Enum.sort(names),
            Path.extname(name) == ".zip",
            File.regular?(Path.join(dir, name)),
            do: Path.join(dir, name)

      {:error, _reason} ->
        []
    end
  end

  # Extract a zip into `<cache_dir>/<sha-prefix>/`; skip when the target
  # already holds a fresh extraction of the same content (mtime cheap
  # check + hash pinning). Returns %{manifest, personality, sprites,
  # cache_key} or nil on any validation failure (logged and skipped so
  # one bad pack does not sink the whole rebuild).
  defp extract_and_load(zip_path, cache_dir) do
    with {:ok, hash} <- hash_file(zip_path),
         extracted_dir <- Path.join(cache_dir, hash),
         :ok <- ensure_extracted(zip_path, extracted_dir),
         {:ok, manifest} <- read_manifest(extracted_dir),
         :ok <- validate_manifest(manifest, zip_path),
         :ok <- validate_min_version(manifest, zip_path),
         {:ok, personality} <- read_personality(extracted_dir),
         {:ok, sprites} <- collect_sprites(extracted_dir, manifest["sprite_set"]) do
      %{
        cache_key: hash,
        manifest: manifest,
        personality: personality,
        sprites: sprites
      }
    else
      {:error, reason} ->
        Logger.warning("skip persona pack #{Path.basename(zip_path)}: #{reason}")
        nil
    end
  end

  # SHA256 of the whole zip file. The short prefix (16 hex) drives cache
  # dir naming so the cache-key survives content changes but stays short
  # enough for filesystem listings.
  defp hash_file(path) do
    try do
      hash =
        File.stream!(path, 65_536)
        |> Enum.reduce(:crypto.hash_init(:sha256), &:crypto.hash_update(&2, &1))
        |> :crypto.hash_final()
        |> Base.encode16(case: :lower)
        |> String.slice(0, 16)

      {:ok, hash}
    rescue
      e -> {:error, "read failed: #{Exception.message(e)}"}
    end
  end

  # Idempotent: skip when the cache dir already exists (its name is the
  # content hash, so presence proves freshness). Otherwise wipe any
  # stale target, extract with :zip, and mark done. `:zip.unzip`'s
  # `cwd` charlist target is the extract root.
  defp ensure_extracted(zip_path, extracted_dir) do
    if File.dir?(extracted_dir) and File.exists?(Path.join(extracted_dir, "manifest.json")) do
      :ok
    else
      File.rm_rf!(extracted_dir)
      File.mkdir_p!(extracted_dir)

      case :zip.unzip(String.to_charlist(zip_path), cwd: String.to_charlist(extracted_dir)) do
        {:ok, _files} -> :ok
        {:error, reason} -> {:error, "unzip failed: #{inspect(reason)}"}
      end
    end
  end

  defp read_manifest(dir) do
    path = Path.join(dir, "manifest.json")

    with {:ok, bin} <- File.read(path),
         {:ok, parsed} <- Jason.decode(bin) do
      {:ok, parsed}
    else
      {:error, %Jason.DecodeError{} = e} ->
        {:error, "invalid manifest.json: #{Exception.message(e)}"}

      {:error, reason} ->
        {:error, "manifest.json read failed: #{inspect(reason)}"}
    end
  end

  # Required fields + charset + states (persona-pack-schema.md).
  # Rejects a whole zip on any breach; better to skip a malformed pack
  # than half-ingest it.
  defp validate_manifest(manifest, _zip_path) do
    required = ~w(id name sprite_set version license min_kaoiro_version states)

    cond do
      missing = Enum.find(required, fn f -> not Map.has_key?(manifest, f) end) ->
        {:error, "manifest missing field: #{missing}"}

      not string?(manifest["id"]) or not Regex.match?(@safe_name, manifest["id"]) ->
        {:error, "manifest.id must match #{inspect(@safe_name.source)}"}

      manifest["id"] == @default_persona_id ->
        {:error, "manifest.id '#{@default_persona_id}' is reserved"}

      not string?(manifest["sprite_set"]) or not Regex.match?(@safe_name, manifest["sprite_set"]) ->
        {:error, "manifest.sprite_set must match #{inspect(@safe_name.source)}"}

      not string?(manifest["name"]) ->
        {:error, "manifest.name must be a string"}

      not string?(manifest["version"]) ->
        {:error, "manifest.version must be a string"}

      not string?(manifest["license"]) ->
        {:error, "manifest.license must be a string"}

      not string?(manifest["min_kaoiro_version"]) ->
        {:error, "manifest.min_kaoiro_version must be a string"}

      not (is_list(manifest["states"]) and
               MapSet.new(manifest["states"]) == MapSet.new(@required_states)) ->
        {:error, "manifest.states must be exactly #{inspect(@required_states)}"}

      true ->
        :ok
    end
  end

  defp string?(value), do: is_binary(value) and value != ""

  # min_kaoiro_version <= server vsn; parse via Version to catch prerelease
  # / build metadata correctly. A malformed version on either side falls
  # back to accepting the pack — the strict enforcement is enough of a
  # gate; we do not want to reject packs because our own version string
  # is odd.
  defp validate_min_version(manifest, _zip_path) do
    server = server_version()
    required = manifest["min_kaoiro_version"]

    with {:ok, req} <- Version.parse(required),
         {:ok, srv} <- Version.parse(server) do
      if Version.compare(srv, req) == :lt do
        {:error, "server v#{server} < pack min_kaoiro_version v#{required}"}
      else
        :ok
      end
    else
      _ -> :ok
    end
  end

  defp server_version do
    case :application.get_key(:kaoiro_server, :vsn) do
      {:ok, vsn} -> to_string(vsn)
      _ -> "0.0.0"
    end
  end

  defp read_personality(dir) do
    path = Path.join(dir, "personality.md")

    case File.read(path) do
      {:ok, bin} -> {:ok, String.trim(bin)}
      {:error, reason} -> {:error, "personality.md read failed: #{inspect(reason)}"}
    end
  end

  # sprites/ MUST contain the 7 states as `<state>.png` (persona-pack-
  # schema.md). Each PNG's hash rides into the manifest for cache-busting.
  defp collect_sprites(dir, sprite_set) do
    sprites_dir = Path.join(dir, "sprites")

    case File.ls(sprites_dir) do
      {:ok, _names} ->
        entries =
          for state <- @required_states, into: %{} do
            file = "#{state}.png"
            path = Path.join(sprites_dir, file)
            {state, %{file: file, path: path}}
          end

        missing =
          Enum.find(@required_states, fn state ->
            not File.regular?(entries[state].path)
          end)

        if missing do
          {:error, "sprites/#{missing}.png missing"}
        else
          hashed =
            for {state, %{file: file, path: path}} <- entries, into: %{} do
              hash = :crypto.hash(:sha256, File.read!(path)) |> Base.encode16(case: :lower)
              {state, %{sprite_set: sprite_set, file: file, path: path, hash: hash}}
            end

          {:ok, hashed}
        end

      {:error, _reason} ->
        {:error, "sprites/ missing"}
    end
  end

  # First-writer-wins on duplicate manifest.id (persona-pack-schema.md
  # MUST). Deterministic thanks to the sorted zip listing so the winner
  # is stable across restarts.
  defp drop_duplicate_ids(packs) do
    {kept, _seen} =
      Enum.reduce(packs, {[], MapSet.new()}, fn pack, {kept, seen} ->
        id = pack.manifest["id"]

        if MapSet.member?(seen, id) do
          Logger.warning("duplicate persona.id: #{id} (kept the first)")
          {kept, seen}
        else
          {[pack | kept], MapSet.put(seen, id)}
        end
      end)

    Enum.reverse(kept)
  end

  # Any cache sub-dir whose name is not the current cache_key of some
  # pack is stale (its source zip changed or was removed) and gets
  # dropped. Keeps disk from growing with each pack revision.
  defp reclaim_cache(cache_dir, packs) do
    live = MapSet.new(packs, fn p -> p.cache_key end)

    case File.ls(cache_dir) do
      {:ok, entries} ->
        for entry <- entries,
            path = Path.join(cache_dir, entry),
            File.dir?(path),
            not MapSet.member?(live, entry) do
          File.rm_rf(path)
        end

      _ ->
        :ok
    end

    :ok
  end

  # {{sprite_set, file_name}, %{path, hash}} for controller lookup.
  defp build_files(packs) do
    for pack <- packs,
        {_state, %{sprite_set: set, file: file, path: path, hash: hash}} <- pack.sprites,
        into: %{} do
      {{set, file}, %{path: path, hash: hash}}
    end
  end

  # Extended manifest (protocol.md `GET /api/personas`): the phase-9
  # sprite manifest gains `name` / `pack_version` / `description`
  # transcribed from each pack's manifest.json.
  defp build_manifest(packs, files) do
    personas =
      for pack <- packs, into: %{} do
        set = pack.manifest["sprite_set"]

        states =
          for {state, %{file: file, hash: hash}} <- pack.sprites, into: %{} do
            {state,
             %{
               "url" => "/personas/#{set}/#{file}?v=#{version_param(hash)}",
               "hash" => "sha256:#{hash}"
             }}
          end

        entry =
          %{
            "name" => pack.manifest["name"],
            "pack_version" => pack.manifest["version"],
            "states" => states
          }
          |> maybe_put("description", pack.manifest["description"])

        {set, entry}
      end

    %{"version" => manifest_version(files), "personas" => personas}
  end

  defp maybe_put(map, key, value) when is_binary(value) and value != "",
    do: Map.put(map, key, value)

  defp maybe_put(map, _key, _value), do: map

  # Content-derived manifest version: clients re-fetch sprite URLs only
  # when this changes (ADR-0008 incremental sync, ADR-0029 auto-watch).
  defp manifest_version(files) do
    files
    |> Enum.map(fn {{set, file}, %{hash: hash}} -> "#{set}/#{file}:#{hash}" end)
    |> Enum.sort()
    |> Enum.join("\n")
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
    |> String.slice(0, 16)
  end
end
