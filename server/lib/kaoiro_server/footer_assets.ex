defmodule KaoiroServer.FooterAssets do
  @moduledoc """
  Single owner of the common-footer snapshot (ADR-0045).

  The footer is the operational text appended to every agent's system
  prompt. Its default lives in `priv/footers/system-footer.md` and is
  embedded at compile time (F1), so a stock deployment needs no files at
  all. When `KAOIRO_FOOTER_DIR` is set, `system-footer.md` under that
  root replaces the built-in default and `user-footer.md` is appended
  after it (F2). The directory is never written to and never created —
  it is expected to be a `:ro` mount (F4).

  Ownership matters here. Every rebuild runs inside this GenServer, and
  both the resulting snapshot and the last-known-good go to
  `:persistent_term` keys only this module writes. `PersonaAssets` keeps
  its pack cache in a separate key and reads the footer snapshot at
  prompt time, so a pack rebuild racing a footer rebuild can never
  publish a stale footer or roll back the last-known-good (F4, ふじ
  2026-08-03). Keeping the last-known-good out of process state also
  means a crash-restart of this owner resumes with it intact.

  Per-layer degradation follows F6: a missing / empty file falls back to
  the built-in default (system) or to nothing (user); a read error keeps
  the last successfully read file content when there is one, and
  otherwise degrades the same way as a missing file. Every rebuild logs
  both layers' provenance (F5).
  """

  use GenServer

  require Logger

  # The snapshot and its last-known-good share ONE key, written in one
  # `:persistent_term.put/2`. Two keys were two observable states: a crash
  # between the puts could publish a new snapshot while the old LKG still
  # stood, and the next init would rebuild from that stale LKG — a
  # regression visible outside this module (ふじ S2, 2026-08-03).
  #
  # Keeping the LKG here rather than in process state is what makes a
  # crash-restart resume with it intact: a fresh `:unknown` would silently
  # downgrade a running server from "holding the last good footer" to
  # "never read one" at the next read_error (ふじ S1).
  @state_key {__MODULE__, :state}

  @initial_state %{snapshot: nil, lkg: %{system: :unknown, user: :unknown}}

  @system_file "system-footer.md"
  @user_file "user-footer.md"

  # Built-in default footer (ADR-0045 F1). The physical file ships in the
  # repo and in the release's `priv/`, so an operator can read the exact
  # default text without a `.example` copy or a dump task; the bytes are
  # baked in at compile time, and `@external_resource` makes editing the
  # file trigger a recompile.
  @built_in_path Path.expand("../../priv/footers/#{@system_file}", __DIR__)
  @external_resource @built_in_path
  @built_in_raw File.read!(@built_in_path)

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Effective footer snapshot: `%{system: binary, user: nil | binary}`.

  `system` is never nil (the built-in default is the floor); `user` is
  nil when no user footer is in effect.
  """
  def snapshot do
    case :persistent_term.get(@state_key, @initial_state) do
      %{snapshot: nil} ->
        :ok = rebuild()
        :persistent_term.get(@state_key).snapshot

      %{snapshot: snapshot} ->
        snapshot
    end
  end

  @doc """
  Re-reads the footer files and replaces the snapshot. Serialized through
  the owner process, so concurrent callers (`FooterWatcher` and tests)
  cannot interleave a half-built snapshot.

  Waits indefinitely on purpose: ADR-0045 F6 sets no byte cap, so the
  read this call is waiting on has no bound the default 5s could be
  derived from. A timeout would only turn a slow disk into a caller
  crash while the rebuild kept running anyway (ふじ S2, 2026-08-03).
  """
  def rebuild, do: GenServer.call(__MODULE__, :rebuild, :infinity)

  @doc "Built-in default system footer, normalized. For tests and diagnostics."
  def built_in_system_footer, do: built_in()

  @doc """
  Footer directory in use, or nil when `KAOIRO_FOOTER_DIR` is unset —
  which disables file-based footers entirely (ADR-0045 F1).
  """
  def footer_dir do
    case Application.get_env(:kaoiro_server, :footer_dir) do
      dir when is_binary(dir) and dir != "" -> dir
      _ -> nil
    end
  end

  @doc "File names read from the footer dir (exact match only, ADR-0045 F4)."
  def watched_files, do: [@system_file, @user_file]

  @impl true
  def init(_opts) do
    dir = footer_dir()

    if dir && not File.dir?(dir) do
      Logger.warning(
        "footer dir missing or unreadable: #{Path.expand(dir)}; " <>
          "built-in footer only, watch disabled (restart after creating it)"
      )
    end

    # A restart resumes from whatever was already determined; only a
    # genuinely first boot starts at `:unknown`, where a read error
    # degrades instead of resurrecting a value we never had (F6).
    build()
    {:ok, %{}}
  end

  @impl true
  def handle_call(:rebuild, _from, state) do
    build()
    {:reply, :ok, state}
  end

  # Resolves both layers and publishes the snapshot together with its
  # last-known-good in a single put, so no reader and no restart can ever
  # observe one without the other.
  defp build do
    dir = footer_dir()
    %{lkg: lkg} = :persistent_term.get(@state_key, @initial_state)

    {system, system_lkg} = resolve(:system, dir, @system_file, lkg.system)
    {user, user_lkg} = resolve(:user, dir, @user_file, lkg.user)

    :persistent_term.put(@state_key, %{
      snapshot: %{system: system, user: user},
      lkg: %{system: system_lkg, user: user_lkg}
    })
  end

  # Returns `{effective_value, next_lkg}` and logs this layer's
  # provenance (F5). `next_lkg` is `{:value, text}` after a good read,
  # `:none` once we have positively determined that no file applies, and
  # is carried over unchanged across a read error.
  defp resolve(layer, dir, file, lkg) do
    input = if dir, do: read_file(Path.join(dir, file)), else: :missing

    {value, source, next_lkg} =
      case input do
        {:file, text} ->
          {text, "file", {:value, text}}

        state when state in [:empty, :missing] ->
          {fallback(layer), fallback_source(layer), :none}

        {:read_error, reason} ->
          Logger.warning("footer read error: #{Path.expand(Path.join(dir, file))}: #{reason}")

          case lkg do
            {:value, text} -> {text, "last-known-good", lkg}
            _ -> {fallback(layer), fallback_source(layer), lkg}
          end
      end

    log_provenance(layer, input_state(input), source, value)
    {value, next_lkg}
  end

  # F6: regular files only — `File.lstat/1` so a symlink is rejected
  # rather than followed (a target outside the watched root would change
  # without any event) and a FIFO cannot block `File.read/1`.
  defp read_file(path) do
    case File.lstat(path) do
      {:ok, %File.Stat{type: :regular}} -> read_regular(path)
      {:ok, %File.Stat{type: type}} -> {:read_error, "not a regular file (#{type})"}
      {:error, :enoent} -> :missing
      {:error, reason} -> {:read_error, "lstat failed: #{inspect(reason)}"}
    end
  end

  defp read_regular(path) do
    with {:ok, bin} <- File.read(path),
         {:ok, text} <- normalize(bin) do
      if text == "", do: :empty, else: {:file, text}
    else
      :error -> {:read_error, "not valid UTF-8"}
      {:error, reason} -> {:read_error, "read failed: #{inspect(reason)}"}
    end
  end

  # F6 normalization: BOM strip, CRLF -> LF, trim. Validity is checked
  # first because the later steps are grapheme-based and meaningless on
  # a non-UTF-8 binary.
  defp normalize(bin) do
    if String.valid?(bin) do
      {:ok,
       bin
       |> String.replace_prefix("\uFEFF", "")
       |> String.replace("\r\n", "\n")
       |> String.trim()}
    else
      :error
    end
  end

  defp fallback(:system), do: built_in()
  defp fallback(:user), do: nil

  defp fallback_source(:system), do: "built-in"
  defp fallback_source(:user), do: "absent"

  # The built-in ships with the code, so a bad encoding here is a build
  # defect rather than an operational state worth degrading around.
  defp built_in do
    case normalize(@built_in_raw) do
      {:ok, text} -> text
      :error -> raise "priv/footers/#{@system_file} is not valid UTF-8"
    end
  end

  defp input_state({:file, _}), do: :file
  defp input_state({:read_error, _}), do: :read_error
  defp input_state(state), do: state

  # F5: both axes plus the effective value's length and short hash, on
  # every rebuild, so a 3-layer prompt stays traceable from the log alone.
  defp log_provenance(layer, input_state, source, value) do
    Logger.info(
      "footer rebuild layer=#{layer} input_state=#{input_state} " <>
        "effective_source=#{source} chars=#{chars(value)} sha256=#{short_sha(value)}"
    )
  end

  defp chars(nil), do: 0
  defp chars(value), do: String.length(value)

  defp short_sha(nil), do: "-"

  defp short_sha(value) do
    :crypto.hash(:sha256, value) |> Base.encode16(case: :lower) |> String.slice(0, 16)
  end
end
