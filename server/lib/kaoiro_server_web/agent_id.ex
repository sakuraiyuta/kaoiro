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
end
