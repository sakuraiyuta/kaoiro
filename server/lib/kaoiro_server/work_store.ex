defmodule KaoiroServer.WorkStore do
  @moduledoc """
  Durable, serialized authority and retry ledger for work grants.

  A work and its operation receipts occupy one DETS object. The in-memory
  receipt index is reconstructed from those objects at startup; it never
  authorizes a mutation without the serialized lookup in this process.
  """

  use GenServer

  alias KaoiroServer.WorkReducer

  @doc "Starts the store. The opts-only :test_after_apply_sync seam pins crash recovery at the durable commit boundary."
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    path = Keyword.get(opts, :path, default_path())
    after_apply_sync = Keyword.get(opts, :test_after_apply_sync)
    GenServer.start_link(__MODULE__, {name, path, after_apply_sync}, name: name)
  end

  def lookup(principal, operation_id, digest, server \\ __MODULE__) do
    GenServer.call(server, {:lookup, principal, operation_id, digest})
  end

  def apply(principal, operation, context, server \\ __MODULE__) do
    GenServer.call(server, {:apply, principal, operation, context})
  end

  def note_delivery(principal, operation_id, delivery, token \\ nil, server \\ __MODULE__) do
    GenServer.call(server, {:note_delivery, principal, operation_id, delivery, token})
  end

  def status(principal, work_id \\ nil, server \\ __MODULE__) do
    GenServer.call(server, {:status, principal, work_id})
  end

  def op_result(principal, operation_id, server \\ __MODULE__) do
    GenServer.call(server, {:op_result, principal, operation_id})
  end

  def check(principal, request, server \\ __MODULE__) do
    GenServer.call(server, {:check, principal, request})
  end

  def transfer_ack(principal, work_id, transfer_id, server \\ __MODULE__) do
    GenServer.call(server, {:transfer_ack, principal, work_id, transfer_id})
  end

  def admit_yield(
        sender,
        recipient,
        conversation_id,
        turn_number,
        work_id,
        epoch,
        server \\ __MODULE__
      ) do
    GenServer.call(
      server,
      {:admit_yield, sender, recipient, conversation_id, turn_number, work_id, epoch}
    )
  end

  def claim(principal, request, server \\ __MODULE__) do
    GenServer.call(server, {:claim, principal, request})
  end

  def drop_yield(token, server \\ __MODULE__), do: GenServer.call(server, {:drop_yield, token})

  def yield_tokens(work_id, server \\ __MODULE__),
    do: GenServer.call(server, {:yield_tokens, work_id})

  def register_modes(agent_id, owner, modes, work_control?, server \\ __MODULE__),
    do: GenServer.call(server, {:register_modes, agent_id, owner, modes, work_control?})

  def unregister_modes(agent_id, owner, server \\ __MODULE__),
    do: GenServer.call(server, {:unregister_modes, agent_id, owner})

  def modes(agent_id, server \\ __MODULE__), do: GenServer.call(server, {:modes, agent_id})
  def modes_snapshot(server \\ __MODULE__), do: GenServer.call(server, :modes_snapshot)

  def work_control_enabled?(agent_id, server \\ __MODULE__),
    do: GenServer.call(server, {:work_control_enabled, agent_id})

  def message_work(conversation_id, server \\ __MODULE__),
    do: GenServer.call(server, {:message_work, conversation_id})

  def scope_overlaps(work_id, server \\ __MODULE__),
    do: GenServer.call(server, {:scope_overlaps, work_id})

  def all(server \\ __MODULE__), do: GenServer.call(server, :all)
  def sweep(server \\ __MODULE__), do: GenServer.call(server, :sweep)

  @impl true
  def init({name, path, after_apply_sync}) do
    KaoiroServer.DetsStorePath.prepare_parent!(path)
    {:ok, ^name} = :dets.open_file(name, file: String.to_charlist(path))
    _ = File.chmod(path, 0o600)
    works = load_works(name)

    claim_states = load_claim_states(name)

    state =
      %{
        table: name,
        works: works,
        receipts: receipt_index(works),
        claim_states: claim_states,
        yield_tokens: index_yield_tokens(claim_states),
        modes: %{},
        yield_last: index_yield_last(claim_states),
        test_after_apply_sync: after_apply_sync,
        path: path
      }

    {:ok, sweep_works(sweep_yield_tokens(state))}
  end

  @impl true
  def terminate(_reason, state), do: :dets.close(state.table)

  @impl true
  def handle_call(:all, _from, state), do: {:reply, state.works, state}

  def handle_call(:sweep, _from, state) do
    next = sweep_works(sweep_yield_tokens(state))
    {:reply, :ok, next}
  end

  def handle_call({:register_modes, agent_id, owner, modes, work_control?}, _from, state),
    do:
      {:reply, :ok,
       %{state | modes: Map.put(state.modes, agent_id, {owner, modes, work_control?})}}

  def handle_call({:unregister_modes, agent_id, owner}, _from, state) do
    modes =
      case state.modes[agent_id] do
        {^owner, _, _} -> Map.delete(state.modes, agent_id)
        _ -> state.modes
      end

    {:reply, :ok, %{state | modes: modes}}
  end

  def handle_call({:modes, agent_id}, _from, state) do
    modes =
      case state.modes[agent_id] do
        {_owner, modes, _work_control?} -> modes
        _ -> nil
      end

    {:reply, modes, state}
  end

  def handle_call(:modes_snapshot, _from, state) do
    result = Map.new(state.modes, fn {id, {_owner, modes, _work_control?}} -> {id, modes} end)
    {:reply, result, state}
  end

  def handle_call({:work_control_enabled, agent_id}, _from, state) do
    result =
      case state.modes[agent_id] do
        {_owner, _modes, true} -> true
        _ -> false
      end

    {:reply, result, state}
  end

  def handle_call({:message_work, cid}, _from, state) do
    work =
      Enum.find_value(state.works, fn {_id, record} ->
        if cid in record.links, do: record
      end)

    stamp =
      if work,
        do: %{
          work_id: work.work_id,
          revision: work.revision,
          authority_epoch: work.authority_epoch,
          state: work.state
        }

    {:reply, stamp, state}
  end

  def handle_call({:scope_overlaps, work_id}, _from, state) do
    work = state.works[work_id]

    overlaps =
      if work && work.state == "active" do
        Enum.flat_map(state.works, fn {other_id, other} ->
          if other_id != work_id and other.state == "active" do
            scopes =
              for left <- work.resource_scope,
                  right <- other.resource_scope,
                  scope_overlap?(left, right),
                  do: left

            if scopes == [],
              do: [],
              else: [%{work_id: work_id, other_work_id: other_id, scopes: Enum.uniq(scopes)}]
          else
            []
          end
        end)
      else
        []
      end

    {:reply, overlaps, state}
  end

  def handle_call({:yield_tokens, work_id}, _from, state) do
    state = sweep_yield_tokens(state)

    tokens =
      for {_recipient, claim} <- state.claim_states,
          {_id, token} <- claim.tokens,
          token.work_id == work_id and token.state == "claimed",
          do: token

    {:reply, tokens, state}
  end

  def handle_call({:drop_yield, token}, _from, state) do
    {:reply, :ok, drop_yield_token(state, token)}
  end

  def handle_call({:admit_yield, sender, recipient, cid, turn, work_id, epoch}, _from, state) do
    state = sweep_yield_tokens(state)
    now = System.system_time(:millisecond)

    request = %{
      recipient: recipient,
      conversation_id: cid,
      turn_number: turn,
      work_id: work_id,
      epoch: epoch
    }

    case decide_yield(state, state.works, sender, request, now) do
      {:error, reason} ->
        {:reply, {:error, reason}, state}

      {:ok, token} ->
        case admit_token(state, token) do
          {:ok, next} -> {:reply, {:ok, token}, next}
          {:error, reason} -> {:reply, {:error, reason}, state}
        end
    end
  end

  def handle_call({:claim, principal, request}, _from, state) do
    state = sweep_yield_tokens(state)
    id = request["yield_token"]
    claim_state = claim_state(state, principal["id"])
    token = claim_state.tokens[id]
    work = if token, do: state.works[token.work_id]
    now = System.system_time(:millisecond)
    identity = %{incarnation: request["incarnation"], generation: request["generation"]}

    reason =
      cond do
        token == nil ->
          :unknown_yield

        token.recipient != principal["id"] or token.conversation_id != request["conversation_id"] or
          token.turn_number != request["turn_number"] or token.work_id != request["work_id"] or
            token.authority_epoch != request["authority_epoch"] ->
          :unknown_yield

        token.state == "claimed" and token.claimed_by == identity ->
          :repeated

        token.state == "claimed" ->
          :already_claimed

        work == nil or work.state != "active" ->
          :work_not_active

        work.assignee != principal ->
          :not_assignee

        work.authority_epoch != token.authority_epoch ->
          :grant_changed

        state.yield_last[token.recipient] != nil and
            now - state.yield_last[token.recipient] < delivery_config()[:yield_min_interval_ms] ->
          :yield_interval

        true ->
          nil
      end

    case reason do
      :repeated ->
        {:reply, {:ok, %{granted: true, repeated: true}}, state}

      nil ->
        next_token = %{token | state: "claimed", claimed_by: identity, claimed_at_ms: now}

        next_claim_state = %{
          claim_state
          | tokens: Map.put(claim_state.tokens, id, next_token),
            last_claim_at: now
        }

        :ok = persist_claim_state(state.table, token.recipient, next_claim_state)

        {:reply, {:ok, %{granted: true}},
         put_claim_state(state, token.recipient, next_claim_state)}

      _ ->
        {:reply, {:ok, %{granted: false, reason: reason}}, state}
    end
  end

  def handle_call({:lookup, principal, operation_id, digest}, _from, state) do
    state = sweep_works(state)
    {:reply, lookup_receipt(state, principal, operation_id, digest), state}
  end

  def handle_call({:op_result, principal, operation_id}, _from, state) do
    result =
      case valid_operation_id?(operation_id) do
        false ->
          {:error, :operation_id_expired}

        true ->
          case state.receipts[{principal_key(principal), operation_id}] do
            nil -> {:error, :unknown_operation}
            {_work_id, receipt} -> {:ok, receipt}
          end
      end

    {:reply, result, state}
  end

  def handle_call({:apply, principal, operation, context}, _from, state) do
    state = sweep_works(sweep_yield_tokens(state))
    operation_id = operation["operation_id"]
    digest = digest(operation)

    case lookup_receipt(state, principal, operation_id, digest) do
      {:ok, receipt} ->
        {:reply, {:duplicate, receipt}, state}

      {:error, :unknown_operation} ->
        case WorkReducer.reduce(state.works, principal, operation, context, config()) do
          {:ok, next_works, work_id, result} ->
            now = System.system_time(:millisecond)

            result =
              if operation["op"] == "transfer" do
                claimed =
                  for {_recipient, claim} <- state.claim_states,
                      {_id, token} <- claim.tokens,
                      token.work_id == work_id and token.state == "claimed",
                      do: token.yield_token

                Map.put(result, :claimed_yield_tokens, claimed)
              else
                result
              end

            receipt = %{
              principal: principal,
              operation_id: operation_id,
              op_digest: digest,
              result: result,
              issued_at_ms: now
            }

            next_works =
              Map.update!(next_works, work_id, fn record ->
                %{record | receipts: [receipt | record.receipts]}
              end)

            intent_decision =
              case context[:yield_request] do
                nil -> nil
                request -> decide_yield(state, next_works, principal, request, now)
              end

            persist_work(state.table, work_id, next_works[work_id])
            if state.test_after_apply_sync, do: state.test_after_apply_sync.()

            next = %{
              state
              | works: next_works,
                receipts:
                  Map.put(
                    state.receipts,
                    {principal_key(principal), operation_id},
                    {work_id, receipt}
                  )
            }

            {next, intent_decision} =
              case intent_decision do
                {:ok, token} ->
                  case admit_token(next, token) do
                    {:ok, admitted} -> {admitted, {:ok, token}}
                    {:error, reason} -> {next, {:error, reason}}
                  end

                _ ->
                  {next, intent_decision}
              end

            reply =
              if intent_decision == nil,
                do: {:ok, result},
                else: {:ok, result, intent_decision}

            {:reply, reply, next}

          {:error, reason} ->
            {:reply, {:error, reason}, state}
        end

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:note_delivery, principal, operation_id, delivery, token}, _from, state) do
    key = {principal_key(principal), operation_id}

    case state.receipts[key] do
      {work_id, receipt} ->
        next_receipt = Map.put(receipt, :delivery, delivery)
        work = state.works[work_id]

        updated = %{
          work
          | receipts:
              Enum.map(work.receipts, fn r ->
                if r.operation_id == operation_id and r.principal == principal,
                  do: next_receipt,
                  else: r
              end)
        }

        persist_work(state.table, work_id, updated)

        next =
          %{
            state
            | works: Map.put(state.works, work_id, updated),
              receipts: Map.put(state.receipts, key, {work_id, next_receipt})
          }

        {:reply, :ok, if(token, do: drop_yield_token(next, token), else: next)}

      nil ->
        {:reply, {:error, :unknown_operation}, state}
    end
  end

  def handle_call({:status, principal, work_id}, _from, state) do
    state = sweep_works(state)
    {:reply, WorkReducer.status(state.works, principal, work_id), state}
  end

  def handle_call({:check, principal, request}, _from, state) do
    case WorkReducer.check(state.works, principal, request) do
      {:ok, work_id, work, result} ->
        persist_work(state.table, work_id, work)
        {:reply, result, %{state | works: Map.put(state.works, work_id, work)}}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:transfer_ack, principal, work_id, transfer_id}, _from, state) do
    case WorkReducer.transfer_ack(state.works, principal, work_id, transfer_id) do
      {:ok, work} ->
        persist_work(state.table, work_id, work)
        {:reply, {:ok, work}, %{state | works: Map.put(state.works, work_id, work)}}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  defp lookup_receipt(state, principal, operation_id, digest) do
    cond do
      not valid_operation_id?(operation_id) ->
        {:error, :operation_id_expired}

      true ->
        case state.receipts[{principal_key(principal), operation_id}] do
          nil -> {:error, :unknown_operation}
          {_work_id, %{op_digest: ^digest} = receipt} -> {:ok, receipt}
          _ -> {:error, :operation_id_conflict}
        end
    end
  end

  defp valid_operation_id?("op_" <> rest) do
    case operation_id_timestamp("op_" <> rest) do
      nil ->
        false

      millis ->
        now = System.system_time(:millisecond)
        millis >= now - config()[:operation_validity_ms] and millis <= now + 300_000
    end
  end

  defp valid_operation_id?(_), do: false

  defp operation_id_timestamp("op_" <> rest) do
    case String.split(rest, "_", parts: 2) do
      [issued, random] when byte_size(random) == 22 ->
        case Integer.parse(issued) do
          {millis, ""} ->
            if Regex.match?(~r/^[A-Za-z0-9_-]{22}$/, random), do: millis

          _ ->
            nil
        end

      _ ->
        nil
    end
  end

  defp operation_id_timestamp(_), do: nil

  def digest(operation),
    do: :crypto.hash(:sha256, :erlang.term_to_binary(operation)) |> Base.encode16(case: :lower)

  defp principal_key(%{"kind" => kind, "id" => id}), do: {kind, id}
  defp principal_key(%{kind: kind, id: id}), do: {kind, id}

  defp receipt_index(works) do
    Enum.reduce(works, %{}, fn {work_id, work}, index ->
      Enum.reduce(work.receipts, index, fn receipt, acc ->
        Map.put(acc, {principal_key(receipt.principal), receipt.operation_id}, {work_id, receipt})
      end)
    end)
  end

  defp load_works(table) do
    :dets.foldl(
      fn
        {{:work, id}, record}, acc when is_binary(id) and is_map(record) ->
          Map.put(acc, id, record)

        _, acc ->
          acc
      end,
      %{},
      table
    )
  end

  defp load_claim_states(table) do
    :dets.foldl(
      fn
        {{:yield_state, recipient}, %{last_claim_at: _, tokens: _} = claim}, acc ->
          Map.put(acc, recipient, claim)

        _, acc ->
          acc
      end,
      %{},
      table
    )
  end

  defp index_yield_tokens(claim_states) do
    Enum.reduce(claim_states, %{}, fn {_recipient, claim}, acc ->
      Map.merge(acc, claim.tokens)
    end)
  end

  defp index_yield_last(claim_states) do
    for {recipient, %{last_claim_at: at}} <- claim_states,
        at != nil,
        into: %{},
        do: {recipient, at}
  end

  defp claim_state(state, recipient),
    do: Map.get(state.claim_states, recipient, %{last_claim_at: nil, tokens: %{}})

  defp put_claim_state(state, recipient, claim) do
    old = claim_state(state, recipient)
    tokens = state.yield_tokens |> Map.drop(Map.keys(old.tokens)) |> Map.merge(claim.tokens)

    last =
      if claim.last_claim_at == nil,
        do: Map.delete(state.yield_last, recipient),
        else: Map.put(state.yield_last, recipient, claim.last_claim_at)

    %{
      state
      | claim_states: Map.put(state.claim_states, recipient, claim),
        yield_tokens: tokens,
        yield_last: last
    }
  end

  defp persist_claim_state(table, recipient, claim) do
    with :ok <- :dets.insert(table, {{:yield_state, recipient}, claim}),
         :ok <- :dets.sync(table),
         do: :ok
  end

  defp admit_token(state, token) do
    recipient = token.recipient
    claim = claim_state(state, recipient)
    next_claim = %{claim | tokens: Map.put(claim.tokens, token.yield_token, token)}

    try do
      case persist_claim_state(state.table, recipient, next_claim) do
        :ok -> {:ok, put_claim_state(state, recipient, next_claim)}
        {:error, _reason} -> {:error, :yield_token_unavailable}
      end
    catch
      _, _ -> {:error, :yield_token_unavailable}
    end
  end

  defp drop_yield_token(state, id) do
    case state.yield_tokens[id] do
      nil ->
        state

      token ->
        claim = claim_state(state, token.recipient)
        next_claim = %{claim | tokens: Map.delete(claim.tokens, id)}
        :ok = persist_claim_state(state.table, token.recipient, next_claim)
        put_claim_state(state, token.recipient, next_claim)
    end
  end

  defp sweep_yield_tokens(state) do
    now = System.system_time(:millisecond)
    lifetime = delivery_config()[:yield_token_ttl_ms]

    Enum.reduce(state.claim_states, state, fn {recipient, claim}, acc ->
      tokens =
        Map.reject(claim.tokens, fn {_id, token} ->
          expires_at =
            if token.state == "claimed",
              do: token.claimed_at_ms + lifetime,
              else: token.expires_at_ms

          expires_at <= now
        end)

      if tokens == claim.tokens do
        acc
      else
        next_claim = %{claim | tokens: tokens}
        :ok = persist_claim_state(acc.table, recipient, next_claim)
        put_claim_state(acc, recipient, next_claim)
      end
    end)
  end

  defp sweep_works(state) do
    now = System.system_time(:millisecond)
    config = config()

    {works, changed?} =
      Enum.reduce(state.works, {%{}, false}, fn {id, work}, {kept, changed?} ->
        age = now - timestamp_ms(work.updated_at)

        live_receipts =
          Enum.filter(work.receipts, fn receipt ->
            issued_at = operation_id_timestamp(receipt.operation_id) || receipt.issued_at_ms
            now <= issued_at + config[:operation_validity_ms]
          end)

        work =
          if live_receipts == work.receipts, do: work, else: %{work | receipts: live_receipts}

        receipt_changed? = live_receipts != state.works[id].receipts

        cond do
          work.state == "nominated" and age >= config[:work_nomination_ttl_ms] ->
            expired = %{
              work
              | state: "expired",
                updated_at: DateTime.utc_now() |> DateTime.to_iso8601()
            }

            :ok = :dets.insert(state.table, {{:work, id}, expired})
            {Map.put(kept, id, expired), true}

          work.state in ~w(completed cancelled declined expired) and
            age >= config[:work_terminal_retention_ms] and live_receipts == [] ->
            :ok = :dets.delete(state.table, {:work, id})
            {kept, true}

          receipt_changed? ->
            :ok = :dets.insert(state.table, {{:work, id}, work})
            {Map.put(kept, id, work), true}

          true ->
            {Map.put(kept, id, work), changed?}
        end
      end)

    if changed?, do: :ok = :dets.sync(state.table)
    receipts = if changed?, do: receipt_index(works), else: state.receipts
    %{state | works: works, receipts: receipts}
  end

  defp timestamp_ms(at) do
    case DateTime.from_iso8601(at) do
      {:ok, time, _offset} -> DateTime.to_unix(time, :millisecond)
      _ -> 0
    end
  end

  defp delivery_config, do: Application.get_env(:kaoiro_server, :delivery_intent, [])

  defp decide_yield(state, works, sender, request, now) do
    work = works[request.work_id]
    recipient = request.recipient
    previous = state.yield_last[recipient]

    pending =
      state
      |> claim_state(recipient)
      |> Map.fetch!(:tokens)
      |> Enum.count(fn {_id, token} -> token.state == "unclaimed" end)

    reason =
      cond do
        work == nil or work.state != "active" ->
          :yield_not_authorized

        work.director != sender or work.assignee["id"] != recipient ->
          :yield_not_authorized

        request.conversation_id not in work.links or work.authority_epoch != request.epoch ->
          :yield_not_authorized

        previous != nil and now - previous < delivery_config()[:yield_min_interval_ms] ->
          :yield_interval

        pending >= delivery_config()[:yield_tokens_per_recipient] ->
          :yield_capacity

        true ->
          nil
      end

    if reason do
      {:error, reason}
    else
      id = "yld_" <> Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

      {:ok,
       %{
         yield_token: id,
         recipient: recipient,
         conversation_id: request.conversation_id,
         turn_number: request.turn_number,
         work_id: request.work_id,
         authority_epoch: request.epoch,
         admitted_at_ms: now,
         expires_at_ms: now + delivery_config()[:yield_token_ttl_ms],
         state: "unclaimed",
         claimed_by: nil,
         claimed_at_ms: nil
       }}
    end
  end

  defp scope_overlap?(left, right) do
    left_prefix? = String.ends_with?(left, "*")
    right_prefix? = String.ends_with?(right, "*")
    left_value = if left_prefix?, do: String.trim_trailing(left, "*"), else: left
    right_value = if right_prefix?, do: String.trim_trailing(right, "*"), else: right

    cond do
      left_prefix? and right_prefix? ->
        String.starts_with?(left_value, right_value) or
          String.starts_with?(right_value, left_value)

      left_prefix? ->
        String.starts_with?(right_value, left_value)

      right_prefix? ->
        String.starts_with?(left_value, right_value)

      true ->
        left_value == right_value
    end
  end

  defp persist_work(table, work_id, work) do
    :ok = :dets.insert(table, {{:work, work_id}, work})
    :ok = :dets.sync(table)
  end

  defp config, do: Application.get_env(:kaoiro_server, :work_store, [])

  defp default_path do
    Application.get_env(:kaoiro_server, :work_store_path) ||
      KaoiroServer.DetsStorePath.default_path("work_store.dets")
  end
end
