defmodule KaoiroServer.InterAgentReplyBasis do
  @moduledoc "Validated ordinary reply basis or a closed internal-notice contract."

  use GenServer

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, %{}, name: Keyword.get(opts, :name, __MODULE__))

  def register(id, owner, protected?),
    do: GenServer.call(__MODULE__, {:register, id, owner, protected?})

  def unregister(id, owner), do: GenServer.call(__MODULE__, {:unregister, id, owner})
  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  @impl true
  def init(state), do: {:ok, state}
  @impl true
  def handle_call({:register, id, owner, protected?}, _from, state) do
    if map_size(state) < 1000 or Map.has_key?(state, id) do
      {:reply, :ok, Map.put(state, id, {owner, if(protected?, do: "v1", else: "legacy")})}
    else
      {:reply, :unreported, state}
    end
  end

  def handle_call({:unregister, id, owner}, _from, state) do
    next =
      case state[id] do
        {^owner, _mode} -> Map.delete(state, id)
        _ -> state
      end

    {:reply, :ok, next}
  end

  def handle_call(:snapshot, _from, state),
    do: {:reply, Map.new(state, fn {id, {_owner, mode}} -> {id, mode} end), state}

  @max_safe_integer 9_007_199_254_740_991
  @messages %{
    "rate_limit" => "the peer hit a rate limit",
    "context_overflow" => "the peer's context window overflowed",
    "api_error" => "the peer reported an unspecified error",
    "timeout" => "the peer's turn timed out",
    "interrupted" => "the peer's turn was interrupted",
    "permission_gate_blocked" =>
      "the peer stopped waiting to start an execution because permission dispatch remained blocked; the operator must reapply the same sandbox/network values to create a new revision before you resend",
    "stale_turn" => "the peer's local turn counter had already advanced past this message"
  }

  def admission(payload, true) do
    cond do
      Map.has_key?(payload, "notice_type") ->
        if valid_notice?(payload), do: {:ok, :notice}, else: {:error, :invalid_internal_notice}

      is_integer(payload["in_reply_to"]) and payload["in_reply_to"] in 0..@max_safe_integer ->
        {:ok, payload["in_reply_to"]}

      true ->
        {:error, :invalid_reply_basis}
    end
  end

  def admission(payload, _) do
    if Map.has_key?(payload, "notice_type"),
      do: {:error, :invalid_internal_notice},
      else: {:ok, :legacy}
  end

  defp valid_notice?(%{"error" => %{"code" => code, "message" => message} = error} = payload) do
    allowed =
      ~w(to conversation_id turn_number kind body meta owner new_conversation error notice_type)

    permitted_code =
      case payload["notice_type"] do
        "stale_delivery" -> code == "stale_turn"
        "turn_failure" -> Map.has_key?(@messages, code) and code != "stale_turn"
        _ -> false
      end

    permitted_code and Enum.all?(Map.keys(payload), &(&1 in allowed)) and
      payload["new_conversation"] == false and payload["kind"] == "inform" and
      payload["meta"] == %{"done" => false, "propose_next" => ""} and
      Enum.all?(Map.keys(error), &(&1 in ~w(code message reset_delay_seconds))) and
      valid_message?(code, message, error) and
      payload["body"] == "peer error (#{code}): #{message}"
  end

  defp valid_notice?(_), do: false

  defp valid_message?("rate_limit", message, %{"reset_delay_seconds" => seconds})
       when is_integer(seconds) and seconds in 0..@max_safe_integer do
    hours = div(seconds, 3600)
    minutes = div(rem(seconds, 3600), 60)
    remainder = rem(seconds, 60)

    duration =
      if(hours > 0, do: "#{hours}h", else: "") <>
        if(minutes > 0, do: "#{minutes}m", else: "") <>
        if remainder > 0 or seconds == 0, do: "#{remainder}s", else: ""

    message == @messages["rate_limit"] <> "; Resets in " <> duration
  end

  defp valid_message?(code, message, error),
    do: not Map.has_key?(error, "reset_delay_seconds") and message == @messages[code]
end
