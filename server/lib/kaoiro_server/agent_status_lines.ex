defmodule KaoiroServer.AgentStatusLines do
  @moduledoc """
  Restart-surviving store of every agent's status line and its change log
  (issue 482).

  An agent writes one markdown text about what it is doing (at most 16,384
  bytes, validated by `KaoiroServer.MarkdownText`). The store keeps
  the latest entries per agent, newest first, up to the effective retention.
  A clear (empty text) is an entry with `text: nil`.

  ## Layout

    * DETS `:set`, owned by this process and opened only here: `{:retention, n}`
      and `{{:agent, id}, entries}`. Every mutation of an agent replaces that
      one object, so a failed write leaves the object whole, old or new.
    * ETS, `:protected`, one row per agent holding only the latest entry and its
      head: `{id, entry, head, truncated, bytes}`. Frequent readers
      (`list_agents`, the join snapshot, cards) read it by name and never wait
      behind a write. It is built under a temporary name and renamed, so the
      public name exists only for a complete view.
    * No other state holds text.

  ## Commit order

  A mutation writes the DETS object, runs `:sync_fun`, and only on `:ok`
  updates ETS, replies, and broadcasts. A failed write, or a raise or exit from
  any DETS step, latches the store `dirty`: later mutations, `latest/2` and
  `history/2` answer `:status_line_unavailable`, while ETS keeps serving the
  last committed rows. There is no automatic recovery; a restart of this child
  after the fault is fixed runs `init/1` again.

  ## Reading

  `read_latest/2` and `heads/1` look the public ETS name up on every call and
  keep no table id, so they follow a restart. A missing table is
  `:unavailable`, never "no line". `settings/1`, `latest/2` and `history/2` go
  through the owner and map every exit of that call to `:unavailable`.

  ## Start

  Phase A reads the storage: this process must be the only opener of its DETS
  name (an existing table stops `init/1` with `:status_line_table_already_open`
  and is left alone), the revoked ids are read once from `TokenDenylist` (an
  unreadable denylist stops `init/1`, it is never treated as empty), the file is
  opened, records are validated, ids revoked or deleted are swept, the log is
  pruned to the retention, and one sync writes the repairs. Phase B builds the
  rows in memory, phase C publishes them (build then rename), and phase D
  announces every row and the settings, but only when the Endpoint is already up
  (a child restart, not the first boot).

  Open errors: a file that is not a DETS file is moved aside to
  `<path>.corrupt-<UTC>-<n>` by hard link then unlink, which never replaces an
  existing backup, and a fresh file is opened. Every other error (`file_error`,
  `type_mismatch`, anything unknown) stops `init/1` and leaves the file as it
  was. A start-up sync failure after a successful open does not stop the
  server: the store starts dirty and publishes the rows as read.

  ## Options

  `:name` (process and DETS name), `:table` and `:building` (ETS names),
  `:path`, `:sync_fun`, `:clock`, `:broadcast`, `:fallback`, `:denylist`,
  `:endpoint_up?`, `:ln_fun`, `:rm_fun`, `:backup_suffix` and `:phase_c_hook` exist so tests
  can run isolated instances and inject a failure. Production sets none of
  them.
  """

  use GenServer

  require Logger

  alias KaoiroServer.{DetsStorePath, MarkdownHead, MarkdownText, StatusLineWire, TokenDenylist}

  @max_bytes 16_384
  @head_bytes 512
  @min_retention 1
  @max_retention 100
  @default_retention 20
  @call_timeout 5_000

  @table __MODULE__
  @building Module.concat(__MODULE__, Building)

  @type row :: StatusLineWire.row()

  def max_bytes, do: @max_bytes
  def head_bytes, do: @head_bytes
  def retention_bounds, do: {@min_retention, @max_retention}

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  ## Frequent readers: ETS by name, never through the owner.

  @doc """
  One agent's committed latest row, `{:ok, nil}` when it has none, or
  `:unavailable` while the table does not exist.
  """
  @spec read_latest(String.t(), atom()) :: {:ok, row() | nil} | :unavailable
  def read_latest(agent_id, table \\ @table) when is_binary(agent_id) do
    case :ets.lookup(table, agent_id) do
      [{^agent_id, entry, head, truncated, bytes}] ->
        {:ok, %{entry: entry, head: head, truncated: truncated, bytes: bytes}}

      [] ->
        {:ok, nil}
    end
  rescue
    ArgumentError -> :unavailable
  end

  @doc """
  Every committed latest row in one read, so a caller gets a complete view or
  `:unavailable`, never a mixture.
  """
  @spec heads(atom()) :: {:ok, %{String.t() => row()}} | :unavailable
  def heads(table \\ @table) do
    rows =
      for {id, entry, head, truncated, bytes} <- :ets.tab2list(table), into: %{} do
        {id, %{entry: entry, head: head, truncated: truncated, bytes: bytes}}
      end

    {:ok, rows}
  rescue
    ArgumentError -> :unavailable
  end

  ## Owner calls.

  @doc """
  Records `text` as the agent's new status line (an empty text clears it).

  Errors: `:invalid_status_line`, `:status_line_invalid_characters`,
  `{:status_line_too_large, bytes}` and `:status_line_unavailable`.
  """
  @spec put(String.t(), term(), GenServer.server()) :: {:ok, map()} | {:error, term()}
  def put(agent_id, text, server \\ __MODULE__) when is_binary(agent_id) do
    case call_owner(server, {:put, agent_id, text}) do
      :unavailable -> {:error, :status_line_unavailable}
      reply -> reply
    end
  end

  @doc "Drops the agent's record (`delete_agent`)."
  @spec purge(String.t(), GenServer.server()) :: :ok | {:error, :status_line_unavailable}
  def purge(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    case call_owner(server, {:purge, agent_id}) do
      :unavailable -> {:error, :status_line_unavailable}
      reply -> reply
    end
  end

  @doc """
  Stores the operator's retention pick and prunes every agent to it at once.
  """
  @spec set_retention(term(), GenServer.server()) ::
          {:ok, map()} | {:error, :invalid_status_line_retention | :status_line_unavailable}
  def set_retention(value, server \\ __MODULE__) do
    if valid_retention?(value) do
      case call_owner(server, {:set_retention, value}) do
        :unavailable -> {:error, :status_line_unavailable}
        reply -> reply
      end
    else
      {:error, :invalid_status_line_retention}
    end
  end

  @doc "The effective retention, its source and the bounds; `:unavailable` if the owner is gone."
  @spec settings(GenServer.server()) :: {:ok, map()} | :unavailable
  def settings(server \\ __MODULE__), do: call_owner(server, :settings)

  @doc """
  The latest row for a peer's full-text read. Refused while the store is dirty,
  unlike `read_latest/2`.
  """
  @spec latest(String.t(), GenServer.server()) ::
          {:ok, row() | nil} | {:error, :status_line_unavailable}
  def latest(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    case call_owner(server, {:latest, agent_id}) do
      :unavailable -> {:error, :status_line_unavailable}
      reply -> reply
    end
  end

  @doc "The agent's whole change log, newest first. Refused while dirty."
  @spec history(String.t(), GenServer.server()) ::
          {:ok, [map()]} | {:error, :status_line_unavailable}
  def history(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    case call_owner(server, {:history, agent_id}) do
      :unavailable -> {:error, :status_line_unavailable}
      reply -> reply
    end
  end

  # Only the exit of the `GenServer.call` itself is mapped: its reason is
  # `{reason, {GenServer, :call, args}}` whatever ended the call (no process,
  # timeout, the owner shut down or crashed while the request was queued or
  # running). Any other exit shape reaches the caller.
  defp call_owner(server, request) do
    GenServer.call(server, request, @call_timeout)
  catch
    :exit, {_reason, {GenServer, :call, _args}} -> :unavailable
  end

  ## Server

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path) || default_path()

    state = %{
      name: name,
      path: path,
      ets: Keyword.get(opts, :table, @table),
      building: Keyword.get(opts, :building, @building),
      sync_fun: Keyword.get(opts, :sync_fun, &:dets.sync/1),
      clock: Keyword.get(opts, :clock, &DateTime.utc_now/0),
      broadcast: Keyword.get(opts, :broadcast, fn _event, _payload -> :ok end),
      phase_c_hook: Keyword.get(opts, :phase_c_hook),
      denylist: Keyword.get(opts, :denylist, TokenDenylist),
      endpoint_up?: Keyword.get(opts, :endpoint_up?, &endpoint_up?/0),
      ln_fun: Keyword.get(opts, :ln_fun, &File.ln/2),
      rm_fun: Keyword.get(opts, :rm_fun, &File.rm/1),
      backup_suffix:
        Keyword.get(opts, :backup_suffix, fn -> System.unique_integer([:positive]) end),
      dirty: false,
      retention: nil,
      source: nil
    }

    fallback = Keyword.get(opts, :fallback) || boot_fallback()

    with :ok <- check_fallback(fallback),
         :ok <- check_single_opener(name) do
      # Not rescued: if the denylist cannot be read, init stops. An unreadable
      # denylist is never treated as an empty one.
      denied = TokenDenylist.all(state.denylist)
      DetsStorePath.prepare_parent!(path)

      case open_table(state, path) do
        {:ok, table} ->
          # DETS has no creation-mode option; the parent directory is owner-only.
          _ = File.chmod(path, 0o600)
          start(state, table, fallback, denied)

        {:error, reason} ->
          {:stop, reason}
      end
    else
      {:error, reason} -> {:stop, reason}
    end
  end

  # Only this process opens the table. Joining a table somebody else holds would
  # make a close here silently succeed while the table stays, so a name that is
  # already open stops init instead of being adopted.
  defp check_single_opener(name) do
    if :dets.info(name) == :undefined, do: :ok, else: {:error, :status_line_table_already_open}
  end

  defp endpoint_up?, do: is_pid(Process.whereis(KaoiroServerWeb.Endpoint))

  # Phase A (storage) and B (view), then C (publication) and D (notification).
  defp start(state, table, fallback, denied) do
    loaded = load(table)
    {retention, source} = effective_retention(loaded.retention, fallback)

    # Revoked and deleted agents lose their record at every start. The view
    # below is built from what is left, whether or not the sync succeeds.
    {live, swept} = sweep(loaded.agents, denied)
    {agents, prunes} = prune(live, retention)
    sweeps = for id <- swept, do: {:delete, {:agent, id}}

    state =
      case repair(state, prunes ++ sweeps ++ loaded.invalid) do
        :ok -> %{state | retention: retention, source: source}
        :failed -> %{state | retention: retention, source: source, dirty: true}
      end

    rows = view(agents)
    log_start(agents, state, loaded, length(swept))
    publish_table(state, rows)
    announce(state, rows)
    {:ok, state}
  end

  defp sweep(agents, denied) do
    {swept, live} = Map.split(agents, Map.keys(denied))
    {live, Map.keys(swept)}
  end

  defp open_table(state, path) do
    case :dets.open_file(state.name, file: String.to_charlist(path), type: :set) do
      {:ok, name} -> {:ok, name}
      {:error, {:not_a_dets_file, _path}} -> reopen_after_move_aside(state, path)
      {:error, reason} -> {:error, {:status_line_open_failed, reason}}
    end
  end

  # Only a file that is not a DETS file at all is set aside; the stored
  # retention pick goes with it. file_error, type_mismatch and anything unknown
  # never reach here: renaming a live file over a transient error would turn it
  # into data loss.
  defp reopen_after_move_aside(state, path) do
    with {:ok, backup} <- move_aside(state, path, 3) do
      Logger.error(
        "agent status lines: #{path} is not a DETS file; moved to #{backup} and starting " <>
          "empty (the stored retention pick is lost)"
      )

      case :dets.open_file(state.name, file: String.to_charlist(path), type: :set) do
        {:ok, name} -> {:ok, name}
        {:error, reason} -> {:error, {:status_line_open_failed, reason}}
      end
    end
  end

  # A hard link to a unique name, then unlink. Unlike a rename, the link fails
  # when the name exists, so an earlier backup is never replaced. If the link or
  # the unlink fails, init stops with the original untouched and no fresh file.
  defp move_aside(state, path, attempts) do
    stamp = state.clock.() |> Calendar.strftime("%Y%m%dT%H%M%SZ")
    backup = "#{path}.corrupt-#{stamp}-#{state.backup_suffix.()}"

    case state.ln_fun.(path, backup) do
      :ok ->
        case state.rm_fun.(path) do
          :ok -> {:ok, backup}
          {:error, reason} -> {:error, {:status_line_move_aside_failed, {:unlink, reason}}}
        end

      {:error, :eexist} when attempts > 1 ->
        move_aside(state, path, attempts - 1)

      {:error, reason} ->
        {:error, {:status_line_move_aside_failed, {:link, reason}}}
    end
  end

  defp check_fallback(%{retention: n}) do
    if valid_retention?(n), do: :ok, else: {:error, {:invalid_fallback_retention, n}}
  end

  # Records are validated on load, not only on write: a value that reached the
  # file by any other route must not become live. Invalid records are dropped
  # (with their keys remembered so the repair can delete them) and counted.
  defp load(table) do
    :dets.foldl(&classify/2, %{agents: %{}, retention: nil, invalid: []}, table)
  end

  defp classify({:retention, n}, acc) do
    if valid_retention?(n) do
      %{acc | retention: n}
    else
      invalid(acc, :retention, "retention #{inspect(n)}")
    end
  end

  defp classify({{:agent, id} = key, entries}, acc) when is_binary(id) do
    case normalize_entries(entries) do
      {:ok, normalized} -> put_in(acc.agents[id], normalized)
      :error -> invalid(acc, key, "agent #{id}")
    end
  end

  defp classify(record, acc) when is_tuple(record) and tuple_size(record) > 0 do
    invalid(acc, elem(record, 0), "key #{inspect(elem(record, 0))}")
  end

  defp invalid(acc, key, what) do
    Logger.warning("agent status lines: discarding invalid record (#{what})")
    %{acc | invalid: [{:delete, key} | acc.invalid]}
  end

  defp normalize_entries([_ | _] = entries) do
    normalized = Enum.map(entries, &normalize_entry/1)

    if Enum.all?(normalized, &(&1 != :error)) and strictly_descending?(normalized) do
      {:ok, normalized}
    else
      :error
    end
  end

  defp normalize_entries(_entries), do: :error

  defp normalize_entry(%{seq: seq, text: text, updated_at: at})
       when is_integer(seq) and seq > 0 and is_binary(at) do
    with true <- valid_text?(text), {:ok, _dt, 0} <- DateTime.from_iso8601(at) do
      %{seq: seq, text: text, updated_at: at}
    else
      _ -> :error
    end
  end

  defp normalize_entry(_entry), do: :error

  defp valid_text?(nil), do: true

  defp valid_text?(text),
    do: is_binary(text) and String.valid?(text) and byte_size(text) <= @max_bytes

  defp strictly_descending?(entries) do
    entries
    |> Enum.map(& &1.seq)
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.all?(fn [a, b] -> a > b end)
  end

  defp effective_retention(nil, %{retention: n, source: source}), do: {n, source}
  defp effective_retention(stored, _fallback), do: {stored, :stored}

  defp prune(agents, retention) do
    Enum.reduce(agents, {%{}, []}, fn {id, entries}, {kept, repairs} ->
      if length(entries) > retention do
        trimmed = Enum.take(entries, retention)
        {Map.put(kept, id, trimmed), [{:replace, id, trimmed} | repairs]}
      else
        {Map.put(kept, id, entries), repairs}
      end
    end)
  end

  # Writes the start-up repairs and syncs once. A failure here does not stop
  # the server from starting: the store starts dirty and publishes the rows as
  # they are on disk.
  defp repair(_state, []), do: :ok

  defp repair(state, repairs) do
    result =
      persist(state, :start, nil, fn ->
        Enum.each(repairs, &apply_repair(state, &1))
        dets!(state.sync_fun.(state.name))
      end)

    case result do
      {:ok, _} -> :ok
      {:latched, _state} -> :failed
    end
  end

  defp apply_repair(state, {:replace, id, entries}),
    do: dets!(:dets.insert(state.name, {{:agent, id}, entries}))

  defp apply_repair(state, {:delete, key}), do: dets!(:dets.delete(state.name, key))

  defp view(agents) do
    for {id, [latest | _]} <- agents, into: %{}, do: {id, row_tuple(id, latest)}
  end

  defp row_tuple(id, %{text: nil} = entry), do: {id, entry, "", false, 0}

  defp row_tuple(id, %{text: text} = entry) do
    {head, truncated} = MarkdownHead.cut(text, @head_bytes)
    {id, entry, head, truncated, byte_size(text)}
  end

  # Phase C. The table is built under a fixed temporary name and renamed, so
  # the public name never exists for a partly filled table. A raise anywhere
  # here stops init/1; the temporary table dies with this process.
  defp publish_table(state, rows) do
    :ets.new(state.building, [:named_table, :protected, :set, read_concurrency: true])
    hook(state, :after_create)

    {first, rest} = rows |> Map.values() |> Enum.split(div(map_size(rows), 2))
    Enum.each(first, &:ets.insert(state.building, &1))
    hook(state, :after_half_rows)

    Enum.each(rest, &:ets.insert(state.building, &1))
    ets = state.ets
    ^ets = :ets.rename(state.building, ets)
    :ok
  end

  defp hook(%{phase_c_hook: nil}, _point), do: :ok
  defp hook(%{phase_c_hook: fun}, point), do: fun.(point)

  # Phase D. A child restart leaves clients connected, so they are told what is
  # committed; the first boot has no client yet. Each broadcast is isolated, and
  # a failed one does not undo the commit.
  defp announce(state, rows) do
    if state.endpoint_up?.() do
      for {id, entry, head, truncated, bytes} <- Map.values(rows) do
        published = %{entry: entry, head: head, truncated: truncated, bytes: bytes}
        broadcast(state, "status_line", StatusLineWire.live_payload(id, published))
      end

      broadcast(state, "status_line_settings", settings_payload(state))
    end

    :ok
  end

  defp log_start(agents, state, loaded, swept) do
    size =
      case File.stat(state.path) do
        {:ok, %{size: size}} -> size
        _ -> :unknown
      end

    entries = agents |> Map.values() |> Enum.map(&length/1) |> Enum.sum()

    Logger.info(
      "agent status lines: #{map_size(agents)} agents, #{entries} entries, " <>
        "file #{size} bytes, retention #{state.retention} (#{state.source}), " <>
        "#{length(loaded.invalid)} invalid records dropped, #{swept} revoked swept, " <>
        "dirty=#{state.dirty}"
    )
  end

  @impl true
  def handle_call({:put, _agent_id, _text}, _from, %{dirty: true} = state),
    do: {:reply, {:error, :status_line_unavailable}, state}

  def handle_call({:put, agent_id, input}, _from, state) do
    case MarkdownText.validate(input, @max_bytes) do
      {:error, reason} -> {:reply, {:error, put_error(reason)}, state}
      {:ok, change} -> commit_put(state, agent_id, change)
    end
  end

  def handle_call({:purge, _agent_id}, _from, %{dirty: true} = state),
    do: {:reply, {:error, :status_line_unavailable}, state}

  def handle_call({:purge, agent_id}, _from, state) do
    result =
      persist(state, :purge, agent_id, fn ->
        dets!(:dets.delete(state.name, {:agent, agent_id}))
        dets!(state.sync_fun.(state.name))
      end)

    case result do
      {:ok, _} ->
        :ets.delete(state.ets, agent_id)
        {:reply, :ok, state}

      {:latched, state} ->
        {:reply, {:error, :status_line_unavailable}, state}
    end
  end

  def handle_call({:set_retention, _value}, _from, %{dirty: true} = state),
    do: {:reply, {:error, :status_line_unavailable}, state}

  def handle_call({:set_retention, value}, _from, state) do
    result =
      persist(state, :retention, nil, fn ->
        dets!(:dets.insert(state.name, {:retention, value}))

        state.name
        |> over_retention(value)
        |> Enum.each(fn {id, entries} ->
          dets!(:dets.insert(state.name, {{:agent, id}, entries}))
        end)

        dets!(state.sync_fun.(state.name))
      end)

    case result do
      {:ok, _} ->
        state = %{state | retention: value, source: :stored}
        broadcast(state, "status_line_settings", settings_payload(state))
        {:reply, {:ok, settings_reply(state)}, state}

      {:latched, state} ->
        {:reply, {:error, :status_line_unavailable}, state}
    end
  end

  def handle_call(:settings, _from, state), do: {:reply, {:ok, settings_reply(state)}, state}

  def handle_call({:latest, _agent_id}, _from, %{dirty: true} = state),
    do: {:reply, {:error, :status_line_unavailable}, state}

  def handle_call({:latest, agent_id}, _from, state),
    do: {:reply, {:ok, row_of(state, agent_id)}, state}

  def handle_call({:history, _agent_id}, _from, %{dirty: true} = state),
    do: {:reply, {:error, :status_line_unavailable}, state}

  def handle_call({:history, agent_id}, _from, state) do
    case persist(state, :history, agent_id, fn -> lookup_entries(state, agent_id) end) do
      {:ok, entries} -> {:reply, {:ok, entries}, state}
      {:latched, state} -> {:reply, {:error, :status_line_unavailable}, state}
    end
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.name)

  ## Mutations

  defp commit_put(state, agent_id, change) do
    result =
      persist(state, :put, agent_id, fn ->
        entries = lookup_entries(state, agent_id)
        previous = List.first(entries)

        entry = %{
          seq: if(previous, do: previous.seq + 1, else: 1),
          text: text_of(change),
          updated_at: next_stamp(state.clock, previous)
        }

        kept = Enum.take([entry | entries], state.retention)
        dets!(:dets.insert(state.name, {{:agent, agent_id}, kept}))
        dets!(state.sync_fun.(state.name))
        entry
      end)

    case result do
      {:ok, entry} ->
        {^agent_id, _, head, truncated, bytes} = row = row_tuple(agent_id, entry)
        :ets.insert(state.ets, row)

        published = %{entry: entry, head: head, truncated: truncated, bytes: bytes}
        broadcast(state, "status_line", StatusLineWire.live_payload(agent_id, published))
        {:reply, {:ok, put_reply(published)}, state}

      {:latched, state} ->
        {:reply, {:error, :status_line_unavailable}, state}
    end
  end

  defp text_of({:set, text}), do: text
  defp text_of(:clear), do: nil

  defp put_error(:invalid), do: :invalid_status_line
  defp put_error(:invalid_characters), do: :status_line_invalid_characters
  defp put_error({:too_large, bytes}), do: {:status_line_too_large, bytes}

  defp put_reply(%{entry: %{text: nil} = entry}),
    do: %{status: :clear, seq: entry.seq, updated_at: entry.updated_at}

  defp put_reply(%{entry: entry, truncated: truncated, bytes: bytes}),
    do: %{
      status: :set,
      seq: entry.seq,
      updated_at: entry.updated_at,
      bytes: bytes,
      truncated: truncated
    }

  # max(now, previous + 1 microsecond), so `updated_at` strictly increases per
  # agent even when the clock steps back. Fixed microsecond precision keeps the
  # string order equal to the time order.
  defp next_stamp(clock, previous) do
    now = clock.()

    at =
      case previous do
        nil ->
          now

        %{updated_at: stamp} ->
          {:ok, last, 0} = DateTime.from_iso8601(stamp)
          floor = DateTime.add(last, 1, :microsecond)
          if DateTime.compare(now, floor) == :lt, do: floor, else: now
      end

    {microsecond, _precision} = at.microsecond
    DateTime.to_iso8601(%{at | microsecond: {microsecond, 6}})
  end

  defp lookup_entries(state, agent_id) do
    case :dets.lookup(state.name, {:agent, agent_id}) do
      [{_key, entries}] -> entries
      [] -> []
      {:error, _reason} = error -> dets!(error)
    end
  end

  # Agents whose log is longer than the new retention, trimmed. Streamed one
  # object at a time so a large store is not loaded whole.
  defp over_retention(table, retention) do
    :dets.foldl(
      fn
        {{:agent, id}, entries}, acc when length(entries) > retention ->
          [{id, Enum.take(entries, retention)} | acc]

        _record, acc ->
          acc
      end,
      [],
      table
    )
  end

  defp row_of(state, agent_id) do
    case :ets.lookup(state.ets, agent_id) do
      [{^agent_id, entry, head, truncated, bytes}] ->
        %{entry: entry, head: head, truncated: truncated, bytes: bytes}

      [] ->
        nil
    end
  end

  defp settings_reply(state) do
    %{retention: state.retention, source: state.source, min: @min_retention, max: @max_retention}
  end

  defp settings_payload(state) do
    %{
      "retention" => state.retention,
      "source" => Atom.to_string(state.source),
      "min" => @min_retention,
      "max" => @max_retention
    }
  end

  ## Failure handling

  # Runs DETS work that may fail. `{:ok, value}` when it returned; otherwise the
  # store latches dirty. A failed `{:error, _}` result, a raise, a throw and an
  # exit from a DETS call all take the same road. Nothing in here may touch
  # ETS or broadcast: those happen only after this returned `{:ok, _}`.
  defp persist(state, op, agent_id, fun) do
    {:ok, fun.()}
  rescue
    error -> {:latched, latch(state, op, agent_id, {:raised, error.__struct__})}
  catch
    :throw, {:dets_failure, reason} -> {:latched, latch(state, op, agent_id, reason)}
    kind, reason -> {:latched, latch(state, op, agent_id, {kind, reason})}
  end

  defp dets!(:ok), do: :ok
  defp dets!({:error, reason}), do: throw({:dets_failure, reason})

  # Never logs the text: the operation, the agent id and the failure kind only.
  defp latch(state, op, agent_id, reason) do
    Logger.error(
      "agent status lines: #{op} failed for #{agent_id || "-"} " <>
        "(#{inspect(reason, limit: 5, printable_limit: 80)}); refusing history and " <>
        "writes until this child is restarted"
    )

    %{state | dirty: true}
  end

  # A broadcast failure never undoes a commit that already stands.
  defp broadcast(state, event, payload) do
    state.broadcast.(event, payload)
    :ok
  rescue
    error ->
      Logger.warning("agent status lines: #{event} broadcast raised #{inspect(error.__struct__)}")
  catch
    kind, _reason ->
      Logger.warning("agent status lines: #{event} broadcast ended with #{kind}")
  end

  defp valid_retention?(value),
    do: is_integer(value) and value >= @min_retention and value <= @max_retention

  # Resolved once at init, like QuagmireSettings: the environment is not read
  # per call, so the reported source cannot change under a running node.
  defp boot_fallback do
    source = if System.get_env("KAOIRO_STATUS_LINE_RETENTION"), do: :env, else: :default

    retention =
      :kaoiro_server
      |> Application.get_env(:agent_status_lines, [])
      |> Keyword.get(:retention, @default_retention)

    %{retention: retention, source: source}
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :agent_status_lines_path) ||
      DetsStorePath.default_path("agent_status_lines.dets")
  end
end
