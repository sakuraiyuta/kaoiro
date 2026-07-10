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

  # Runner's spawn outcome: same operator-only forward path.
  def handle_in("spawn_result", payload, socket) do
    forward_to_operators("spawn_result", payload, socket)
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
end
