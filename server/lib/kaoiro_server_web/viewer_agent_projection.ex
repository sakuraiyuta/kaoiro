defmodule KaoiroServerWeb.ViewerAgentProjection do
  @moduledoc "Shared viewer envelope allowlist for channels and persona delivery."

  # state_change is the viewer's only direct grid signal; `ext` carries
  # cwd / model / context / rate_limits / slash_commands and any future
  # additions, all operator-only.
  def sanitize(%{"type" => "state_change"} = envelope) do
    {:ok, Map.delete(envelope, "ext")}
  end

  # `permission_request` carries request_id / tool_name / input — all
  # operator-only — but the wrapper also overwrites the snapshot slot, so
  # dropping it outright would erase the agent from the viewer's grid.
  # Rewrite it as a minimal synthetic state_change so `waiting_permission`
  # still renders without leaking any payload field.
  def sanitize(%{"type" => "permission_request"} = envelope) do
    {:ok,
     envelope
     |> Map.put("type", "state_change")
     |> Map.put("state", "waiting_permission")
     |> Map.put("payload", %{})
     |> Map.delete("ext")}
  end

  # `question_request` carries the AskUserQuestion questions (operator-only,
  # ADR-0027) and likewise overwrites the snapshot slot, so it is rewritten to
  # a synthetic state_change — the viewer grid still shows `waiting_question`
  # without leaking the question text or options.
  def sanitize(%{"type" => "question_request"} = envelope) do
    {:ok,
     envelope
     |> Map.put("type", "state_change")
     |> Map.put("state", "waiting_question")
     |> Map.put("payload", %{})
     |> Map.delete("ext")}
  end

  # `session_boundary` marker (ADR-0036 F3, phase-17 17-7). Keep the
  # visual "boundary exists" cue (mode / state / ts / persona), but drop
  # the operator-only correlation IDs (`request_id`, `previous_session_id`,
  # `to_session_id`) — viewers must not learn session identifiers even
  # cosmetically.
  def sanitize(%{"type" => "session_boundary"} = envelope) do
    payload = Map.get(envelope, "payload") || %{}
    safe_payload = Map.take(payload, ["mode"])

    {:ok,
     envelope
     |> Map.put("payload", safe_payload)
     |> Map.delete("ext")}
  end

  # inter_agent_message is operator-only by spec (docs/reference/inter-agent/coordination-monitoring.md);
  # listed explicitly for symmetry with the other typed clauses, even though
  # the fail-closed catch-all below would already drop it.
  def sanitize(%{"type" => "inter_agent_message"}), do: :drop

  def sanitize(_envelope), do: :drop
end
