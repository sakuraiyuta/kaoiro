defmodule KaoiroServerWeb.AgentId do
  @moduledoc """
  agent_id charset guard enforced at the channel boundary (issue #61).

  `specs/protocol.md` constrains agent_id to `[A-Za-z0-9._-]`, 1..256
  chars. Both the wrapper join and the operator relay path validate
  against this single source of truth so the two boundaries can never
  drift apart: an authenticated-but-compromised wrapper must not be able
  to register a topic-breaking id (`*` / `#`) in `AgentStates`.
  """

  @pattern ~r/^[A-Za-z0-9._-]{1,256}$/

  @doc "True when `agent_id` is a binary matching the protocol charset."
  def valid?(agent_id) when is_binary(agent_id), do: Regex.match?(@pattern, agent_id)
  def valid?(_agent_id), do: false

  @doc """
  Recovers the owning host_id from a server-allocated agent_id
  (`<host_id>.<rand>`, ADR-0024 D3). The dot-free random suffix means
  the host_id is everything before the LAST dot; a plain agent_id with
  no dot (an operator-supplied fixed id, or a legacy value) yields
  itself so callers do not have to special-case it.

  Callers that need to bind an agent_id to a runner's host_id MUST use
  this — a naive `String.starts_with?(agent_id, host_id <> ".")` admits
  nested-prefix spoofing when the host_id itself contains dots
  (e.g. host_id="alpha" would incorrectly own agent_id="alpha.beta.x"
  whose true host is "alpha.beta").
  """
  def host_id_from(agent_id) when is_binary(agent_id) do
    case String.split(agent_id, ".") do
      parts when length(parts) > 1 -> parts |> Enum.drop(-1) |> Enum.join(".")
      _ -> agent_id
    end
  end
end
