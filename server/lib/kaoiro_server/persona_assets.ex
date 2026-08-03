defmodule KaoiroServer.PersonaAssets do
  @moduledoc """
  Persona pack ingest and manifest builder (ADR-0029, phase-10).

  Reads zip persona packs from a single ingest directory (config
  `:persona_dir`, default `priv/persona-packs/` inside the app dir) and
  builds the derived state served over the wire: the sprite manifest for
  `GET /api/personas`, per-persona sprite hashes for byte serving, and
  per-persona personality prompts for the wrapper handshake push
  (`persona_prompt`, WrapperChannel).

  Nothing is ever written to the ingest dir — it may be a `:ro` mount
  (ADR-0046 F2). Extraction is content-addressed under
  `<cache_root>/<sha-prefix>/`, where the root is `KAOIRO_PERSONA_CACHE_DIR`
  or, unset, a tmp path namespaced by the ingest dir's hash (F1). A
  rebuild after an unchanged zip is therefore a hash check, not a
  re-extract; cache entries whose source zip is gone are collected on
  rebuild, and only entries shaped like a cache key are ever collected
  (F3). A failed rebuild aborts the boot, but a later one only logs and
  keeps the current manifest (F4).

  Zip validation follows persona-pack-schema.md — required manifest
  fields, the 7 sprite states, `min_kaoiro_version` under the server's
  own version — and a zip that fails any check is dropped with a warning
  (partial ingest, not fatal, so one bad drop cannot lock the whole set).

  The result is cached in `:persistent_term`; `rebuild/0` rescans and
  replaces it. `KaoiroServer.PersonaWatcher` calls `rebuild/0` on
  filesystem events (ADR-0029 F6).
  """

  require Logger

  alias KaoiroServer.FooterAssets

  @cache_key {__MODULE__, :cache}

  # Last (root, mode) pair warned about by `warn_if_writable_by_others/2`.
  # One entry, overwritten — a dedup marker, not a set.
  @warned_key {__MODULE__, :warned_cache_root}

  # Set/file names become URL path segments; allow the same safe charset
  # as agent_id (protocol.md) and skip anything else.
  @safe_name ~r/^[A-Za-z0-9._-]+$/

  # Shape of an extraction cache dir name: the 16-hex prefix `hash_file/1`
  # produces. Reclaim only ever considers entries matching this.
  @cache_key_name ~r/^[0-9a-f]{16}$/

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

  @doc """
  Rescans the ingest dir and replaces the cache.

  Failure contract (ADR-0046 F4): a failed rebuild raises on cold start —
  a server that cannot extract packs must not come up pretending it has
  none — but on a later rebuild it only logs and leaves the current
  manifest in place as the last-known-good.
  """
  def rebuild do
    cold_start? = :persistent_term.get(@cache_key, nil) == nil

    case attempt_build() do
      {:ok, cache} ->
        :persistent_term.put(@cache_key, cache)
        :ok

      {:error, reason} when cold_start? ->
        raise "persona rebuild failed on cold start: #{reason}"

      {:error, reason} ->
        Logger.error("persona rebuild failed: #{reason}; keeping the last-known-good manifest")

        :ok
    end
  end

  # F4 covers "a rebuild failed", not just "the cache root was unusable".
  # Two paths lead here: `build/1` reports cache I/O failures as
  # `{:error, _}` (see `classify_zip_error/1`), and the extraction path's
  # remaining bang calls raise. Rescuing File.Error routes the latter
  # into the same contract instead of killing the caller (PersonaWatcher,
  # whose repeated crashes would take the supervisor down with them). The
  # rescue stays narrow on purpose — a logic bug must still crash rather
  # than masquerade as a degraded filesystem (ふじ M1, 2026-08-03).
  defp attempt_build do
    with {:ok, cache_dir} <- ensure_cache_dir() do
      build(cache_dir)
    end
  rescue
    e in File.Error -> {:error, Exception.message(e)}
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
  `personality.md` body + system footer + user footer (ADR-0029 F5,
  ADR-0045 F2). For the reserved `default` (no pack), returns the footer
  layers alone. Returns nil for an unknown id; the caller
  (WrapperChannel) checks `known_persona?/1` first so a nil here means
  "known but pack lost between rebuilds", which the caller handles as a
  fail-closed reject.
  """
  def prompt(persona_id) when is_binary(persona_id) do
    cond do
      persona_id == @default_persona_id ->
        compose(nil)

      body = Map.get(cache().personalities, persona_id) ->
        compose(body)

      true ->
        nil
    end
  end

  def prompt(_), do: nil

  # `personality → system-footer → user-footer`, blank-line separated
  # (ADR-0045 F2). The footer snapshot is read ONCE so the two footer
  # layers cannot straddle a rebuild, and it lives under FooterAssets'
  # own key — a pack rebuild replacing our cache cannot roll it back.
  defp compose(personality) do
    %{system: system, user: user} = FooterAssets.snapshot()

    [personality, system, user]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n\n")
  end

  @doc "Ingest directory currently in use (absolute path)."
  def ingest_dir, do: resolve_ingest_dir()

  @doc "Extraction cache root currently in use (ADR-0046 F1)."
  def cache_dir, do: resolve_cache_dir()

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

  # Extraction cache root (ADR-0046 F1). Explicit env wins; otherwise a
  # tmp dir namespaced by the ingest dir's hash, so two servers pointed
  # at different pack dirs cannot share (and clobber) one cache. The
  # path is expanded first — a relative `:persona_dir` or a different cwd
  # must not move the namespace. The cache is derived from the zips, so
  # losing it to a tmp sweep only costs one re-extraction.
  defp resolve_cache_dir do
    case Application.get_env(:kaoiro_server, :persona_cache_dir) do
      dir when is_binary(dir) and dir != "" -> dir
      _ -> default_cache_dir()
    end
  end

  defp default_cache_dir do
    key =
      resolve_ingest_dir()
      |> Path.expand()
      |> then(&:crypto.hash(:sha256, &1))
      |> Base.encode16(case: :lower)
      |> String.slice(0, 16)

    Path.join(System.tmp_dir!(), "kaoiro-persona-cache-" <> key)
  end

  # ADR-0046 F4 needs "unusable" decided BEFORE any pack is touched, so
  # probe creation and writability up front rather than discovering it
  # halfway through an extraction.
  defp ensure_cache_dir do
    dir = resolve_cache_dir()

    with :ok <- File.mkdir_p(dir),
         :ok <- verify_cache_root(dir),
         :ok <- probe_writable(dir) do
      {:ok, dir}
    else
      {:error, reason} -> {:error, "cache dir unusable: #{dir}: #{inspect(reason)}"}
    end
  end

  # The DEFAULT root is a predictable name in a world-writable tmp dir,
  # so a local user could pre-create it and hand us extraction dirs whose
  # personality.md rides into every agent's prompt. `File.chmod/2` fails
  # with :eperm unless we own the directory — the ownership check the
  # BEAM otherwise cannot express — and takes the mode to 0700 besides.
  # An explicitly configured root is the operator's own choice: probe it,
  # do not police it. The lstat guard applies to both, since a symlinked
  # root defeats either.
  defp verify_cache_root(dir) do
    case File.lstat(dir) do
      {:ok, %File.Stat{type: :directory} = stat} ->
        if dir == default_cache_dir() do
          File.chmod(dir, 0o700)
        else
          warn_if_writable_by_others(dir, stat)
          :ok
        end

      {:ok, %File.Stat{type: type}} ->
        {:error, {:not_a_directory, type}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # We do not force an explicit root's mode down (that would break a
  # perfectly deliberate shared-group setup), but a group/world-writable
  # one lets any local user plant an extraction dir whose personality.md
  # rides into every agent's prompt. Say so rather than silently accept.
  #
  # Once per (root, mode), not once per rebuild: a watcher-driven server
  # rebuilds on every pack drop, and a warning that repeats forever is one
  # nobody reads (the reasoning ADR-0045 F5 used to reject a length
  # threshold). A mode change re-arms it.
  defp warn_if_writable_by_others(dir, %File.Stat{mode: mode}) do
    mode = Bitwise.band(mode, 0o7777)
    seen = {dir, mode}

    if Bitwise.band(mode, 0o022) != 0 and :persistent_term.get(@warned_key, nil) != seen do
      :persistent_term.put(@warned_key, seen)

      Logger.warning(
        "persona cache root #{dir} is group/world-writable " <>
          "(mode #{Integer.to_string(mode, 8)}); a local user can plant " <>
          "extraction dirs the server will trust"
      )
    end

    :ok
  end

  # `:exclusive` (O_CREAT|O_EXCL) refuses to follow a symlink, so a
  # pre-planted `.write-probe` cannot redirect the write and truncate
  # someone else's file.
  defp probe_writable(dir) do
    path = Path.join(dir, ".write-probe")
    File.rm(path)

    case File.open(path, [:write, :exclusive]) do
      {:ok, io} ->
        File.close(io)
        File.rm(path)
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp build(cache_dir) do
    dir = resolve_ingest_dir()

    unless File.dir?(dir) do
      # ADR-0046 F2: never create it — the ingest dir may be a `:ro`
      # mount. An empty manifest plus this warning is the whole
      # degradation; enabling it later takes a restart.
      Logger.warning("persona ingest dir not found: #{dir}")
    end

    case load_packs(list_zips(dir), cache_dir) do
      {:cache_error, reason} -> {:error, reason}
      packs -> {:ok, assemble(drop_duplicate_ids(packs), cache_dir)}
    end
  end

  # A pack that fails validation is skipped (partial ingest); a cache I/O
  # failure stops the whole rebuild so `rebuild/0` can apply the F4
  # contract instead of publishing a manifest that silently lost packs.
  # Halting on the first one avoids grinding every remaining zip through
  # a filesystem we already know is broken.
  defp load_packs(zips, cache_dir) do
    Enum.reduce_while(zips, [], fn zip, acc ->
      case extract_and_load(zip, cache_dir) do
        {:cache_error, _reason} = error -> {:halt, error}
        nil -> {:cont, acc}
        pack -> {:cont, [pack | acc]}
      end
    end)
    |> case do
      {:cache_error, _reason} = error -> error
      packs -> Enum.reverse(packs)
    end
  end

  defp assemble(packs, cache_dir) do
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
  # cache_key}, nil on a validation failure (logged and skipped so one
  # bad pack does not sink the whole rebuild), or `{:cache_error, reason}`
  # when the cache itself could not be read or written — that one is not
  # this pack's fault and must not be downgraded to a skip (ふじ M1,
  # 2026-08-03).
  defp extract_and_load(zip_path, cache_dir) do
    with {:ok, hash} <- hash_file(zip_path),
         extracted_dir <- Path.join(cache_dir, hash),
         :ok <- ensure_extracted(zip_path, extracted_dir, cache_dir),
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
      {:cache_error, _reason} = error ->
        error

      {:error, reason} ->
        Logger.warning("skip persona pack #{Path.basename(zip_path)}: #{reason}")
        nil
    end
  end

  # Posix reasons that mean "the cache volume is broken", nothing else.
  #
  # Errnos an ARCHIVE'S OWN CONTENTS can produce are deliberately absent —
  # :enotdir (an entry `x` colliding with `x/y`, or a `sprites` file where
  # a directory belongs), :eloop, :eisdir, :einval, :enoent. Classifying
  # those as infrastructure would let a single malformed zip halt every
  # rebuild and, on cold start, stop the server from booting at all —
  # exactly the "one bad drop cannot lock the whole set" contract this
  # module is built on (ADR-0029, moduledoc above).
  @cache_posix ~w(erofs enospc edquot eio eperm emfile enfile enomem
                  enodev estale)a

  # :eacces cuts both ways: `:zip.unzip/2` reads the source zip out of the
  # (possibly read-only) ingest dir as well as writing the cache, so it is
  # only infrastructure when the path in the error term is under the cache
  # root.
  @ambiguous_posix ~w(eacces)a

  # `:zip.unzip/2` and `File.read/1` bury the posix reason inside a nested
  # term (`{path, {{:file, :open, _}, :eacces}}` for unzip) whose shape
  # differs per operation and OTP release. The atom is the one stable
  # part, so look for it anywhere in the term.
  defp posix_in?(term, set) when is_atom(term), do: term in set
  defp posix_in?(term, set) when is_tuple(term), do: term |> Tuple.to_list() |> posix_in?(set)
  defp posix_in?(term, set) when is_list(term), do: Enum.any?(term, &posix_in?(&1, set))
  defp posix_in?(_term, _set), do: false

  # `:zip.unzip/2` puts the offending path first in its error term, as a
  # charlist today but as a binary in other file APIs — accept both. Other
  # shapes (a `{:EXIT, {{:badmatch, _}, _}}` from a self-colliding entry)
  # carry no path, and those are archive problems anyway.
  defp error_path({path, _rest}) when is_binary(path), do: path

  defp error_path({path, _rest}) when is_list(path) do
    if path != [] and Enum.all?(path, &(is_integer(&1) and &1 >= 0)) do
      List.to_string(path)
    end
  end

  defp error_path(_term), do: nil

  # The root ITSELF counts as inside it: a failure whose path is exactly
  # the cache root (say the root went read-only) is a cache failure, and a
  # `root <> "/"` prefix alone would miss it. Comparing expanded paths and
  # requiring a separator also keeps a sibling `/cache-old` from matching
  # `/cache`.
  defp under?(nil, _root), do: false

  defp under?(path, root) do
    path = Path.expand(path)
    root = Path.expand(root)

    path == root or String.starts_with?(path, root <> "/")
  end

  @doc false
  # Exposed for the regression test: a real `:zip.unzip` write failure is
  # not reproducible on a normal filesystem (the probe in
  # `ensure_cache_dir/0` already proves the root is writable, so only a
  # full disk or a mid-rebuild remount gets past it), but the term it
  # returns must keep classifying the same way across OTP upgrades.
  def classify_zip_error(reason, cache_dir) do
    if posix_in?(reason, @cache_posix) or
         (posix_in?(reason, @ambiguous_posix) and under?(error_path(reason), cache_dir)) do
      {:cache_error, "unzip failed writing the cache: #{inspect(reason)}"}
    else
      {:error, "unzip failed: #{inspect(reason)}"}
    end
  end

  # These paths are always inside the cache, so :eacces needs no scoping
  # here. A missing or malformed file is still the pack's problem.
  defp classify_cache_read(label, path, reason) do
    if posix_in?(reason, @cache_posix) or posix_in?(reason, @ambiguous_posix) do
      {:cache_error, "#{label} unreadable in the cache: #{path}: #{inspect(reason)}"}
    else
      {:error, "#{label} read failed: #{inspect(reason)}"}
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
  # content hash, so presence proves freshness). Otherwise verify the
  # entry names, wipe any stale target, extract with :zip, and mark done.
  # `:zip.unzip`'s `cwd` charlist target is the extract root.
  defp ensure_extracted(zip_path, extracted_dir, cache_dir) do
    if File.dir?(extracted_dir) and File.exists?(Path.join(extracted_dir, "manifest.json")) do
      :ok
    else
      with :ok <- verify_entry_names(zip_path) do
        File.rm_rf!(extracted_dir)
        File.mkdir_p!(extracted_dir)

        case :zip.unzip(String.to_charlist(zip_path), cwd: String.to_charlist(extracted_dir)) do
          {:ok, _files} -> :ok
          {:error, reason} -> classify_zip_error(reason, cache_dir)
        end
      end
    end
  end

  # ZIP local file header: signature, then 22 bytes of fixed fields, then
  # the name length and extra length — 30 bytes before the name itself.
  @local_header_signature 0x04034B50
  @local_header_size 30

  @doc false
  # `:zip.unzip/2` writes wherever the entry names point: an absolute name
  # or one escaping through `..` lands outside `cwd` entirely (zip slip,
  # CWE-22). Packs are distributable artifacts this module already treats
  # as untrusted, and ADR-0046 put the cache on the same writable volume
  # as the auth DETS ledgers — an escaping entry could overwrite the token
  # denylist, which is the fail-closed source of truth for revocation. So
  # names are checked BEFORE anything is written, and one bad name rejects
  # the whole pack (extraction happens before manifest validation, so no
  # later check can stand in for this one).
  #
  # A ZIP carries every name TWICE: once in the central directory and once
  # in each local file header. `:zip.list_dir/1` reads only the former
  # while `:zip.unzip/2` extracts by the latter, so checking one of them
  # is a bypass — a pack whose central name is `safe.txt` and whose local
  # name is `../../x` passes a central-only guard and then gets extracted
  # (ふじ M1 2 巡目, 2026-08-03, 実機再現済み). Both names are validated
  # here, and they must match byte for byte: a divergence has no legitimate
  # use and is itself grounds to reject.
  def verify_entry_names(zip_path) do
    with {:ok, entries} <- central_entries(zip_path),
         {:ok, fd} <- open_raw(zip_path) do
      try do
        Enum.reduce_while(entries, :ok, fn entry, :ok ->
          case verify_entry(fd, entry) do
            :ok -> {:cont, :ok}
            error -> {:halt, error}
          end
        end)
      after
        File.close(fd)
      end
    end
  end

  defp central_entries(zip_path) do
    case :zip.list_dir(String.to_charlist(zip_path)) do
      {:ok, entries} ->
        named =
          for {:zip_file, name, _info, _comment, offset, _comp_size} <- entries,
              do: {List.to_string(name), offset}

        {:ok, named}

      {:error, reason} ->
        {:error, "cannot list archive: #{inspect(reason)}"}
    end
  end

  defp open_raw(zip_path) do
    case File.open(zip_path, [:read, :binary, :raw]) do
      {:ok, fd} -> {:ok, fd}
      {:error, reason} -> {:error, "cannot open archive: #{inspect(reason)}"}
    end
  end

  defp verify_entry(fd, {central_name, offset}) do
    with :ok <- safe_entry_name(central_name, "central directory"),
         {:ok, local_name} <- read_local_name(fd, offset),
         :ok <- safe_entry_name(local_name, "local header") do
      if local_name == central_name do
        :ok
      else
        {:error,
         "entry name mismatch: central #{inspect(central_name)} " <>
           "vs local #{inspect(local_name)}"}
      end
    end
  end

  defp safe_entry_name(name, where) do
    if Path.safe_relative(name) == :error do
      {:error, "entry escapes the extraction dir (#{where}): #{inspect(name)}"}
    else
      :ok
    end
  end

  defp read_local_name(fd, offset) do
    case :file.pread(fd, offset, @local_header_size) do
      {:ok,
       <<@local_header_signature::little-32, _fixed::binary-size(22), name_len::little-16,
         _extra_len::little-16>>} ->
        read_exact(fd, offset + @local_header_size, name_len)

      {:ok, _other} ->
        {:error, "bad local file header signature at offset #{offset}"}

      _ ->
        {:error, "unreadable local file header at offset #{offset}"}
    end
  end

  defp read_exact(_fd, _offset, 0), do: {:ok, ""}

  defp read_exact(fd, offset, length) do
    case :file.pread(fd, offset, length) do
      {:ok, bin} when byte_size(bin) == length -> {:ok, bin}
      _ -> {:error, "truncated local file header name at offset #{offset}"}
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
        classify_cache_read("manifest.json", path, reason)
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
      {:error, reason} -> classify_cache_read("personality.md", path, reason)
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

      {:error, :enoent} ->
        {:error, "sprites/ missing"}

      # A pack that ships `sprites` as a regular file — the shape of the
      # extracted tree, not a broken cache.
      {:error, :enotdir} ->
        {:error, "sprites/ is not a directory"}

      {:error, reason} ->
        classify_cache_read("sprites/", sprites_dir, reason)
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
  #
  # Only entries shaped like a cache key are candidates (ADR-0046 F3).
  # The root is operator-supplied now (KAOIRO_PERSONA_CACHE_DIR), so a
  # typo pointing it at a populated directory must not turn a rebuild
  # into a recursive delete of unrelated data.
  defp reclaim_cache(cache_dir, packs) do
    live = MapSet.new(packs, fn p -> p.cache_key end)

    # Reclaim failures do not invalidate the manifest, so they never fail
    # the rebuild — but silence here means disk creeping up with nothing
    # to explain it, which the F4 visibility story cannot afford.
    case File.ls(cache_dir) do
      {:ok, entries} ->
        for entry <- entries,
            Regex.match?(@cache_key_name, entry),
            path = Path.join(cache_dir, entry),
            File.dir?(path),
            not MapSet.member?(live, entry) do
          case File.rm_rf(path) do
            {:ok, _removed} ->
              :ok

            {:error, reason, file} ->
              Logger.warning(
                "persona cache reclaim failed for #{file}: #{inspect(reason)} " <>
                  "(stale extraction left behind)"
              )
          end
        end

      {:error, reason} ->
        Logger.warning(
          "persona cache reclaim skipped: cannot list #{cache_dir}: #{inspect(reason)}"
        )
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
