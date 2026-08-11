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
  `all_with_role/1` joins role in at read time from those existing
  sources, entirely inside this module — the join needs `source`, and
  `source` never leaves this module (see below), so a caller cannot do
  this join itself.

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

  @doc """
  Every known user with role live-joined from the auth SoT (issue #197
  段階2). The two auth snapshots (`OAuthAllowlist.snapshot/1`,
  `Auth.client_token_hash_role_map/0`) are taken ONCE here, before the
  GenServer call, and passed in — so every entry resolved against the
  SAME source (all OAuth users against one `OAuthAllowlist.snapshot/1`
  call, all token users against one `client_token_hash_role_map/0` call)
  sees a consistent role within that source (director D2). The two
  snapshots are still taken as two SEQUENTIAL reads, so there is NO
  cross-source atomicity: a `client_tokens` rewrite landing between the
  two calls can let token-sourced users see a newer config generation
  than OAuth-sourced users in the same reply (ふじ M4 レビュー指摘 — the
  prior wording claimed a same-reply guarantee this does not provide;
  the actual contract lives in protocol-inter-agent.md's "role のライブ
  join の意味" section). Passing the snapshots IN (rather than handing
  `source` OUT to the caller) keeps `source` from ever leaving this
  module (director D11) — the join happens inside `handle_call/3`, and
  only the role-bearing public shape crosses back out.

  `log?: false` on the OAuth snapshot: this is called from the
  `directory_request` auto-allow path (potentially every peer poll), not
  a human-triggered login/refresh, so the malformed-line warnings
  `OAuthAllowlist` normally emits on every read would repeat on every
  poll instead of once per actual misconfiguration.

  A user whose source no longer resolves to a role (revoked from the
  allow-list / token config) is OMITTED entirely from the result — `role`
  is a wire-required field on the caller's projection, so there is no
  per-entry "unknown" to fall back to.
  """
  def all_with_role(server \\ __MODULE__) do
    oauth_roles = KaoiroServer.OAuthAllowlist.snapshot(log?: false)
    token_roles = KaoiroServer.Auth.client_token_hash_role_map()
    GenServer.call(server, {:all_with_role, oauth_roles, token_roles})
  end

  @doc """
  Renames `user_id`'s `display_name` (issue #197 段階3, D13). `name`
  must already be trimmed/validated by the caller (the same 64-grapheme
  / control-char rule `WrapperChannel.valid_display_name/1` enforces on
  the `directory_request` wire, issue #197 段階2 MF-1) — this function
  only rejects an unknown `user_id`, it does not re-validate `name`'s
  shape (same division of labor `get_or_create/4` already has with its
  caller-supplied `initial_display_name`).

  Unlike `AgentDirectory.rename/3`, this store carries no revision
  counter: `all_with_role/1` reads `display_name` fresh from this
  GenServer's state on every `directory_request`, so there is no
  wrapper-side cache to reconcile and therefore no out-of-order-delivery
  race for a counter to resolve (see `all_with_role/1`'s own doc on the
  live-join contract).

  Returns `{:ok, %{id:, kind:, display_name:}}` (the updated public
  entry, same shape `get/2` returns) or `{:error, :not_found}` for a
  `user_id` this ledger has never created.
  """
  def rename(user_id, name, server \\ __MODULE__) when is_binary(name) do
    GenServer.call(server, {:rename, user_id, name})
  end

  @doc """
  Parses `KAOIRO_EXPOSE_USERS_TO_AGENTS`'s raw env value (as read by
  `System.get_env/1`, so `nil` on unset) into the boolean
  `config/runtime.exs` stores under `:expose_users_to_agents`.

  Config DEFAULT is `true` — unset takes this branch — per issue #197's
  constraint clause: "「原則見える」は実装のデフォルト挙動ではなく設定の
  デフォルト値として実現する". This is the config LAYER's default; it is
  separate from `WrapperChannel`'s own read-site fallback (`false`),
  which exists only to keep that call fail-closed if config is somehow
  absent entirely (e.g. a test that deletes the key) — not as the
  everyday default (ふじ M1 レビュー指摘, issue #197 段階2: the two
  fallbacks were conflated in the first pass, closing the feature by
  default in ordinary boot instead of only on config absence).

  Only the exact string `"false"` opts out. Any other malformed value
  (typo, `"0"`, `"no"`) stays CLOSED rather than defaulting to open on
  unrecognised input — fail-closed still governs anything that isn't a
  clean, deliberate `"true"`/`"false"`/unset.
  """
  def expose_to_agents_default(nil), do: true
  def expose_to_agents_default("true"), do: true
  def expose_to_agents_default("false"), do: false
  def expose_to_agents_default(_other), do: false

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

  def handle_call({:rename, user_id, name}, _from, state) do
    case Map.get(state.entries, user_id) do
      nil ->
        {:reply, {:error, :not_found}, state}

      entry ->
        new_entry = %{entry | display_name: name}
        :ok = :dets.insert(state.table, {user_id, new_entry})
        state = %{state | entries: Map.put(state.entries, user_id, new_entry)}
        {:reply, {:ok, public_entry(user_id, new_entry)}, state}
    end
  end

  def handle_call({:all_with_role, oauth_roles, token_roles}, _from, state) do
    reply =
      state.entries
      |> Enum.map(fn {user_id, entry} ->
        {user_id, entry, resolve_role(entry.source, oauth_roles, token_roles)}
      end)
      |> Enum.filter(fn {_user_id, _entry, role} -> role != nil end)
      |> Enum.map(fn {user_id, entry, role} -> public_entry_with_role(user_id, entry, role) end)

    {:reply, reply, state}
  end

  @impl true
  def terminate(_reason, state) do
    :dets.close(state.table)
  end

  defp resolve_role({:oauth, provider, uid}, oauth_roles, _token_roles),
    do: Map.get(oauth_roles, {provider, uid})

  defp resolve_role({:token, hash}, _oauth_roles, token_roles), do: Map.get(token_roles, hash)
  defp resolve_role(_source, _oauth_roles, _token_roles), do: nil

  # Never includes `source` — see moduledoc. This is the only shape
  # get_or_create/get/all ever hand back to a caller.
  defp public_entry(user_id, entry) do
    %{id: user_id, kind: entry.kind, display_name: entry.display_name}
  end

  # Role-bearing counterpart of public_entry/2 for all_with_role/1 (issue
  # #197 段階2). Same rule: never includes `source`.
  defp public_entry_with_role(user_id, entry, role) do
    %{id: user_id, kind: entry.kind, display_name: entry.display_name, role: role}
  end

  defp default_path do
    Application.get_env(:kaoiro_server, :users_path) ||
      Path.join(System.tmp_dir!(), "kaoiro_users.dets")
  end
end
