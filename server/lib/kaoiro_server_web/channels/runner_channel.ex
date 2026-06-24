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

  alias KaoiroServer.Auth
  alias KaoiroServer.HostRegistry
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

  # register carries the spawnable personas and selectable cwd allow-list
  # (#22); capabilities is optional. personas/cwd_allowlist must be lists
  # so a malformed declaration is rejected at this boundary instead of
  # corrupting the registry.
  defp parse_register(%{"personas" => personas, "cwd_allowlist" => cwd_allowlist} = payload)
       when is_list(personas) and is_list(cwd_allowlist) do
    attrs = %{personas: personas, cwd_allowlist: cwd_allowlist}

    case Map.get(payload, "capabilities") do
      nil -> {:ok, attrs}
      caps when is_list(caps) -> {:ok, Map.put(attrs, :capabilities, caps)}
      _ -> {:error, :invalid_capabilities}
    end
  end

  defp parse_register(_payload), do: {:error, :invalid_register}

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
      "hosts" => HostRegistry.snapshot()
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
