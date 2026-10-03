defmodule KaoiroServerWeb.DirectoryEligibility do
  @moduledoc """
  Which agents a peer may see: the one membership rule behind both
  `directory_request` (the `list_agents` tool) and `status_line_get`
  (`read_status_line`) (issue 482 design r4 section 3, r5 section 7).

  An id is eligible when it is in `AgentStates`, or when `AgentDirectory` has an
  entry for it that `directory_only?/2` accepts. Eligibility is decided before
  the 32-entry cap on directory-only entries (the cap bounds the size of a
  reply, not who may be read) and before the requester is left out of its own
  directory (reading one's own line is harmless).
  """

  alias KaoiroServer.{AgentDirectory, AgentStates}
  alias KaoiroServerWeb.AgentId

  @doc """
  Whether an `AgentDirectory` entry becomes a directory-only entry: the id is a
  valid agent id (the directory's DETS load only checks `is_binary`, so this is
  the first place a persisted id is vetted before it reaches an agent) and the
  entry names a persona.
  """
  @spec directory_only?(term(), term()) :: boolean()
  def directory_only?(id, %{persona_id: _persona_id}) when is_binary(id), do: AgentId.valid?(id)
  def directory_only?(_id, _entry), do: false

  @doc "The eligible ids for the given `AgentStates` and `AgentDirectory` snapshots."
  @spec eligible_ids(%{String.t() => term()}, %{String.t() => map()}) :: MapSet.t(String.t())
  def eligible_ids(states, directory) when is_map(states) and is_map(directory) do
    directory_only =
      for {id, entry} <- Map.drop(directory, Map.keys(states)),
          directory_only?(id, entry),
          do: id

    MapSet.new(Map.keys(states) ++ directory_only)
  end

  @doc "Whether `id` is eligible now."
  @spec eligible?(String.t()) :: boolean()
  def eligible?(id) when is_binary(id) do
    AgentStates.known?(id) or directory_only?(id, AgentDirectory.get(id))
  end
end
