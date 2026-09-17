defmodule KaoiroServerWeb.DeliveryLossDispatcher do
  @moduledoc "Delivers durable loss intents outside the delivery ledger process."
  use GenServer
  alias KaoiroServer.{AgentStates, ConversationStates, DeliveryStates, PlannedDisconnects}
  alias KaoiroServerWeb.SynthEnvelope

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def flush, do: GenServer.call(__MODULE__, :flush)

  @impl true
  def init(_opts) do
    Process.send_after(self(), :flush, 1_000)
    {:ok, nil}
  end

  @impl true
  def handle_call(:flush, _from, state), do: {:reply, deliver_pending(), state}

  @impl true
  def handle_info(:flush, state) do
    deliver_pending()
    Process.send_after(self(), :flush, 1_000)
    {:noreply, state}
  end

  defp deliver_pending do
    DeliveryStates.pending_losses()
    |> Enum.filter(fn loss ->
      recipient = if loss.descriptor[:synthetic], do: loss.recipient, else: loss.descriptor.sender
      AgentStates.connected?(recipient)
    end)
    |> Enum.take(100)
    |> Enum.each(fn loss ->
      descriptor = loss.descriptor
      recipient = if descriptor[:synthetic], do: loss.recipient, else: descriptor.sender

      if AgentStates.connected?(recipient) do
        {payload, next_descriptor} = regenerate(loss, recipient)
        envelope = SynthEnvelope.build(payload, DateTime.to_iso8601(DateTime.utc_now()))
        SynthEnvelope.deliver(recipient, envelope, Map.put(next_descriptor, :loss_id, loss.id))
        DeliveryStates.complete_loss(loss.id, loss.revision)
      end
    end)
  end

  defp regenerate(
         %{descriptor: %{synthetic: true, kind: kind, subject: subject}} = loss,
         recipient
       )
       when kind in ["reconnecting", "reconnected", "disconnected"] do
    current =
      cond do
        PlannedDisconnects.get(subject) != nil -> "reconnecting"
        AgentStates.connected?(subject) -> "reconnected"
        true -> "disconnected"
      end

    message = "peer #{subject} is #{current} (delivery recovery)"
    payload = base(recipient, loss, message)

    payload =
      if current == "reconnected",
        do: payload,
        else: Map.put(payload, "error", %{"code" => current, "message" => message})

    {payload, %{loss.descriptor | kind: current}}
  end

  defp regenerate(
         %{descriptor: %{synthetic: true, kind: "conversation_closed"}} = loss,
         recipient
       ) do
    case ConversationStates.get(loss.descriptor.conversation_id) do
      %{status: :closed, agents: agents, reason: reason} ->
        if recipient in agents do
          payload = base(recipient, loss, "conversation closed: #{reason}")

          {Map.merge(payload, %{
             "kind" => "done",
             "meta" => %{"done" => true, "propose_next" => ""}
           }), loss.descriptor}
        else
          lost_notice(loss, recipient)
        end

      _ ->
        lost_notice(loss, recipient)
    end
  end

  defp regenerate(loss, recipient), do: lost_notice(loss, recipient)

  defp lost_notice(loss, recipient) do
    synthetic = loss.descriptor[:synthetic] == true

    message =
      if synthetic,
        do: "a server notice was lost; confirm the current peer or conversation state",
        else: "the peer did not dispatch the message; confirm its state before retrying"

    error = %{
      "code" => if(synthetic, do: "delivery_lost", else: loss.reason),
      "message" => message,
      "synthetic" => synthetic,
      "kind" => loss.descriptor.kind,
      "loss_id" => loss.id,
      "peer" => loss.recipient
    }

    payload = Map.put(base(recipient, loss, message), "error", error)
    # Recovery notices are recipient-addressed; their loss must never notify a sender.
    descriptor = %{
      synthetic: true,
      kind: loss.descriptor.kind,
      conversation_id: loss.descriptor.conversation_id
    }

    {payload, descriptor}
  end

  defp base(recipient, loss, message) do
    %{
      "to" => recipient,
      "conversation_id" => loss.descriptor.conversation_id,
      "turn_number" => 0,
      "kind" => "inform",
      "body" => message,
      "meta" => %{"done" => false, "propose_next" => ""},
      "owner" => %{"kind" => "user", "id" => "system"},
      "loss_id" => loss.id
    }
  end
end
