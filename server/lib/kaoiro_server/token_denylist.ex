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
  hot wrapper-join path. Writes are **synchronous** and fsync-gated
  (`GenServer.call` + `:dets.sync/1` before reply) — the operator's
  revoke ack and the follow-up `revoked` / `agent_deleted` broadcast
  never fire ahead of disk persistence, so a crash inside the persist
  window cannot silently drop the revocation. `ClearWatermarks` also
  adopted this synchronous+fsync policy (ふじ #109 M7-a must-fix,
  2026-07-23) — the only remaining lazy-sync sibling is
  `PermissionModes`, and only because a UI-reflector pick that is not
  yet on disk can be re-asserted from the same operator picker on the
  next connect; the denylist has no such re-assertion path (an
  operator would need to re-issue every revoke by hand after a crash),
  which is why it must fsync-gate on every write.
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
  Marks `agent_id` as revoked. **Synchronous** and fsync-gated: the call
  returns only after the DETS insert AND the following `:dets.sync/1`
  return `:ok`, so an operator ack (or `delete_agent` broadcast) that
  follows this call is safe against a crash inside the persist window.
  Same policy `ClearWatermarks` uses (ふじ #109 M7-a must-fix,
  2026-07-23); the only remaining lazy-sync sibling is
  `PermissionModes` (UI-reflector, re-assertable from the same
  operator picker on next connect). The denylist IS the per-agent
  revocation authority (ADR-0024 D4 + issue #72), so it has no
  re-assertion path and must fsync-gate on every write. `ts` is an
  optional ISO-8601 UTC stamp for the audit trail; the flag itself is
  what `revoked?/2` checks.
  """
  def revoke(agent_id, ts \\ nil, server \\ __MODULE__)
      when is_binary(agent_id) do
    GenServer.call(server, {:revoke, agent_id, ts})
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

    case open_table(name, path) do
      {:ok, table} ->
        _ = File.chmod(path, 0o600)

        case load_denylist(table) do
          {:ok, denylist} ->
            {:ok, %{table: table, denylist: denylist}}

          {:error, reason} ->
            # M2 (ふじ #72 must-fix): corrupt row detected. FAIL-CLOSED
            # startup rather than silently drop the row and let a
            # revoked agent_id join again. Preserve the DETS file so
            # an operator can forensically inspect it; recovery is a
            # deliberate rename by hand followed by a restart.
            :ok = :dets.close(table)

            Logger.error(
              "token denylist load failed (#{inspect(reason)}); DETS file preserved " <>
                "at #{path} — refusing to start with a partial denylist. Rename or " <>
                "move the file aside and restart to boot with an empty denylist."
            )

            {:stop, {:token_denylist_load_failed, reason, path}}
        end

      {:error, reason} ->
        # M2: same fail-closed policy for the whole-file corruption
        # case (previously auto-recreated empty, which is exactly the
        # silent-downgrade the reviewer called out). File is left in
        # place; operator recovery = rename + restart.
        Logger.error(
          "token denylist store unreadable (#{inspect(reason)}); DETS file preserved " <>
            "at #{path} — refusing to start with an empty denylist. Rename or move " <>
            "the file aside and restart to boot with an empty denylist."
        )

        {:stop, {:token_denylist_open_failed, reason, path}}
    end
  end

  # M2 (ふじ #72 must-fix): NO silent recreate on open error. The
  # sibling stores auto-recreate for convenience, but here that
  # convenience is exactly the fail-open regression the reviewer
  # called out — a corrupted denylist re-lets every revoked agent_id
  # in. Return {:error, reason} so the caller can fail-closed at the
  # startup boundary AND keep the on-disk file for forensics.
  defp open_table(name, path) do
    case :dets.open_file(name, file: String.to_charlist(path)) do
      {:ok, ^name} -> {:ok, name}
      {:error, reason} -> {:error, reason}
    end
  end

  # M2: {:error, reason} on any malformed row (or fold-time error);
  # the caller fails-closed at init. Wrapping the fold in a try lets
  # us treat non-2-tuple rows (schema drift / bit-flip) the same way
  # as an outright fold failure.
  defp load_denylist(table) do
    try do
      folded =
        :dets.foldl(
          fn
            {agent_id, ts}, acc when is_binary(agent_id) -> Map.put(acc, agent_id, ts)
            malformed, _acc -> throw({:malformed_denylist_row, malformed})
          end,
          %{},
          table
        )

      case folded do
        denylist when is_map(denylist) -> {:ok, denylist}
        {:error, reason} -> {:error, reason}
      end
    catch
      {:malformed_denylist_row, _} = reason -> {:error, reason}
    end
  end

  @impl true
  def handle_call({:revoke, agent_id, ts}, _from, state) do
    # Overwrite-latest — a later revoke ts wins for the audit trail,
    # earlier ts is ignored. Once revoked, the id stays revoked;
    # `restore/2` is the only way out and is not exposed via
    # delete_agent's path. fsync BEFORE reply so the operator ack /
    # `agent_deleted` broadcast that follows this call cannot outrun
    # disk persistence (issue #72 review advisory).
    :ok = :dets.insert(state.table, {agent_id, ts})
    :ok = :dets.sync(state.table)
    {:reply, :ok, %{state | denylist: Map.put(state.denylist, agent_id, ts)}}
  end

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
