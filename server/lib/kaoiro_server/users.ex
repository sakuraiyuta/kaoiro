defmodule KaoiroServer.Users do
  @moduledoc """
  Restart-surviving user identity ledger — `user_id => %{kind,
  display_name, source, created_at}` (issue #197, ADR-0050 D1 Phase A).
  Mirrors `AgentDirectory`'s DETS-backed GenServer shape: tiny payload,
  in-memory mirror for fast reads.

  Deliberately holds NO role. Role stays on its existing SoT (the
  `:client_tokens` map / OAuth allow-list text, both re-resolved live
  per ADR-0042) so this store does not become a second authorization
  source of truth (ADR-0050 D8 Phase A: "認可SoTはテキストのまま").
  Callers join role in at read time from those existing sources.

  `source` (`{:oauth, provider, uid}` or `{:token, token_hash}`) is an
  internal-only secondary index key that resolves a repeat login back to
  the same user_id. It is NEVER exposed outside this module: it is not
  part of the id/kind/display_name (Principal, ADR-0050 D1) shape
  callers see, and a token_hash in particular must not reach a log line
  or wire payload even though sha256 cannot be reversed to the original
  token (director review, issue #197).
  """

  use GenServer

  require Logger

  @doc """
  Starts the ledger. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc """
  Resolves `source` to its user, creating one with `initial_display_name`
  on first sight. A repeat lookup for the same source returns the
  EXISTING entry unchanged — display_name is independently managed
  after creation and does not track upstream changes (IdP display name,
  token config name) on later logins (issue #197 マスター決裁 2026-08-09
  #1). Serialized through the GenServer call, so concurrent first logins
  for the same source cannot double-allocate a user_id.

  `initial_display_name` may be `nil` (no provider name, no configured
  token name) — the new user's id itself becomes its display_name, the
  same "fall back to the id" shape `AgentDetail.svelte` already uses for
  a persona-less agent (`envelope.persona?.name ?? envelope.agent_id`).
  """
  def get_or_create(source, kind, initial_display_name, server \\ __MODULE__) do
    GenServer.call(server, {:get_or_create, source, kind, initial_display_name})
  end

  @doc "Latest entry `%{id, kind, display_name}` for `user_id`, or nil."
  def get(user_id, server \\ __MODULE__) do
    GenServer.call(server, {:get, user_id})
  end

  @doc "user_id => `%{id, kind, display_name}` for every known user."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    # The store is keyed by numeric user_id and may carry a display_name
    # an operator or IdP chose; keep the file owner-only, matching
    # AgentDirectory / SessionPointers' chmod discipline.
    _ = File.chmod(path, 0o600)
    entries = load_entries(table)

    {:ok,
     %{
       table: table,
       entries: entries,
       index: build_index(entries),
       next_id: next_id_from(entries)
     }}
  end

  # A corrupt/unreadable DETS file must not crash-loop the supervisor
  # (mirrors AgentDirectory.open_table/2). Losing entries only costs
  # re-issuing user_ids for repeat logins after the corruption.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.warning("user directory store unreadable (#{inspect(reason)}); recreating")

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_entries(table) do
    case :dets.foldl(fn {user_id, entry}, acc -> Map.put(acc, user_id, entry) end, %{}, table) do
      entries when is_map(entries) -> entries
      {:error, _reason} -> %{}
    end
  end

  defp build_index(entries) do
    Map.new(entries, fn {user_id, entry} -> {entry.source, user_id} end)
  end

  # Reloads the high-water mark from persisted ids so a restart never
  # reissues a user_id already handed out (DETS keeps ids as plain
  # strings, so this re-parses them rather than storing a counter).
  defp next_id_from(entries) do
    entries
    |> Map.keys()
    |> Enum.map(&safe_int/1)
    |> Enum.max(fn -> 0 end)
    |> Kernel.+(1)
  end

  defp safe_int(id) do
    case Integer.parse(id) do
      {n, ""} -> n
      _other -> 0
    end
  end

  @impl true
  def handle_call({:get_or_create, source, kind, initial_display_name}, _from, state) do
    case Map.get(state.index, source) do
      nil ->
        user_id = Integer.to_string(state.next_id)

        entry = %{
          kind: kind,
          display_name: initial_display_name || user_id,
          source: source,
          created_at: System.system_time(:second)
        }

        :ok = :dets.insert(state.table, {user_id, entry})

        state = %{
          state
          | entries: Map.put(state.entries, user_id, entry),
            index: Map.put(state.index, source, user_id),
            next_id: state.next_id + 1
        }

        {:reply, public_entry(user_id, entry), state}

      user_id ->
        {:reply, public_entry(user_id, Map.fetch!(state.entries, user_id)), state}
    end
  end

  def handle_call({:get, user_id}, _from, state) do
    reply =
      case Map.get(state.entries, user_id) do
        nil -> nil
        entry -> public_entry(user_id, entry)
      end

    {:reply, reply, state}
  end

  def handle_call(:all, _from, state) do
    reply =
      Map.new(state.entries, fn {user_id, entry} -> {user_id, public_entry(user_id, entry)} end)

    {:reply, reply, state}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  # Never includes `source` — see moduledoc. This is the only shape
  # get_or_create/get/all ever hand back to a caller.
  defp public_entry(user_id, entry) do
    %{id: user_id, kind: entry.kind, display_name: entry.display_name}
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :users_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_users.dets")
  end
end
