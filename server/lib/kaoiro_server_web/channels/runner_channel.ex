defmodule KaoiroServerWeb.RunnerChannel do
  @moduledoc """
  Control channel for one host's resident runner (topic `runner:<host_id>`,
  ADR-0023). Separate system from the data path `wrapper:<agent_id>`: this
  channel carries host registration, liveness, and the runner's responses
  to operator lifecycle control (spawn / stop / restart / session
  enumeration). Schema is protocol.md "runner 制御メッセージ (v0 確定)".

  Joins are gated by the per-host_id token list (ADR-0023, extends
  ADR-0011); the host_id charset reuses the agent_id guard
  (`[A-Za-z0-9._-]`, topic-safe). On terminate the host's registry entry
  is dropped under owner fencing so a stale terminate after a reconnect
  cannot clobber a newer runner.

  Server → runner pushes (`spawn` / `stop` / `restart` /
  `enumerate_sessions`) arrive via Endpoint.broadcast on this topic
  (relayed by AgentsChannel) and need no handler here. The runner →
  operator replies (`sessions` / `spawn_result`) are forwarded onto
  `agents:lobby`, where AgentsChannel.handle_out gates them operator-only
  (host/session info is operator-only, #27/ADR-0021).
  """

  use Phoenix.Channel

  require Logger

  alias KaoiroServer.Auth
  alias KaoiroServer.AgentActivity
  alias KaoiroServer.HostRegistry
  alias KaoiroServer.PersonaAssets
  alias KaoiroServerWeb.AgentId

  # Resource bound on a runner control message; generous for a register's
  # persona/cwd lists, far below an envelope. Bounds the whole map so an
  # oversized opaque extra key cannot reach the server process either.
  @max_payload_bytes 65_536

  @impl true
  def join("runner:" <> host_id, _params, socket) do
    with :ok <- validate_host_id(host_id),
         :ok <- Auth.authorize_runner(host_id, socket.assigns[:runner_token]) do
      # Drop the raw token once verified so it cannot leak via crash logs
      # / socket inspection.
      {:ok,
       socket
       |> assign(:host_id, host_id)
       |> assign(:runner_token, nil)}
    else
      {:error, reason} -> {:error, %{reason: to_string(reason)}}
    end
  end

  # The host_id charset matches agent_id (`[A-Za-z0-9._-]`, 1..256), so
  # reuse the single guard rather than drift a second copy. Checked before
  # auth: the charset is public, so an early reject leaks nothing.
  defp validate_host_id(host_id) do
    if AgentId.valid?(host_id), do: :ok, else: {:error, :invalid_host_id}
  end

  @impl true
  def handle_in("register", payload, socket) do
    with :ok <- check_size(payload),
         {:ok, attrs} <- parse_register(payload),
         :ok <- HostRegistry.register(socket.assigns.host_id, attrs, self()) do
      broadcast_hosts()
      {:reply, :ok, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  def handle_in("heartbeat", _payload, socket) do
    # Liveness only; result is opaque to the runner (`:noop` when the host
    # registered then dropped is not an error worth surfacing).
    _ = HostRegistry.heartbeat(socket.assigns.host_id)
    {:reply, :ok, socket}
  end

  # Runner's response to enumerate_sessions: forward to operators by
  # stamping the host_id and broadcasting onto agents:lobby, where the
  # role gate keeps it operator-only.
  def handle_in("sessions", payload, socket) do
    forward_to_operators("runner_sessions", payload, socket)
  end

  # A spawn result can now abort an Activity pending transaction, so unlike
  # the old forwarding-only path it must pass the same size/shape/ownership/
  # correlation gates as session_reset_result. Every rejected result is still
  # acknowledged: retries cannot make a stale completion become current.
  def handle_in("spawn_result", payload, socket) do
    host_id = socket.assigns.host_id

    with :ok <- check_size(payload),
         {:ok, agent_id, ok?, request_id, _reason} <- parse_spawn_result(payload),
         :ok <- require_host_owns_agent(host_id, agent_id) do
      if not ok? do
        _ = AgentActivity.resolve_transition(agent_id, request_id, false)
      end

      KaoiroServerWeb.Endpoint.broadcast(
        "agents:lobby",
        "spawn_result",
        Map.put(payload, "host_id", host_id)
      )

      {:reply, :ok, socket}
    else
      # This is deliberately an ack, not an error reply: a malformed,
      # cross-host, or stale completion must not be retried into a later
      # pending transition. It is also not forwarded to operators.
      {:error, _reason} -> {:reply, :ok, socket}
    end
  end

  # Runner's engine-catalog probe outcome (Option E, ADR-0039). Stamps the
  # host_id (from the topic) and forwards on agents:lobby, where the same
  # operator-only intercept as spawn_result / hosts gates it. The client
  # correlates by `request_id` and pairs it with a `hosts` broadcast on
  # success (the runner re-registers with the fresh catalog).
  def handle_in("catalog_result", payload, socket) do
    forward_to_operators("catalog_result", payload, socket)
  end

  # Runner's session-reset outcome (ADR-0036 F7, phase-17 17-4). Unlike
  # spawn_result this is not forwarded to operators verbatim — the
  # `session_reset_completed` / `session_reset_failed` broadcast is
  # authored by SessionResets after it correlates the request_id with a
  # live lock and (on success) detaches the pointer. Stale results
  # (unknown lock, mismatched request_id after a timeout) are silently
  # discarded there per ADR-0036 F7 stale-completion rule. We still ack
  # ok so the runner does not retry; the payload cap is honoured to
  # keep an oversized opaque blob from riding through.
  def handle_in("session_reset_result", payload, socket) do
    host_id = socket.assigns.host_id

    with :ok <- check_size(payload),
         {:ok, agent_id, request_id, ok?, reason, to_session_id} <-
           parse_session_reset_result(payload),
         :ok <- require_host_owns_agent(host_id, agent_id) do
      KaoiroServer.SessionResets.resolve(
        agent_id,
        request_id,
        ok?,
        reason,
        to_session_id
      )

      {:reply, :ok, socket}
    else
      {:error, reason} -> {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  # ADR-0024 D3 allocates every agent_id under the host as
  # `<host_id>.<rand>`. Enforce that binding here so a runner cannot
  # release another host's reset lock (or cause its detach), or abort another
  # host's AgentActivity pending transition, by echoing an agent_id it does
  # not own. `sessions` remains forwarding-only; both session_reset_result
  # and spawn_result mutate server state and must pass this guard.
  #
  # We must inverse the allocation exactly (`AgentId.host_id_from/1` —
  # everything before the LAST dot). A naive `starts_with?(agent_id,
  # host_id <> ".")` would admit a nested-prefix spoof: a runner
  # authenticated for host_id="alpha" could send agent_id="alpha.beta.rand"
  # whose true owner is "alpha.beta", because host_id / agent_id share
  # a dot-permissive charset and prefix match cannot tell the two apart.
  defp require_host_owns_agent(host_id, agent_id) do
    if AgentId.host_id_from(agent_id) == host_id do
      :ok
    else
      {:error, :agent_not_owned}
    end
  end

  @impl true
  def terminate(_reason, socket) do
    # Drop only while this channel still owns the host entry, so a stale
    # terminate after a reconnect cannot drop the new runner's entry.
    case HostRegistry.drop(socket.assigns.host_id, self()) do
      :ok -> broadcast_hosts()
      :noop -> :ok
    end
  end

  # register carries the persona trust policy and the selectable cwd
  # allow-list (#22, ADR-0031). capabilities is optional. Any type breach
  # is rejected at this boundary so a malformed declaration cannot corrupt
  # the registry.
  defp parse_register(%{"cwd_allowlist" => cwd_allowlist} = payload)
       when is_list(cwd_allowlist) do
    with {:ok, policy} <- parse_policy(payload),
         {:ok, capabilities} <- parse_capabilities(payload) do
      attrs =
        %{policy: policy, cwd_allowlist: cwd_allowlist}
        |> Map.merge(capabilities)

      {:ok, attrs}
    end
  end

  defp parse_register(_payload), do: {:error, :invalid_register}

  # ADR-0031: exactly one of `allowed_personas` (allowlist by id) or
  # `blocked_personas` (blocklist by id) may be set; absent = accept-all.
  # Legacy `personas: [%{"id" => ...}]` is accepted for one release cycle
  # as an allowlist by id with a deprecation warning; combining legacy and
  # new fields is a hard error to force the operator to pick one shape.
  defp parse_policy(payload) do
    has_legacy = Map.has_key?(payload, "personas")
    has_allow = Map.has_key?(payload, "allowed_personas")
    has_block = Map.has_key?(payload, "blocked_personas")

    cond do
      has_allow and has_block ->
        {:error, :both_persona_policies}

      (has_allow or has_block) and has_legacy ->
        {:error, :legacy_and_new_persona_policy}

      has_legacy ->
        Logger.warning(
          "RunnerRegister field `personas` is deprecated (ADR-0031); use " <>
            "`allowed_personas` (allowlist by id) or `blocked_personas` " <>
            "(blocklist by id) instead. Legacy `personas` will be removed " <>
            "in the next major release."
        )

        with {:ok, ids} <- parse_legacy_personas(payload["personas"]) do
          {:ok, {:allowlist, MapSet.new(ids)}}
        end

      has_allow ->
        with {:ok, ids} <- parse_id_list(payload["allowed_personas"], :allowed_personas) do
          {:ok, {:allowlist, MapSet.new(ids)}}
        end

      has_block ->
        with {:ok, ids} <- parse_id_list(payload["blocked_personas"], :blocked_personas) do
          {:ok, {:blocklist, MapSet.new(ids)}}
        end

      true ->
        {:ok, :accept_all}
    end
  end

  defp parse_legacy_personas(personas) when is_list(personas) do
    Enum.reduce_while(personas, {:ok, []}, fn persona, {:ok, acc} ->
      case persona do
        %{"id" => id} when is_binary(id) -> {:cont, {:ok, [id | acc]}}
        _ -> {:halt, {:error, :invalid_persona_entry}}
      end
    end)
    |> case do
      {:ok, ids} -> {:ok, Enum.reverse(ids)}
      err -> err
    end
  end

  defp parse_legacy_personas(_), do: {:error, :invalid_persona_entry}

  defp parse_id_list(list, _field) when is_list(list) do
    if Enum.all?(list, &is_binary/1) do
      {:ok, list}
    else
      {:error, :invalid_persona_id}
    end
  end

  defp parse_id_list(_, _field), do: {:error, :invalid_persona_id}

  defp parse_capabilities(payload) do
    with {:ok, caps_attrs} <- parse_capability_values(payload),
         {:ok, engines_attrs} <- parse_engines(payload) do
      {:ok, Map.merge(caps_attrs, engines_attrs)}
    end
  end

  # Legacy value "claude" is silently normalized to "claude-code" with a
  # deprecation warning for one release window (ADR-0032 F4a, decided
  # 2026-07-10); the next release rejects it outright.
  defp parse_capability_values(payload) do
    case Map.get(payload, "capabilities") do
      nil ->
        {:ok, %{}}

      caps when is_list(caps) ->
        normalized =
          Enum.map(caps, fn
            "claude" ->
              Logger.warning(
                "RunnerRegister capability \"claude\" is deprecated " <>
                  "(ADR-0032 F4a); use \"claude-code\". The alias will be " <>
                  "rejected in the next release."
              )

              "claude-code"

            other ->
              other
          end)

        {:ok, %{capabilities: normalized}}

      _ ->
        {:error, :invalid_capabilities}
    end
  end

  # Launch catalog per engine (ADR-0032 F4bc): loosely shape-checked and
  # stored as-is for the operator `hosts` push; the dashboard renders each
  # engine's model list in the LaunchDialog cascade.
  defp parse_engines(payload) do
    case Map.get(payload, "engines") do
      nil ->
        {:ok, %{}}

      engines when is_list(engines) ->
        valid? =
          Enum.all?(engines, fn
            %{"id" => id, "models" => models} when is_binary(id) and is_list(models) -> true
            _ -> false
          end)

        if valid? do
          {:ok, %{engines: engines}}
        else
          {:error, :invalid_engines}
        end

      _ ->
        {:error, :invalid_engines}
    end
  end

  defp forward_to_operators(event, payload, socket) do
    with :ok <- check_size(payload),
         true <- is_map(payload) do
      stamped = Map.put(payload, "host_id", socket.assigns.host_id)
      KaoiroServerWeb.Endpoint.broadcast("agents:lobby", event, stamped)
      {:reply, :ok, socket}
    else
      false -> {:reply, {:error, %{reason: "invalid_payload"}}, socket}
      {:error, reason} -> {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  # Push the aggregated host snapshot to operators after a register/drop so
  # the operator UI sees the live host set without polling. AgentsChannel
  # gates "hosts" operator-only (cwd allow-lists are sensitive, #46).
  defp broadcast_hosts do
    KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "hosts", %{
      "hosts" => HostRegistry.snapshot(PersonaAssets.all_personas())
    })
  end

  defp check_size(payload) do
    if :erlang.external_size(payload) <= @max_payload_bytes do
      :ok
    else
      {:error, :payload_too_large}
    end
  end

  defp parse_spawn_result(%{"agent_id" => agent_id, "ok" => ok?} = payload)
       when is_binary(agent_id) and is_boolean(ok?) do
    with {:ok, request_id} <- parse_optional_request_id(Map.get(payload, "request_id")),
         {:ok, reason} <- parse_optional_reason(Map.get(payload, "reason")) do
      {:ok, agent_id, ok?, request_id, reason}
    end
  end

  defp parse_spawn_result(_payload), do: {:error, :invalid_spawn_result}

  defp parse_optional_request_id(nil), do: {:ok, nil}
  defp parse_optional_request_id(value) when is_binary(value), do: {:ok, value}
  defp parse_optional_request_id(_), do: {:error, :invalid_spawn_result}

  defp parse_optional_reason(nil), do: {:ok, nil}
  defp parse_optional_reason(value) when is_binary(value), do: {:ok, value}
  defp parse_optional_reason(_), do: {:error, :invalid_spawn_result}

  # Closed-vocabulary parse for `session_reset_result` (ADR-0036 F7,
  # phase-17 17-4). Structural gates only; SessionResets owns the lock /
  # request_id correlation and the closed-vocab reason atom. A malformed
  # runner reply is refused here rather than passed through — the
  # runner has to fix its own bug.
  @session_reset_modes ["new", "clear"]
  defp parse_session_reset_result(
         %{
           "agent_id" => agent_id,
           "request_id" => request_id,
           "ok" => ok?
         } = payload
       )
       when is_binary(agent_id) and is_binary(request_id) and is_boolean(ok?) do
    with true <- Map.get(payload, "mode", "new") in @session_reset_modes,
         {:ok, reason} <- parse_reset_reason(payload["reason"], ok?),
         {:ok, to_sid} <- parse_optional_session_id(payload["to_session_id"]) do
      {:ok, agent_id, request_id, ok?, reason, to_sid}
    else
      false -> {:error, :invalid_mode}
      {:error, reason} -> {:error, reason}
    end
  end

  defp parse_session_reset_result(_payload), do: {:error, :invalid_payload}

  # ADR-0036 F7 closed error vocabulary. Success carries no reason; a
  # failure requires one from the whitelist.
  @reset_failure_reasons [
    "agent_busy",
    "unsupported_session_reset",
    "session_reset_pending",
    "runner_unavailable",
    "spawn_failed",
    "rollback_failed",
    "timeout"
  ]
  defp parse_reset_reason(nil, true), do: {:ok, nil}

  defp parse_reset_reason(reason, false)
       when reason in @reset_failure_reasons,
       do: {:ok, reason}

  defp parse_reset_reason(_reason, _ok), do: {:error, :invalid_reason}

  defp parse_optional_session_id(nil), do: {:ok, nil}
  defp parse_optional_session_id(sid) when is_binary(sid), do: {:ok, sid}
  defp parse_optional_session_id(_sid), do: {:error, :invalid_session_id}
end
