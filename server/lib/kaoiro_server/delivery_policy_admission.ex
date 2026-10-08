defmodule KaoiroServer.DeliveryPolicyAdmission do
  @moduledoc false
  alias KaoiroServer.DeliveryPolicies
  alias KaoiroServer.DeliveryPolicies.State

  def snapshot(id) do
    case DeliveryPolicies.snapshot(id) do
      {:ok, row, snapshot} ->
        %{
          row: row,
          owner: snapshot,
          denial: State.denial(row, snapshot),
          view: State.view(row, snapshot)
        }

      _ ->
        %{row: nil, owner: nil, denial: "policy_unknown", view: State.view(nil, nil)}
    end
  end

  def refresh(id) do
    state = snapshot(id)
    KaoiroServer.AgentStates.overlay_delivery_policy(id, state.view)

    KaoiroServerWeb.Endpoint.broadcast("agents:lobby", "delivery_policy_changed", %{
      "version" => "0",
      "agent_id" => id,
      "delivery_policy" => state.view
    })

    state
  end

  def operator_intent(_id, "normal"), do: {"normal", nil}

  def operator_intent(id, requested) do
    state = snapshot(id)
    modes = if state.owner, do: state.owner.operator_modes || state.owner.modes
    intent = requested || if(modes && modes["early"] != "none", do: "early", else: "normal")

    cond do
      intent == "normal" ->
        {intent, nil}

      state.denial != nil ->
        {"normal", state.denial}

      intent != "early" or modes == nil or modes[intent] in [nil, "none"] ->
        {"normal", "unsupported_by_recipient"}

      true ->
        {intent, nil}
    end
  end
end
