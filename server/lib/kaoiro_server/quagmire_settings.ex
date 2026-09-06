defmodule KaoiroServer.QuagmireSettings do
  @moduledoc """
  Restart-surviving store of the operator's rally threshold (issue #307).

  The threshold `QuagmireWatch` compares against used to be fixed for the
  life of a boot, so retuning it meant editing `KAOIRO_QUAGMIRE_RALLY_TURNS`
  and restarting — the wrong cadence for a judgement an operator makes per
  session. Only that one value lives here: `rally_window_ms` / `stall_ms` /
  `sweep_interval_ms` stay boot-time config because none of them is a
  per-session judgement, and `rally_window_ms` in particular is validated
  against `tombstone_ttl_ms` at boot.

  `:off` is the disabled state (∞ on the wire, `null` in JSON). It is a
  distinct value rather than a very large integer: a large threshold still
  fires eventually, and an operator who turned rally detection off means off.

  Precedence is stored > env > `config.exs`, and `effective/1` names which of
  the three answered. The fallback is resolved once at `init`: reading the
  environment per call would let the reported source change under a running
  node without anything having written it.

  Deliberately NOT here: the detector's edge memory. `QuagmireWatch` rebuilds
  `notified_rally` from the current over-threshold set on every sweep, so a
  changed threshold is followed without this store touching it.
  """

  use GenServer

  require Logger

  alias KaoiroServer.QuagmireWatch

  @key :rally_turns

  # Above this an operator wants `:off`, not a number: the detector would
  # still fire eventually, just not within any session anyone is watching.
  # The dashboard clamps its input here; the server rejects rather than
  # clamping so a client that sends more is told, not silently corrected.
  @max_rally_turns 999

  @typedoc "Operator-picked rally threshold; `:off` disables rally detection."
  @type rally_turns :: pos_integer() | :off

  @doc """
  Starts the store. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc "The threshold in force: the stored pick, else the boot fallback."
  @spec rally_turns(GenServer.server()) :: rally_turns()
  def rally_turns(server \\ __MODULE__), do: GenServer.call(server, :rally_turns)

  @doc """
  The threshold in force plus which layer supplied it (`:stored` / `:env` /
  `:default`), for the operator-facing display.
  """
  @spec effective(GenServer.server()) :: %{rally_turns: rally_turns(), source: atom()}
  def effective(server \\ __MODULE__), do: GenServer.call(server, :effective)

  @doc "Largest threshold accepted by `put_rally_turns/2`."
  def max_rally_turns, do: @max_rally_turns

  @doc """
  Records the operator's pick. Synchronous: the channel replies to the
  operator only once the value is persisted. Returns
  `{:error, :invalid_rally_turns}` for anything outside
  `1..#{@max_rally_turns}` or `:off` — this is the one definition of a valid
  threshold, so callers validate by calling rather than by re-checking.
  """
  @spec put_rally_turns(term(), GenServer.server()) :: :ok | {:error, :invalid_rally_turns}
  def put_rally_turns(value, server \\ __MODULE__) do
    if valid?(value) do
      GenServer.call(server, {:put_rally_turns, value})
    else
      {:error, :invalid_rally_turns}
    end
  end

  @doc """
  Drops the stored pick so the boot value applies again. Idempotent.
  """
  @spec clear(GenServer.server()) :: :ok
  def clear(server \\ __MODULE__), do: GenServer.call(server, :clear)

  @impl true
  def init({name, path}) do
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    table = open_table(name, path)
    # Not personally sensitive, but it lives beside the other state files —
    # keep the chmod symmetric with the stores sharing that directory.
    _ = File.chmod(path, 0o600)

    {:ok, %{table: table, stored: load_stored(table), fallback: boot_fallback()}}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor. On a
  # failed open, drop the file and recreate it empty — losing the pick costs
  # the operator one re-selection and falls back to the boot value meanwhile.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("quagmire settings store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  # Validated on load, not only on write: a value that got into the file by
  # any other route must not become the live threshold.
  defp load_stored(table) do
    case :dets.lookup(table, @key) do
      [{@key, value}] ->
        if valid?(value) do
          value
        else
          Logger.warning("quagmire settings discarding stored #{inspect(value)}")
          nil
        end

      _ ->
        nil
    end
  end

  # Reads the detector's own key and its own fallback, so the two cannot
  # drift. Deliberately NOT validated against `@max_rally_turns`: that bound
  # is on what an operator may SET, and coercing a configured value here
  # would leave the store reporting one threshold while the detector's own
  # fallback used another.
  defp boot_fallback do
    source = if System.get_env("KAOIRO_QUAGMIRE_RALLY_TURNS"), do: :env, else: :default

    rally_turns =
      :kaoiro_server
      |> Application.get_env(:quagmire, [])
      |> Keyword.get(:rally_turns, QuagmireWatch.default_rally_turns())

    %{rally_turns: rally_turns, source: source}
  end

  defp valid?(:off), do: true

  defp valid?(value),
    do: is_integer(value) and value > 0 and value <= @max_rally_turns

  @impl true
  def handle_call(:rally_turns, _from, state) do
    {:reply, effective_of(state).rally_turns, state}
  end

  def handle_call(:effective, _from, state) do
    {:reply, effective_of(state), state}
  end

  def handle_call({:put_rally_turns, value}, _from, state) do
    :ok = :dets.insert(state.table, {@key, value})
    {:reply, :ok, %{state | stored: value}}
  end

  def handle_call(:clear, _from, state) do
    :ok = :dets.delete(state.table, @key)
    {:reply, :ok, %{state | stored: nil}}
  end

  defp effective_of(%{stored: nil, fallback: fallback}), do: fallback
  defp effective_of(%{stored: stored}), do: %{rally_turns: stored, source: :stored}

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :quagmire_settings_path) ||
      KaoiroServer.DetsStorePath.default_path("quagmire_settings.dets")
  end
end
