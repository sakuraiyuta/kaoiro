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
  Extraction is bounded before it starts: entry names may not escape the
  cache slot (ADR-0046 F7) and the pack may not expand past 1 GiB across
  4096 entries (ADR-0046 F8 — spelled out because ADR-0029 numbers an
  unrelated F8), the latter measured by a real inflate because the sizes
  an archive declares are forgeable.

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
  #
  # Walking the whole term is the loose part of this, and it was measured
  # rather than assumed (2026-08-04, OTP 29.0.2 / stdlib 8.0.1). Feeding
  # the extractor a self-colliding entry
  # (`{:EXIT, {{:badmatch, {:error, :eexist}}, stacktrace}}`), a 300-byte
  # entry name (`:enametoolong`), random bytes and a truncated archive
  # (both `:bad_eocd`) produced no term carrying ANY atom from the two sets
  # above — every archive-shape failure classified as a pack error, which
  # is what ADR-0029's "one bad drop cannot lock the whole set" requires.
  # So the walk stays unbounded on evidence, not taste. Those four are
  # fixtured by "実測: アーカイブ形状由来の失敗はどれも cache_error に
  # ならない" in the test suite, so an OTP release that moves an errno into
  # a new position fails there first. (A broken central directory —
  # `:bad_central_directory` — was measured the same way during the
  # investigation but is not fixtured: it needs byte-patching a zip and
  # carries no atom the other four do not already cover.)
  #
  # Two caveats for whoever re-measures. The `{:EXIT, _}` shape carries a
  # stacktrace, so this walk also visits module and function atoms from
  # unrelated frames — none can collide with an errno name today, but that
  # is the first place a collision would come from. And narrowing the walk
  # would NOT have caught the one real misclassification found here: a
  # pack that declares mode 0 on its own `manifest.json` made `File.read/1`
  # fail `:eacces` at exactly the position a genuine cache failure uses.
  # That one is fixed at the source, in `normalize_modes/1`.
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

  @doc false
  # These paths are always inside the cache, so :eacces needs no scoping
  # here. A missing or malformed file is still the pack's problem.
  #
  # Public for the same reason `classify_zip_error/2` is: since
  # `normalize_modes/1` repairs any mode the pack (or an operator) put on an
  # extracted file, this branch is no longer reachable from an integration
  # test without injecting a genuine volume fault, so it is pinned directly.
  def classify_cache_read(label, path, reason) do
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

  # Idempotent. The cache dir's name is the content hash, so an existing one
  # holds the right bytes — but presence alone does not prove it is finished
  # or ours, so it is reused only when it looks complete AND we can still
  # impose our own modes on it (`reuse_extracted/1`). Anything else is
  # discarded and re-extracted; nothing is "marked done", deliberately —
  # see the note there on why a durability marker is not used.
  # `:zip.unzip`'s `cwd` charlist target is the extract root.
  # Owner-only, and owner-WRITABLE so `File.rm_rf/1` can always reclaim
  # the tree. Nothing outside this OS user reads the cache: sprites are
  # hashed and served through the channel, never from disk by Plug.Static.
  # Defined here, above every user — a module attribute read before its
  # definition silently expands to nil (caught by `:file.change_mode/2`
  # raising FunctionClauseError, not by the compiler erroring out).
  @extracted_dir_mode 0o700
  @extracted_file_mode 0o600

  defp ensure_extracted(zip_path, extracted_dir, cache_dir) do
    case reuse_extracted(extracted_dir) do
      :ok -> :ok
      :stale -> extract(zip_path, extracted_dir, cache_dir)
    end
  end

  # A cached tree is reused only if it looks complete AND our own modes can
  # still be put on it. The freshness check is stat-based, so a mode-0
  # `manifest.json` satisfies it; re-normalising instead of trusting also
  # covers a tree written by a build from BEFORE `normalize_modes/1`
  # existed, or left by a run that died between extraction and the walk.
  # The walk is idempotent and a pack is a manifest, a markdown file and 7
  # PNGs, so paying it each rebuild costs less than a durability marker,
  # which an archive entry of the same name could forge anyway.
  #
  # A normalisation failure here is deliberately NOT infrastructure. `chmod`
  # returns `:eperm` for a file this OS user does not own, and the module
  # tolerates an explicitly configured, group/world-writable cache root
  # (see `verify_cache_root/1`) — so treating it as `{:cache_error, _}`
  # would let any local user plant `<root>/<16 hex>/manifest.json` and
  # permanently stop the server from booting. Treating it as stale sends the
  # entry to `discard/1`, which evicts it when it can and skips just this
  # pack when it cannot.
  # `File.lstat/1`, not `File.dir?/1`: the latter FOLLOWS symlinks, so a
  # `<root>/<hash>` symlink planted on the shared root would pass the
  # freshness check, and `normalize_modes/1` would wave it through as well
  # (`:symlink` is neither `:regular` nor `:directory`). The pack's
  # `personality.md` rides into every prompt for that persona, so this is
  # content injection, not just a DoS. `verify_cache_root/1` already
  # lstat-rejects a symlinked ROOT for the same reason — the slots inside it
  # need the same guard. Anything that is not a real directory is stale, and
  # `File.rm_rf/1` unlinks the symlink itself rather than its target.
  #
  # Symlinks INSIDE a slot are rejected by `normalize_modes/1` for the same
  # reason — ふじ replaced a real slot's `personality.md` with a symlink and
  # got planted text into that persona's prompt.
  defp real_dir?(path) do
    match?({:ok, %File.Stat{type: :directory}}, File.lstat(path))
  end

  defp real_file?(path) do
    match?({:ok, %File.Stat{type: :regular}}, File.lstat(path))
  end

  # Everything the loader will read has to be there already, as a REAL file
  # — `lstat`, so a symlink standing in for one is not accepted either.
  # Checking only `manifest.json` accepted a tree that had lost a sprite (a
  # partial extraction, a SIGKILL, a manual delete): it was never
  # re-extracted, the pack was then skipped for the missing sprite, and
  # `known_persona?/1` went false for a persona that is sitting on disk
  # (ふじ, 実再現).
  defp complete?(extracted_dir) do
    real_dir?(extracted_dir) and Enum.all?(consumed_paths(extracted_dir), &real_file?/1)
  end

  defp consumed_paths(dir) do
    [Path.join(dir, "manifest.json"), Path.join(dir, "personality.md")] ++
      Enum.map(@required_states, &Path.join([dir, "sprites", "#{&1}.png"]))
  end

  defp reuse_extracted(extracted_dir) do
    if complete?(extracted_dir) do
      case normalize_modes(extracted_dir) do
        :ok -> :ok
        {:cache_error, _reason} -> :stale
      end
    else
      :stale
    end
  end

  defp extract(zip_path, extracted_dir, cache_dir) do
    with :ok <- verify_archive(zip_path),
         :ok <- discard(extracted_dir, cache_dir),
         :ok <- prepare_slot(extracted_dir, cache_dir) do
      result =
        case :zip.unzip(String.to_charlist(zip_path), cwd: String.to_charlist(extracted_dir)) do
          {:ok, _files} -> normalize_modes(extracted_dir)
          {:error, reason} -> classify_zip_error(reason, cache_dir)
        end

      discard_unless_clean(result, extracted_dir, cache_dir)
    end
  end

  # `:zip.unzip/2` applies a FILE's declared mode as it writes that entry,
  # and a DIRECTORY's only at the end of a successful extraction (measured
  # on OTP 29.0.2). So an aborted extraction can leave an unreadable file —
  # a pack ordering a mode-0 `manifest.json` first and a doomed entry second
  # does exactly that — and a completed one can leave a mode-0 directory,
  # which `File.rm_rf/1` cannot descend into. Both are the archive's choice,
  # so widen before deleting, and never leave a half-written tree for the
  # next rebuild's freshness check to accept.
  defp discard(extracted_dir, cache_dir) do
    _ = normalize_modes(extracted_dir)

    case File.rm_rf(extracted_dir) do
      {:ok, _removed} -> :ok
      {:error, reason, path} -> classify_discard(reason, path, probe_writable(cache_dir))
    end
  end

  @doc false
  # Creates the slot and narrows it to owner-only, BEFORE `:zip.unzip/2`
  # writes anything into it. Public so both properties can be pinned
  # directly — the conditions that break them need a second OS user or a
  # won race, neither of which a single-user suite can stage (ふじ).
  #
  # `File.mkdir/1`, exclusively, NOT `File.mkdir_p/1`. Nothing reserves the
  # path between the wipe and this call, so the slot can be re-occupied in
  # between, and `mkdir_p` answers `:ok` for a SYMLINK pointing at an
  # existing directory — the chmod and the extraction then follow it out of
  # the cache (ふじ reproduced the link target being narrowed to 0700 and a
  # `manifest.json` written inside it). Exclusive `mkdir` reports `:eexist`
  # for a directory or a symlink alike, before anything is written, and an
  # `lstat` check would not do: that is a check/use race, this is not.
  # `cache_dir` already exists and the slot sits one level below it, so the
  # recursive form buys nothing anyway.
  #
  # The chmod then closes the insertion window: `File.mkdir/1` creates at
  # the umask, so under the usual 022 the slot is briefly 0755 — no other
  # user can write into that, but a permissive umask would leave it group-
  # or world-writable until this runs.
  def prepare_slot(extracted_dir, cache_dir) do
    with :ok <- create_slot(extracted_dir, cache_dir) do
      case File.chmod(extracted_dir, @extracted_dir_mode) do
        :ok -> :ok
        {:error, reason} -> classify_discard(reason, extracted_dir, probe_writable(cache_dir))
      end
    end
  end

  defp create_slot(extracted_dir, cache_dir) do
    case File.mkdir(extracted_dir) do
      :ok -> :ok
      {:error, reason} -> classify_discard(reason, extracted_dir, probe_writable(cache_dir))
    end
  end

  @doc false
  # Failing to clear our own cache slot is not automatically a volume fault.
  # Unlink permission comes from the CONTAINING directory, not from the
  # cache root, so a `<root>/<hash>/` owned by another OS user survives the
  # wipe — measured: `File.rm_rf/1` on a non-empty directory without the
  # write bit swallows the per-child failures and reports `:eexist` for the
  # directory itself (a foreign file reports `:eacces` / `:eperm`; a file or
  # an EMPTY directory is removable through the parent, which is why the
  # earlier note here was wrong).
  #
  # ADR-0046 F4 fixes which POSIX atoms mean "the cache volume failed", and
  # `classify_zip_error/2` and `classify_cache_read/3` apply that table
  # unchanged. It cannot be applied to a failed SLOT OPERATION — removing
  # the slot, creating it, or narrowing it to owner-only: `:eperm` and
  # `:eacces` are exactly what a slot planted by another local user
  # produces on the shared, group/world-writable root this module
  # tolerates, so calling them infrastructure would let one planted
  # directory abort every rebuild and every boot — the inversion ADR-0029
  # forbids. The errno is therefore not reinterpreted; the cache ROOT is
  # re-probed instead, which is the thing that actually differs. A
  # read-only remount, a full volume or an I/O fault takes the root down
  # with it; a foreign slot leaves it writable. F4 carries this as an
  # explicit addendum (2026-08-04) covering exactly those three operations.
  #
  # The probe only disambiguates the atoms a foreign slot can actually
  # produce — measured: a non-empty foreign directory gives `:eexist` from
  # `File.rm_rf/1`, and a foreign file gives `:eacces` / `:eperm`. A slot
  # re-occupied between the wipe and `File.mkdir/1` also gives `:eexist`,
  # whatever re-occupied it — that is the point of the exclusive form, and
  # why nothing is written before the classification runs. `:enotdir`
  # stays in the set for the one remaining shape: a path whose parent
  # stopped being a directory under us. Every other atom keeps F4's
  # classification whatever the probe says — an `:eio` from a bad block in
  # this slot, or an `:estale` NFS handle for it, leaves the ROOT perfectly
  # writable, and downgrading those would publish a manifest that silently
  # lost packs instead of failing the rebuild.
  @slot_local ~w(eexist eacces eperm enotdir)a

  def classify_discard(reason, path, :ok) when reason in @slot_local do
    {:error, "cache slot operation failed: #{path}: #{inspect(reason)}"}
  end

  def classify_discard(reason, path, _probe) do
    {:cache_error, "cache slot operation failed: #{path}: #{inspect(reason)}"}
  end

  defp discard_unless_clean(:ok, _extracted_dir, _cache_dir), do: :ok

  defp discard_unless_clean(error, extracted_dir, cache_dir) do
    merge_cleanup_error(error, discard(extracted_dir, cache_dir))
  end

  @doc false
  # A cache fault outranks a pack fault. Dropping the cleanup result and
  # returning the original error meant that a pack error whose cleanup then
  # failed on a broken volume (`:eio`, `:estale`, `:enospc`) still read as
  # "just skip this pack": the build carried on and published a manifest
  # that had silently lost packs, instead of failing the rebuild and keeping
  # the last-known-good (ADR-0046 F4). Pure on purpose so the whole table
  # can be pinned directly — the situation that produces it needs a broken
  # volume, which no single-user test can stage (ふじ M1).
  def merge_cleanup_error({:cache_error, _} = original, _cleanup), do: original
  def merge_cleanup_error(_original, {:cache_error, _} = cleanup), do: cleanup
  def merge_cleanup_error(original, _cleanup), do: original

  # `:zip.unzip/2` restores the modes the ARCHIVE declares, so the pack —
  # an untrusted artifact — otherwise controls permissions inside OUR
  # cache. A pack carrying `manifest.json` with mode 0 then makes
  # `File.read/1` fail `:eacces`, which `classify_cache_read/3` must treat
  # as infrastructure (a cache that really went unreadable is not the
  # pack's fault, ふじ M1 2026-08-03) — so one crafted drop halts the whole
  # rebuild, freezing every other pack and raising on cold start. Measured
  # end-to-end on OTP 29.0.2 before this was added.
  #
  # The ambiguity cannot be resolved downstream: the errno is genuine and
  # sits exactly where a real cache failure would put it. So the archive's
  # control is removed at the source instead, right after extraction.
  # Chmod top-down — a mode-0 directory cannot be listed until it is
  # widened. A failure here IS ours, hence `:cache_error`.
  defp normalize_modes(path) do
    case File.lstat(path) do
      {:ok, %File.Stat{type: :directory}} ->
        with :ok <- chmod_extracted(path, @extracted_dir_mode),
             {:ok, names} <- ls_extracted(path) do
          Enum.reduce_while(names, :ok, fn name, :ok ->
            case normalize_modes(Path.join(path, name)) do
              :ok -> {:cont, :ok}
              error -> {:halt, error}
            end
          end)
        end

      {:ok, %File.Stat{type: :regular}} ->
        chmod_extracted(path, @extracted_file_mode)

      # Measured on OTP 29.0.2: `:zip.unzip/2` writes only regular files
      # and directories — a symlink entry is materialised as a regular file
      # holding the target path. So anything else in this tree was put
      # there by something that is not a legitimate extraction, and the
      # loader would read straight through it: ふじ replaced a real slot's
      # `personality.md` with a symlink and got planted text into that
      # persona's prompt. Rejecting costs no compatibility for that reason,
      # and the callers do the right thing with it — reuse discards and
      # re-extracts, a fresh extraction cleans up and fails.
      {:ok, %File.Stat{type: type}} ->
        {:cache_error, "unexpected #{type} in the cache: #{path}"}

      {:error, reason} ->
        {:cache_error, "cache stat failed: #{path}: #{inspect(reason)}"}
    end
  end

  defp chmod_extracted(path, mode) do
    case File.chmod(path, mode) do
      :ok -> :ok
      {:error, reason} -> {:cache_error, "cache chmod failed: #{path}: #{inspect(reason)}"}
    end
  end

  defp ls_extracted(path) do
    case File.ls(path) do
      {:ok, names} -> {:ok, names}
      {:error, reason} -> {:cache_error, "cache listing failed: #{path}: #{inspect(reason)}"}
    end
  end

  # ZIP local file header: signature, then 22 bytes of fixed fields, then
  # the name length and extra length — 30 bytes before the name itself.
  @local_header_signature 0x04034B50
  @local_header_size 30

  # Extraction bounds (#189, ADR-0046 F8), decided 2026-08-04 by マスター:
  # a pack may expand to at most 1 GiB across at most 4096 entries.
  # Generous on purpose — high-resolution sprites now, 3D assets later —
  # so a pack that trips either bound is not a plausible legitimate one.
  # 1 GiB reads as the binary prefix (1024³): the figure is headroom for
  # asset growth, so the larger of the two readings matches the intent.
  @max_extracted_bytes 1024 * 1024 * 1024
  @max_entries 4096

  # The two compression methods this preflight can account for, which are
  # also the only two OTP's extractor handles. An entry declaring anything
  # else cannot be measured, so the pack is refused rather than guessed at.
  @method_stored 0
  @method_deflate 8

  # General purpose bit flag 0: the entry is encrypted. Measured on OTP
  # 29.0.2 — `:zip.unzip/2` IGNORES this bit and writes the ciphertext as
  # though it were plaintext, so inflating such an entry would measure
  # nothing meaningful and the pack is refused instead.
  @flag_encrypted 0x0001

  # General purpose bit flag 3: the entry's sizes are placeholders in the
  # local header and the real ones trail the compressed data in a data
  # descriptor. OTP's extractor then takes comp_size from the CENTRAL
  # directory instead (stdlib 8.0.1 `zip.erl` `get_z_file/9`: `GPFlag band
  # 8 =:= 8 -> ZipFile#zip_file.comp_size`), so the measurement has to read
  # the same field. Reading only the local header counts ZERO for such an
  # entry while the extractor inflates it in full — measured: a local
  # header declaring csize 0 alongside an untouched central directory had
  # 10,000,000 bytes written (レビュー must-fix, 2026-08-04).
  @flag_data_descriptor 0x0008

  # ZIP64. A 32-bit size field holding this sentinel means the real value
  # lives in the entry's ZIP64 extended information extra field, and OTP
  # resolves it there before extracting. Using the raw 32-bit field instead
  # counts 4,294,967,295 bytes for an entry that is 11, refusing a perfectly
  # valid pack as oversized — not a bypass, but the same "read what the
  # extractor reads" rule failing on the other side (ふじ M1, 2026-08-04).
  @zip64_extra_id 0x0001
  @size_sentinel 0xFFFFFFFF

  # A ZIP entry carries a bare deflate stream, without the zlib or gzip
  # framing `inflateInit/1` would otherwise expect.
  @raw_deflate_window -15

  @inflate_chunk 65_536

  @doc false
  # Bounds the extraction BEFORE anything is written (#189, ADR-0046 F8).
  #
  # The declared sizes cannot carry this check. `:zip.list_dir/1` reports
  # what an archive SAYS each entry expands to, and that number is the
  # attacker's to write: measured on OTP 29.0.2, an entry declaring 100
  # bytes in BOTH the local header and the central directory still had
  # 10,000,000 bytes written to disk by `:zip.unzip/2`, with no error — the
  # extractor never consults the declared size at all. So the size bound is
  # enforced against a real inflate, run here with the output discarded.
  #
  # Cheapest reject first: a stat, then a listing, then one pread per
  # entry, and only then the inflate. A pack that escapes its extraction
  # dir or declares 100k entries is refused without a byte being inflated —
  # otherwise a traversal zip bomb would cost a gigabyte of inflate CPU
  # before the name check that was going to reject it anyway (ふじ).
  def verify_archive(zip_path) do
    with :ok <- verify_archive_bytes(zip_path),
         {:ok, entries} <- central_entries(zip_path),
         :ok <- verify_entry_count(entries),
         :ok <- verify_entry_names(zip_path) do
      measure_entries(zip_path, entries, @max_extracted_bytes)
    end
  end

  @doc false
  # The size walk with the bound supplied by the caller. Public in this
  # form because the production bound is a gigabyte: staging an archive
  # that crosses it costs seconds per case, so the boundary itself, the
  # drain loop and the per-method accounting are pinned against small
  # bounds here, and one end-to-end case with a real bomb pins that
  # `verify_archive/1` passes @max_extracted_bytes through.
  def measure_archive(zip_path, limit) do
    with {:ok, entries} <- central_entries(zip_path) do
      measure_entries(zip_path, entries, limit)
    end
  end

  # STORE is why this bound exists. A deflate entry ends its own stream, so
  # the walk below measures it exactly; a stored entry has no terminator,
  # and its length lives only in the declared field just shown to be
  # forgeable. What cannot be forged is the archive's own size on disk, and
  # STORE does not expand — so capping the file caps everything STORE can
  # contribute (ふじ案 a, 2026-08-04).
  #
  # Stored entries are still added up below at their declared length, which
  # keeps mixed archives honest. Understating it is not a bypass: the
  # extractor reads exactly that many bytes for a stored entry, so a
  # smaller declaration writes less (an entry declaring 0 — the streamed
  # `data descriptor` shape — makes it refuse the archive outright,
  # measured for both methods).
  defp verify_archive_bytes(zip_path) do
    case File.stat(zip_path) do
      {:ok, %File.Stat{size: size}} when size > @max_extracted_bytes ->
        {:error, "archive is #{size} bytes, over the #{@max_extracted_bytes} byte limit"}

      {:ok, _stat} ->
        :ok

      {:error, reason} ->
        {:error, "cannot stat archive: #{inspect(reason)}"}
    end
  end

  # Directory entries count too: 4096 has room to spare for a legitimate
  # pack, so special-casing them would buy a branch and nothing else.
  #
  # Counting from the central directory is what the extractor does —
  # measured on OTP 29.0.2, an archive whose EOCD listed 1 of its 2 entries
  # extracted exactly the listed one, so an entry reachable only through a
  # local header is not a way past this.
  defp verify_entry_count(entries) do
    count = length(entries)

    if count > @max_entries do
      {:error, "archive holds #{count} entries, over the #{@max_entries} entry limit"}
    else
      :ok
    end
  end

  defp measure_entries(zip_path, entries, limit) do
    with {:ok, fd} <- open_raw(zip_path) do
      try do
        with {:ok, headers} <- measurable_headers(fd, entries) do
          measure_extracted(fd, headers, limit)
        end
      after
        File.close(fd)
      end
    end
  end

  # Every local header is read and vetted before the first inflate, so an
  # unmeasurable entry cannot hide behind a legitimate-looking first one
  # and cost a gigabyte of CPU on the way to being rejected.
  #
  # The LOCAL header is the source of truth throughout, because it is what
  # the extractor uses: measured on OTP 29.0.2, an entry whose central
  # directory said STORE and whose local header said DEFLATE was inflated,
  # and the reverse was refused. Reading the method from the central copy
  # would reintroduce exactly the declared-value bypass this whole preflight
  # exists to close, so that copy is never consulted (ふじ).
  defp measurable_headers(fd, entries) do
    entries
    |> Enum.reduce_while({:ok, []}, fn {_name, offset, comp_size}, {:ok, acc} ->
      with {:ok, header} <- read_local_header(fd, offset),
           :ok <- measurable_entry(header) do
        {:cont, {:ok, [authoritative_span(header, comp_size) | acc]}}
      else
        error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, headers} -> {:ok, Enum.reverse(headers)}
      error -> error
    end
  end

  # How many compressed bytes the extractor will actually read for this
  # entry. Normally the local header's own field; for a data-descriptor
  # entry it is the central directory's, because that is the one OTP reads
  # (see `@flag_data_descriptor`). The FLAG is still taken from the local
  # header, matching `get_z_file/9`, so a central-only flag cannot redirect
  # which field is trusted.
  defp authoritative_span(%{flags: flags} = header, central_comp_size) do
    if Bitwise.band(flags, @flag_data_descriptor) != 0 do
      %{header | compressed: central_comp_size}
    else
      header
    end
  end

  defp measurable_entry(%{name: name, flags: flags, method: method}) do
    cond do
      Bitwise.band(flags, @flag_encrypted) != 0 ->
        {:error, "encrypted entry cannot be size-checked: #{inspect(name)}"}

      method not in [@method_stored, @method_deflate] ->
        {:error, "unsupported compression method #{method}: #{inspect(name)}"}

      true ->
        :ok
    end
  end

  defp measure_extracted(fd, headers, limit) do
    headers
    |> Enum.reduce_while({:ok, 0}, fn header, {:ok, total} ->
      case measure_entry(fd, header, total, limit) do
        {:ok, total} -> {:cont, {:ok, total}}
        error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, _total} -> :ok
      error -> error
    end
  end

  defp measure_entry(_fd, %{method: @method_stored} = header, total, limit) do
    within_limit(total + header.compressed, header.name, limit)
  end

  # `:zlib.safeInflate/2` does not REPORT a corrupt stream, it raises
  # (`ErlangError` carrying `:data_error`, measured on OTP 29.0.2 by feeding
  # it random bytes). Left uncaught, that exception walks out through
  # `rebuild/0` — whose own rescue is deliberately narrowed to `File.Error`
  # — and one truncated or bit-rotted pack in the ingest dir stops the
  # server booting and crash-loops PersonaWatcher while it runs.
  #
  # That would also be a REGRESSION this preflight introduced: the same
  # archive handed straight to `:zip.unzip/2` comes back as
  # `{:error, {:EXIT, {:data_error, _}}}`, which `classify_zip_error/2`
  # already classifies as this pack's problem and skips (measured both
  # ways). A malformed stream is the pack's fault, so it is reported as
  # one — exactly what ADR-0029 requires.
  #
  # ONLY `:data_error`, though. zlib also raises `:badarg`,
  # `:not_initialized`, `:not_on_controlling_process` and `:stream_error`,
  # and none of those describe bad INPUT — they describe this module
  # misusing the stream. Turning them into a pack error would hide our own
  # defect behind a silently skipped pack, so they are re-raised (ふじ S1).
  # The `MatchError` from the `inflateInit` assertion is left uncaught for
  # the same reason.
  defp measure_entry(fd, %{method: @method_deflate} = header, total, limit) do
    z = :zlib.open()

    try do
      :ok = :zlib.inflateInit(z, @raw_deflate_window)
      inflate_entry(fd, z, header, header.data_offset, header.compressed, total, limit)
    rescue
      e in ErlangError ->
        if e.original == :data_error do
          {:error, "cannot inflate #{inspect(header.name)}: #{inspect(e.original)}"}
        else
          reraise e, __STACKTRACE__
        end
    after
      :zlib.close(z)
    end
  end

  # Reads exactly the compressed span the extractor would read, in fixed
  # chunks, and throws the inflated bytes away once counted — so memory
  # stays at one chunk however far the entry expands.
  defp inflate_entry(_fd, _z, _header, _offset, remaining, total, _limit) when remaining <= 0 do
    {:ok, total}
  end

  defp inflate_entry(fd, z, header, offset, remaining, total, limit) do
    case :file.pread(fd, offset, min(@inflate_chunk, remaining)) do
      {:ok, chunk} ->
        case pump(z, chunk, header.name, total, limit) do
          {:ok, total} ->
            inflate_entry(
              fd,
              z,
              header,
              offset + byte_size(chunk),
              remaining - byte_size(chunk),
              total,
              limit
            )

          error ->
            error
        end

      :eof ->
        {:ok, total}

      {:error, reason} ->
        {:error, "cannot read archive data: #{inspect(reason)}"}
    end
  end

  # `:zlib.safeInflate/2` takes its input once and then has to be drained
  # with `[]` until it stops answering `:continue`; handing it the next
  # chunk while output is still queued would lose that output (ふじ).
  #
  # Measured on OTP 29.0.2: `:finished` means "the queued input is spent",
  # NOT "the deflate stream ended" — a 500 KB entry fed in 8 chunks
  # answered `:finished` once per chunk and totalled its real size exactly.
  # Reading it as end-of-stream would stop after the first chunk and
  # undercount every entry larger than one. A truncated stream ends the
  # drain in a finite number of calls, so a malformed entry cannot spin.
  defp pump(z, data, name, total, limit) do
    case :zlib.safeInflate(z, data) do
      {:finished, out} ->
        within_limit(total + :erlang.iolist_size(out), name, limit)

      {:continue, out} ->
        case within_limit(total + :erlang.iolist_size(out), name, limit) do
          {:ok, total} -> pump(z, [], name, total, limit)
          error -> error
        end
    end
  end

  # Checked per drain rather than per entry, so a bomb stops inflating the
  # moment it crosses the line instead of running to its end.
  defp within_limit(total, name, limit) when total > limit do
    {:error, "extracted size exceeds #{limit} bytes (reached #{total} at #{inspect(name)})"}
  end

  defp within_limit(total, _name, _limit), do: {:ok, total}

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
          for {:zip_file, name, _info, _comment, offset, comp_size} <- entries,
              do: {List.to_string(name), offset, comp_size}

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

  defp verify_entry(fd, {central_name, offset, _comp_size}) do
    with :ok <- safe_entry_name(central_name, "central directory"),
         {:ok, %{name: local_name}} <- read_local_header(fd, offset),
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

  # Both the name check and the size accounting read this header, and both
  # need it to be the LOCAL one — see `measurable_headers/2`. `compressed`
  # is the span the extractor reads for this entry, and `data_offset` is
  # where that span starts (past the name and the extra field).
  defp read_local_header(fd, offset) do
    case :file.pread(fd, offset, @local_header_size) do
      {:ok,
       <<@local_header_signature::little-32, _version::little-16, flags::little-16,
         method::little-16, _modified::little-32, _crc::little-32, compressed::little-32,
         uncompressed::little-32, name_len::little-16, extra_len::little-16>>} ->
        name_offset = offset + @local_header_size
        extra_offset = name_offset + name_len

        with {:ok, name} <- read_exact(fd, name_offset, name_len, "local file header name"),
             {:ok, span} <-
               local_span(fd, extra_offset, extra_len, flags, compressed, uncompressed) do
          {:ok,
           %{
             name: name,
             flags: flags,
             method: method,
             compressed: span,
             data_offset: extra_offset + extra_len
           }}
        end

      {:ok, _other} ->
        {:error, "bad local file header signature at offset #{offset}"}

      _ ->
        {:error, "unreadable local file header at offset #{offset}"}
    end
  end

  # The compressed span this entry's LOCAL header declares. A data
  # descriptor entry's local sizes are placeholders, and the central
  # directory's copy replaces them later (`authoritative_span/2`) — the
  # sentinel must NOT be resolved from the extra field there, since without
  # bit 3 the local side is the authority and substituting the central one
  # would let the two be played off against each other (ふじ M1).
  defp local_span(fd, extra_offset, extra_len, flags, compressed, uncompressed) do
    cond do
      Bitwise.band(flags, @flag_data_descriptor) != 0 ->
        {:ok, compressed}

      compressed != @size_sentinel ->
        {:ok, compressed}

      true ->
        zip64_span(fd, extra_offset, extra_len, uncompressed, compressed)
    end
  end

  defp zip64_span(fd, extra_offset, extra_len, uncompressed, compressed) do
    with {:ok, extra} <- read_exact(fd, extra_offset, extra_len, "ZIP64 extra field") do
      case zip64_record(extra) do
        {:ok, payload} -> {:ok, zip64_sizes(payload, uncompressed, compressed)}
        :error -> {:error, "ZIP64 size marker without a usable extra field"}
      end
    end
  end

  # TLV walk to the ZIP64 record. Anything else (timestamps, unix uid/gid)
  # is stepped over by its declared length; a length running past the end
  # fails the match and lands on the `:error` clause.
  defp zip64_record(
         <<@zip64_extra_id::little-16, len::little-16, payload::binary-size(len), _rest::binary>>
       ),
       do: {:ok, payload}

  defp zip64_record(<<_id::little-16, len::little-16, _skip::binary-size(len), rest::binary>>),
    do: zip64_record(rest)

  defp zip64_record(_extra), do: :error

  # This mirrors OTP's `update_zip64/2` (stdlib 8.0.1 `zip.erl`), and it has
  # to: the record is NOT a fixed layout that can be indexed into. It is a
  # LOOP that re-tests each field after consuming 8 bytes, so when a 64-bit
  # value is ITSELF 0xffffffff the extractor consumes another 8 bytes for
  # the same field and takes comp_size from further along.
  #
  # Reading it positionally — skip 8 iff the 32-bit uncompressed field was
  # sentinel, then take the next 8 — puts comp_size one slot early on such a
  # record, so the preflight measures a span the extractor never reads. The
  # regression test pins that bypass against a 999,999-byte bound; the ratio
  # is what matters, so the same shape walks past the production 1 GiB bound
  # (レビュー Critical, 2026-08-04).
  #
  # The equivalence claimed here holds WITHIN the first ZIP64 record — the
  # one `zip64_record/1` selects. OTP walks every extra record, so a
  # duplicate one could resolve a field this leaves at the sentinel. That
  # difference can only ever LEAVE a field sentinel-valued, which is the
  # safe side under the current bounds: a STORE entry is then counted as
  # 0xffffffff and rejected as oversized, and a DEFLATE entry reads to EOF
  # within the archive-size cap. It never measures less than the extractor
  # reads (ふじ, 2026-08-04).
  defp zip64_sizes(<<value::little-64, rest::binary>>, @size_sentinel, compressed),
    do: zip64_sizes(rest, value, compressed)

  defp zip64_sizes(<<value::little-64, rest::binary>>, uncompressed, @size_sentinel),
    do: zip64_sizes(rest, uncompressed, value)

  defp zip64_sizes(_rest, _uncompressed, compressed), do: compressed

  # `what` names the field being read: the same truncation now reaches here
  # from the entry name and from the ZIP64 extra, and a fixed "name" in the
  # message sends whoever reads the skip log to the wrong offset.
  defp read_exact(_fd, _offset, 0, _what), do: {:ok, ""}

  defp read_exact(fd, offset, length, what) do
    case :file.pread(fd, offset, length) do
      {:ok, bin} when byte_size(bin) == length -> {:ok, bin}
      _ -> {:error, "truncated #{what} at offset #{offset}"}
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
