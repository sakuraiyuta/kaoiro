defmodule KaoiroServer.DeviceAuth do
  @moduledoc """
  Pending device authorizations for the OAuth 2.0 device authorization
  grant (RFC 8628, issue 801), held in a private ETS table and never
  persisted. Every change goes through `GenServer.call/2`, so issuing,
  approving and the one successful poll of a code are serialized.

  The flow needs a single backend: the device, the browser that approves
  and the polls must all reach this node's table. A non-empty
  `:dns_cluster_query` at start disables the store (`disabled: :clustered`);
  `available?/1` also reports false once another node is connected.

  Time is kept in milliseconds (`:clock`, default
  `System.system_time(:millisecond)`), because the polling interval is
  enforced to the millisecond. Values on the wire are seconds.

  Limits (docs/reference/security/authentication-authorization.md):

    * 64 entries in any state, of which at most 20 pending;
    * 10 issues in any 60-second window;
    * failed lookups and decisions (unknown or expired code): 5 per
      identity and 20 in total in any 900-second window. A code lives for
      600 seconds, which is inside one window, so a single code can face
      at most 20 wrong guesses.
  """

  use GenServer

  require Logger

  @expires_in 600
  @interval 5
  @slow_down_step 5
  @grace_ms 600_000
  @max_entries 64
  @max_pending 20
  @issue_limit 10
  @issue_window_ms 60_000
  @identity_failure_limit 5
  @global_failure_limit 20
  @failure_window_ms 900_000
  @max_identities 256
  @sweep_every_ms 60_000

  # BCDFGHJKLMNPQRSTVWXZ: no vowels (no words), no lookalike digits.
  @alphabet ~c"BCDFGHJKLMNPQRSTVWXZ"
  @user_code_length 9

  @type identity :: %{provider: String.t(), uid: String.t()}
  @type server :: GenServer.server()

  ## API

  @doc """
  Options: `:name` (default `#{inspect(__MODULE__)}`), `:clock` (a
  0-arity function returning Unix milliseconds) and `:node_list` (a
  0-arity function like `Node.list/0`). Production starts it with none.
  """
  def start_link(opts \\ []) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc "Issues a device code and a user code for `client_id`."
  @spec issue(String.t(), server()) ::
          {:ok,
           %{
             device_code: String.t(),
             user_code: String.t(),
             expires_in: pos_integer(),
             interval: pos_integer()
           }}
          | {:error, {:unavailable, :clustered | :capacity} | {:rate_limited, pos_integer()}}
  def issue(client_id, server \\ __MODULE__), do: GenServer.call(server, {:issue, client_id})

  @doc "What the approving browser shows for `user_code`, on behalf of `identity`."
  @spec lookup(String.t(), identity(), server()) ::
          {:ok,
           %{
             user_code: String.t(),
             client_id: String.t(),
             issued_at: integer(),
             expires_in: non_neg_integer()
           }}
          | {:error, :unknown_code | :expired | {:rate_limited, pos_integer()}}
  def lookup(user_code, identity, server \\ __MODULE__),
    do: GenServer.call(server, {:lookup, user_code, identity})

  @doc "Approves (binding `identity`) or denies the pending `user_code`."
  @spec decide(String.t(), identity(), :approve | :deny, server()) ::
          {:ok, :approved | :denied}
          | {:error, :unknown_code | :expired | :already_decided | {:rate_limited, pos_integer()}}
  def decide(user_code, identity, decision, server \\ __MODULE__)
      when decision in [:approve, :deny],
      do: GenServer.call(server, {:decide, user_code, identity, decision})

  @doc """
  One poll of the token endpoint. An approved code is deleted as it is
  returned, so a code yields its identity once; a denied code says so
  once and is deleted.
  """
  @spec consume(String.t(), String.t(), server()) ::
          {:ok, identity()}
          | {:error,
             :authorization_pending
             | :slow_down
             | :access_denied
             | :expired_token
             | :invalid_grant}
  def consume(device_code, client_id, server \\ __MODULE__),
    do: GenServer.call(server, {:consume, device_code, client_id})

  @doc "Whether this node can serve the flow: not clustered, no other node connected."
  @spec available?(server()) :: boolean()
  def available?(server \\ __MODULE__), do: GenServer.call(server, :available?)

  @doc "The number of entries held, in any state. For tests."
  @spec count(server()) :: non_neg_integer()
  def count(server \\ __MODULE__), do: GenServer.call(server, :count)

  ## Server

  @impl true
  def init(opts) do
    clock = Keyword.get(opts, :clock, fn -> System.system_time(:millisecond) end)
    node_list = Keyword.get(opts, :node_list, &Node.list/0)

    disabled =
      case Application.get_env(:kaoiro_server, :dns_cluster_query) do
        query when is_binary(query) and query != "" ->
          Logger.warning(
            "device authorization disabled: DNS_CLUSTER_QUERY is set, and the flow requires a single backend"
          )

          :clustered

        _single ->
          nil
      end

    schedule_sweep()

    {:ok,
     %{
       table: :ets.new(__MODULE__, [:set, :private]),
       clock: clock,
       node_list: node_list,
       disabled: disabled,
       issues: [],
       global_failures: [],
       identity_failures: %{}
     }}
  end

  @impl true
  def handle_call(request, _from, state) do
    state = sweep(state, state.clock.())
    {reply, state} = handle(request, state.clock.(), state)
    {:reply, reply, state}
  end

  @impl true
  def handle_info(:sweep, state) do
    schedule_sweep()
    {:noreply, sweep(state, state.clock.())}
  end

  defp handle(:available?, _now, state),
    do: {state.disabled == nil and state.node_list.() == [], state}

  defp handle(:count, _now, state), do: {length(device_keys(state.table)), state}

  defp handle({:issue, _client_id}, _now, %{disabled: :clustered} = state),
    do: {{:error, {:unavailable, :clustered}}, state}

  defp handle({:issue, client_id}, now, state) do
    issues = in_window(state.issues, now, @issue_window_ms)
    state = %{state | issues: issues}
    entries = Enum.map(device_keys(state.table), &entry!(state.table, &1))

    cond do
      length(issues) >= @issue_limit ->
        Logger.info("device authorization rate limited: kind=issue scope=global")
        {{:error, {:rate_limited, retry_after(issues, now, @issue_window_ms)}}, state}

      length(entries) >= @max_entries or
          Enum.count(entries, &(&1.state == :pending)) >= @max_pending ->
        {{:error, {:unavailable, :capacity}}, state}

      true ->
        {device_code, user_code} = insert(state.table, client_id, now)
        Logger.info("device authorization issued: client_id=#{inspect(client_id)}")

        reply =
          {:ok,
           %{
             device_code: device_code,
             user_code: display(user_code),
             expires_in: @expires_in,
             interval: @interval
           }}

        {reply, %{state | issues: [now | issues]}}
    end
  end

  defp handle({:lookup, user_code, identity}, now, state) do
    with_code(user_code, identity, now, state, fn _hash, entry, state ->
      info = %{
        user_code: entry.user_code |> display(),
        client_id: entry.client_id,
        issued_at: div(entry.issued_at, 1000),
        expires_in: div(entry.expires_at - now, 1000)
      }

      {{:ok, info}, state}
    end)
  end

  defp handle({:decide, user_code, identity, decision}, now, state) do
    with_code(user_code, identity, now, state, fn hash, entry, state ->
      case entry.state do
        :pending ->
          new_state = if decision == :approve, do: {:approved, identity}, else: :denied
          :ets.insert(state.table, {{:device, hash}, %{entry | state: new_state}})

          Logger.info(
            "device authorization #{if decision == :approve, do: "approved", else: "denied"}: " <>
              "identity=#{identity.provider}:#{identity.uid} client_id=#{inspect(entry.client_id)}"
          )

          {{:ok, if(decision == :approve, do: :approved, else: :denied)}, state}

        _terminal ->
          {{:error, :already_decided}, state}
      end
    end)
  end

  defp handle({:consume, device_code, client_id}, now, state) do
    key = {:device, hash(device_code)}

    reply =
      case :ets.lookup(state.table, key) do
        [] -> {:error, :invalid_grant}
        [{^key, entry}] -> poll(state.table, key, entry, client_id, now)
      end

    {reply, state}
  end

  # The order is the token endpoint's contract (RFC 8628 §3.5): a wrong
  # client_id changes nothing, an expired code says so, then the polling
  # interval, then the decision.
  defp poll(_table, _key, %{client_id: issued_to}, client_id, _now) when issued_to != client_id,
    do: {:error, :invalid_grant}

  defp poll(_table, _key, %{expires_at: expires_at}, _client_id, now) when now >= expires_at,
    do: {:error, :expired_token}

  defp poll(table, key, %{next_poll_at: next} = entry, _client_id, now) when now < next do
    interval = entry.interval + @slow_down_step
    :ets.insert(table, {key, %{entry | interval: interval, next_poll_at: now + interval * 1000}})
    {:error, :slow_down}
  end

  defp poll(table, key, entry, _client_id, now) do
    case entry.state do
      :pending ->
        :ets.insert(table, {key, %{entry | next_poll_at: now + entry.interval * 1000}})
        {:error, :authorization_pending}

      :denied ->
        delete(table, key, entry)
        {:error, :access_denied}

      {:approved, identity} ->
        delete(table, key, entry)
        {:ok, identity}
    end
  end

  # Looks a user code up for lookup/decide: first the failure limits, then
  # the code. An unknown or expired code is a failure for both limits.
  defp with_code(user_code, identity, now, state, found) do
    state = prune_failures(state, now)
    id_key = {identity.provider, identity.uid}
    own = Map.get(state.identity_failures, id_key, [])

    limited =
      [
        {length(own) >= @identity_failure_limit, own, "identity"},
        {length(state.global_failures) >= @global_failure_limit, state.global_failures, "global"}
      ]
      |> Enum.filter(&elem(&1, 0))

    if limited != [] do
      scopes = Enum.map_join(limited, ",", &elem(&1, 2))

      Logger.info(
        "device authorization rate limited: kind=code scope=#{scopes} " <>
          "identity=#{identity.provider}:#{identity.uid}"
      )

      wait = limited |> Enum.map(&retry_after(elem(&1, 1), now, @failure_window_ms)) |> Enum.max()
      {{:error, {:rate_limited, wait}}, state}
    else
      case find_code(state.table, user_code) do
        nil ->
          {{:error, :unknown_code}, fail(state, id_key, now)}

        {_hash, %{expires_at: expires_at}} when now >= expires_at ->
          {{:error, :expired}, fail(state, id_key, now)}

        {hash, entry} ->
          found.(hash, entry, state)
      end
    end
  end

  defp find_code(table, user_code) do
    with code when byte_size(code) == @user_code_length <- normalize(user_code),
         [{_key, hash}] <- :ets.lookup(table, {:user_code, code}),
         [{_key, entry}] <- :ets.lookup(table, {:device, hash}) do
      {hash, entry}
    else
      _missing -> nil
    end
  end

  defp fail(state, id_key, now) do
    failures = Map.update(state.identity_failures, id_key, [now], &[now | &1])

    failures =
      if map_size(failures) > @max_identities do
        {oldest, _} = Enum.min_by(failures, fn {_key, times} -> Enum.max(times) end)
        Map.delete(failures, oldest)
      else
        failures
      end

    %{state | identity_failures: failures, global_failures: [now | state.global_failures]}
  end

  defp prune_failures(state, now) do
    identity_failures =
      for {key, times} <- state.identity_failures,
          kept = in_window(times, now, @failure_window_ms),
          kept != [],
          into: %{},
          do: {key, kept}

    %{
      state
      | identity_failures: identity_failures,
        global_failures: in_window(state.global_failures, now, @failure_window_ms)
    }
  end

  defp in_window(times, now, window), do: Enum.filter(times, &(&1 > now - window))

  defp retry_after(times, now, window) do
    oldest = Enum.min(times)
    max(1, div(oldest + window - now + 999, 1000))
  end

  defp insert(table, client_id, now) do
    device_code = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
    hash = hash(device_code)
    user_code = unique_user_code(table)

    entry = %{
      user_code: user_code,
      client_id: client_id,
      issued_at: now,
      expires_at: now + @expires_in * 1000,
      interval: @interval,
      next_poll_at: now + @interval * 1000,
      state: :pending
    }

    :ets.insert(table, [{{:device, hash}, entry}, {{:user_code, user_code}, hash}])
    {device_code, user_code}
  end

  defp unique_user_code(table) do
    code = random_user_code()
    if :ets.member(table, {:user_code, code}), do: unique_user_code(table), else: code
  end

  # Rejection sampling keeps every letter equally likely: 240 is the
  # largest multiple of 20 below 256.
  defp random_user_code(acc \\ []) do
    if length(acc) == @user_code_length do
      List.to_string(acc)
    else
      <<byte>> = :crypto.strong_rand_bytes(1)

      if byte < 240,
        do: random_user_code([Enum.at(@alphabet, rem(byte, 20)) | acc]),
        else: random_user_code(acc)
    end
  end

  # Upper-cases and keeps only alphabet letters, so "bcd-fgh jkl" matches.
  defp normalize(user_code) when is_binary(user_code) do
    user_code
    |> String.upcase()
    |> String.to_charlist()
    |> Enum.filter(&(&1 in @alphabet))
    |> List.to_string()
  end

  defp normalize(_user_code), do: ""

  defp display(<<a::binary-size(3), b::binary-size(3), c::binary-size(3)>>), do: "#{a}-#{b}-#{c}"

  defp hash(device_code), do: :crypto.hash(:sha256, device_code)

  defp entry!(table, key) do
    [{^key, entry}] = :ets.lookup(table, key)
    entry
  end

  defp device_keys(table),
    do: :ets.select(table, [{{{:device, :"$1"}, :_}, [], [{{:device, :"$1"}}]}])

  defp delete(table, key, entry) do
    :ets.delete(table, key)
    :ets.delete(table, {:user_code, entry.user_code})
  end

  # Entries past their grace period go, with their user-code index;
  # failure and issue windows are trimmed.
  defp sweep(state, now) do
    for key <- device_keys(state.table),
        entry = entry!(state.table, key),
        now >= entry.expires_at + @grace_ms do
      delete(state.table, key, entry)
    end

    %{prune_failures(state, now) | issues: in_window(state.issues, now, @issue_window_ms)}
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_every_ms)
end
