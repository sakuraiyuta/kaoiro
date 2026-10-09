defmodule KaoiroServerWeb.ViewerAgentProjection do
  @moduledoc "Shared viewer envelope allowlist for channels and persona delivery."

  # state_change is the viewer's only direct grid signal; `ext` carries
  # cwd / model / context / rate_limits / slash_commands and any future
  # additions, all operator-only.
  def sanitize(%{"type" => "state_change"} = envelope) do
    {:ok, policy_only(envelope)}
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
     |> policy_only()}
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
     |> policy_only()}
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

  defp policy_only(envelope) do
    stripped = Map.delete(envelope, "ext")

    policy =
      case Map.get(envelope, "ext") do
        ext when is_map(ext) -> ext["delivery_policy"]
        _ -> nil
      end

    case policy do
      %{
        "policy" => policy,
        "confirmed" => confirmed,
        "pending" => pending,
        "wrapper_support" => support
      } = view
      when policy in ["on", "off", "unknown"] and is_boolean(confirmed) and is_boolean(pending) and
             is_boolean(support) ->
        safe =
          Map.take(view, ~w(policy revision applied_revision confirmed pending wrapper_support))
          |> put_mechanisms(view["mechanisms"])

        Map.put(stripped, "ext", %{"delivery_policy" => safe})

      _ ->
        stripped
    end
  end

  defp put_mechanisms(view, %{
         "operator_early" => operator,
         "inter_agent_early" => peer,
         "inter_agent_yield" => yield
       })
       when operator in ["fold", "steer", "hook", "none"] and
              peer in ["fold", "steer", "hook", "none"] and
              yield in ["tool_boundary", "none"] do
    Map.put(view, "mechanisms", %{
      "operator_early" => operator,
      "inter_agent_early" => peer,
      "inter_agent_yield" => yield
    })
  end

  defp put_mechanisms(view, _), do: view
end
