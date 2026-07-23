defmodule KaoiroServer.TokenDenylist do
  @moduledoc """
  Restart-surviving per-agent_id token denylist (issue #72). Complements
  ADR-0024's stateless server-minted `Phoenix.Token` wrapper auth: the
  signing scheme has no per-token revoke channel other than
  `secret_key_base` rotation (blast radius = every token at once), so a
  compromised or unwanted individual agent_id could only be revoked by
  rotating the whole key. This store closes that gap by keeping a
  per-agent_id "revoked" flag; `KaoiroServer.Auth.authorize_wrapper/2`
  consults it after the ordinary signature check and rejects join as
  `:unauthorized` when the agent_id is listed.

  Revocation is deliberately by **agent_id**, not by token bytes: the
  ADR-0024 `<host>.<rand>` naming makes agent_id collisions after a
  purge negligible (12-char urlsafe suffix), and revoke-by-id lets
  `delete_agent` seed the denylist even when the server never held the
  token bytes it wants to invalidate.

  Backed by DETS with an in-memory mirror for O(1) reads on the
  hot wrapper-join path. Fire-and-forget writes so an operator's revoke
  reply is not gated on disk fsync. Same store pattern as
  `PermissionModes` / `SessionPointers` / `ClearWatermarks`.
  """

  use GenServer

  require Logger

  @doc """
  Starts the store. `:path` overrides the DETS file and `:name` the
  registered name + DETS table (tests run isolated instances).
  """
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    GenServer.start_link(__MODULE__, {name, path}, name: name)
  end

  @doc """
  Marks `agent_id` as revoked. Fire-and-forget so the operator handler
  can respond immediately; the fast in-memory mirror is updated inside
  the GenServer message loop so a subsequent `revoked?/2` observes the
  change (`Auth.authorize_wrapper/2` uses `revoked?/2`, so the check
  order is: cast → mirror updated → next join sees it). `ts` is an
  optional ISO-8601 UTC stamp for the audit trail; the flag itself is
  what `revoked?/2` checks.
  """
  def revoke(agent_id, ts \\ nil, server \\ __MODULE__)
      when is_binary(agent_id) do
    GenServer.cast(server, {:revoke, agent_id, ts})
  end

  @doc """
  Fast read used on the wrapper-join hot path. Returns `true` when the
  agent_id has ever been revoked and never subsequently `restore/2`d.
  Fail-closed by default: a nil / non-binary `agent_id` returns `false`
  (there is no revocation to consult), but the caller still fails the
  overall auth on any earlier check.
  """
  def revoked?(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:revoked?, agent_id})
  end

  @doc "agent_id => revoked_at_ts (nil if the revoke omitted a ts)."
  def all(server \\ __MODULE__) do
    GenServer.call(server, :all)
  end

  @doc """
  Removes `agent_id` from the denylist. Idempotent — an unknown agent_id
  returns `:ok`. **NOT called by `delete_agent`**: the point of an
  auto-revoke on delete is that the id stays denied even if a rare
  future collision produces the same `<host>.<rand>`. Provided so tests
  can round-trip revoke → restore, and so an operator UI (future) can
  undo a mistaken revoke.
  """
  def restore(agent_id, server \\ __MODULE__) when is_binary(agent_id) do
    GenServer.call(server, {:restore, agent_id})
  end

  @impl true
  def init({name, path}) do
    path |> Path.dirname() |> File.mkdir_p!()
    table = open_table(name, path)
    _ = File.chmod(path, 0o600)
    {:ok, %{table: table, denylist: load_denylist(table)}}
  end

  # Corrupt / unreadable DETS: recreate empty rather than crash-loop the
  # supervisor. Losing denylist entries is a fail-open regression (agents
  # that WERE revoked could join again), so we ALSO log it at :error
  # instead of :warning — this is the one store where silent recovery is
  # a security downgrade the operator must notice.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} ->
        name

      {:error, reason} ->
        Logger.error(
          "token denylist store unreadable (#{inspect(reason)}); recreating EMPTY — " <>
            "previously revoked agent_ids can join again until re-revoked. " <>
            "Investigate the DETS file at #{path}."
        )

        File.rm(path)
        {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
        name
    end
  end

  defp load_denylist(table) do
    case :dets.foldl(
           fn {agent_id, ts}, acc -> Map.put(acc, agent_id, ts) end,
           %{},
           table
         ) do
      denylist when is_map(denylist) -> denylist
      {:error, _reason} -> %{}
    end
  end

  @impl true
  def handle_cast({:revoke, agent_id, ts}, state) do
    # Overwrite-latest — a later revoke ts wins for the audit trail,
    # earlier ts is ignored. Once revoked, the id stays revoked; `restore/2`
    # is the only way out and is not exposed via delete_agent's path.
    :ok = :dets.insert(state.table, {agent_id, ts})
    {:noreply, %{state | denylist: Map.put(state.denylist, agent_id, ts)}}
  end

  @impl true
  def handle_call({:revoked?, agent_id}, _from, state) do
    {:reply, Map.has_key?(state.denylist, agent_id), state}
  end

  def handle_call(:all, _from, state) do
    {:reply, state.denylist, state}
  end

  def handle_call({:restore, agent_id}, _from, state) do
    :ok = :dets.delete(state.table, agent_id)
    {:reply, :ok, %{state | denylist: Map.delete(state.denylist, agent_id)}}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :token_denylist_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_token_denylist.dets")
  end
end
