defmodule KaoiroServerWeb.StatusLineVisibility do
  @moduledoc """
  The one rule for whether a viewer may see an agent's status line (issue 482
  design r3 D5, ADR-0030 D10 unchanged).

  A viewer sees status lines only for the agents in its own role-filtered
  snapshot, so the rule is: an `AgentStates` entry exists for the agent and
  `ViewerAgentProjection.sanitize/1` does not drop its latest envelope. The join
  snapshot, the live event and the history request all call this function, and
  `AgentStates` calls it to detect that an agent has just become visible. None
  of them re-implements it.

  The argument is the agent's latest envelope, or `nil` when it has no entry
  (directory-only agents have none, so they are never visible).
  """

  alias KaoiroServerWeb.ViewerAgentProjection

  @spec viewer_visible?(map() | nil) :: boolean()
  def viewer_visible?(nil), do: false
  def viewer_visible?(envelope), do: match?({:ok, _}, ViewerAgentProjection.sanitize(envelope))
end
