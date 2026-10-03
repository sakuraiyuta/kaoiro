defmodule KaoiroServerWeb.StatusLineSnapshot do
  @moduledoc """
  The `status_line_snapshot` frame pushed to a client right after its join
  snapshot (issue 482 design r3 D5, r5 section 6).

  An operator receives every committed row, cleared ones as stamped rows. A
  viewer receives only the rows of agents in its own role-filtered snapshot:
  the same `AgentStates` snapshot that built the join's agent frame goes through
  `StatusLineVisibility`, the one predicate, so a hidden or directory-only
  agent's line never reaches it.

  The frame is supplementary display data and is deliberately not one of the
  closed join snapshot frames: it is pushed after them. When the store is
  unavailable, or the frame would not fit the transport budget, the frame is
  `{agents: {}, snapshot_incomplete: true}` and the client shows no row, never
  an "unset" one.
  """

  alias KaoiroServer.{AgentStatusLines, StatusLineWire, TransportLimits}
  alias KaoiroServerWeb.StatusLineVisibility

  @event "status_line_snapshot"

  def event, do: @event

  @spec build(atom() | nil, %{String.t() => map()}, (String.t(), map() -> boolean())) :: map()
  def build(role, states, fits? \\ &TransportLimits.snapshot_frame_fits?/2) do
    with {:ok, heads} <- AgentStatusLines.heads(),
         payload = %{"agents" => entries(role, heads, states)},
         true <- fits?.(@event, payload) do
      payload
    else
      _ -> %{"agents" => %{}, "snapshot_incomplete" => true}
    end
  end

  defp entries(:viewer, heads, states) do
    for {id, envelope} <- states,
        StatusLineVisibility.viewer_visible?(envelope),
        row = Map.get(heads, id),
        into: %{},
        do: {id, StatusLineWire.snapshot_entry(row)}
  end

  defp entries(role, heads, _states) when role in [:operator, :admin] do
    Map.new(heads, fn {id, row} -> {id, StatusLineWire.snapshot_entry(row)} end)
  end

  defp entries(_role, _heads, _states), do: %{}
end
