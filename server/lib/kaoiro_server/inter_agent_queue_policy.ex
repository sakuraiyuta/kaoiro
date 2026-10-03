defmodule KaoiroServer.InterAgentQueuePolicy do
  @moduledoc """
  Join-time validation of the `credit-v1` queue declaration
  (docs/reference/protocol/channels.md, "Server-owned inter-agent queue").

  The wrapper declares a complete `{batch_max_items, backlog_max_items,
  backlog_max_bytes}` tuple whose defaults the launcher already resolved.
  The server never fills in a missing field: a partial tuple is refused, so
  the bound limits are always the ones the operator configured.

  What holds whatever a wrapper declares are the server-owned ceilings:
  `backlog_max_items` at most 1000 (the per-recipient unresolved ceiling), and `backlog_max_bytes` at most the configured
  `:inter_agent_queue` `backlog_max_bytes_ceiling`.
  """

  @backlog_max_items_ceiling 1_000
  # The largest integer every JSON peer reads exactly (2^53 - 1).
  @max_safe_integer 9_007_199_254_740_991
  @backlog_max_bytes_minimum 16_384

  @prerequisites [
    {"inter_agent_delivery_ack", "dispatch-v1"},
    {"delivery_resync", "skip-v1"}
  ]

  @type policy :: %{
          batch_max_items: pos_integer(),
          backlog_max_items: pos_integer(),
          backlog_max_bytes: pos_integer()
        }

  @type join :: %{policy: policy(), inline_recovery: boolean()}

  def backlog_max_bytes_minimum, do: @backlog_max_bytes_minimum

  @doc "The operator's per-recipient ceiling for `backlog_max_bytes`."
  def backlog_max_bytes_ceiling do
    :kaoiro_server
    |> Application.fetch_env!(:inter_agent_queue)
    |> Keyword.fetch!(:backlog_max_bytes_ceiling)
  end

  @doc """
  Validates the queue fields of a wrapper join. `:absent` means the wrapper
  did not declare the queue at all.
  """
  @spec validate_join(map(), pos_integer()) :: :absent | {:ok, join()} | {:error, map()}
  def validate_join(params, ceiling \\ backlog_max_bytes_ceiling())

  def validate_join(params, _ceiling) when not is_map_key(params, "inter_agent_queue"),
    do: :absent

  def validate_join(params, ceiling) do
    with :ok <- require_capability(params),
         {:ok, policy} <- validate_policy(params["inter_agent_queue_policy"], ceiling) do
      {:ok, %{policy: policy, inline_recovery: params["inter_agent_inline_recovery"] == "v1"}}
    end
  end

  @doc "The wire shape of a bound policy, as echoed in the join reply."
  def to_wire(policy) do
    %{
      "batch_max_items" => policy.batch_max_items,
      "backlog_max_items" => policy.backlog_max_items,
      "backlog_max_bytes" => policy.backlog_max_bytes
    }
  end

  defp require_capability(params) do
    fixed =
      for {field, value} <- [{"inter_agent_queue", "credit-v1"} | @prerequisites],
          params[field] != value,
          do: field

    generation =
      if valid_generation?(params["delivery_generation"]), do: [], else: ["delivery_generation"]

    case fixed ++ generation ++ inline_recovery_missing(params) do
      [] -> :ok
      missing -> {:error, %{reason: "queue_capability_required", missing: missing}}
    end
  end

  defp valid_generation?(generation),
    do: is_binary(generation) and byte_size(generation) in 1..128

  # Inline recovery is optional, but a declaration the server cannot honour
  # is refused rather than silently dropped: the wrapper would otherwise
  # expect `queue_recovery` that never comes.
  defp inline_recovery_missing(params) do
    cond do
      not is_map_key(params, "inter_agent_inline_recovery") -> []
      params["inter_agent_inline_recovery"] != "v1" -> ["inter_agent_inline_recovery"]
      params["inter_agent_reply_basis"] != "v1" -> ["inter_agent_reply_basis"]
      true -> []
    end
  end

  defp validate_policy(policy, ceiling) when is_map(policy) do
    bounds = [
      {:batch_max_items, 1, @max_safe_integer},
      {:backlog_max_items, 1, @backlog_max_items_ceiling},
      {:backlog_max_bytes, @backlog_max_bytes_minimum, ceiling}
    ]

    Enum.reduce_while(bounds, {:ok, %{}}, fn {field, min, max}, {:ok, acc} ->
      case check_field(policy, field, min, max) do
        {:ok, value} -> {:cont, {:ok, Map.put(acc, field, value)}}
        {:error, _} = error -> {:halt, error}
      end
    end)
  end

  defp validate_policy(_policy, _ceiling),
    do: {:error, invalid("inter_agent_queue_policy", "missing")}

  defp check_field(policy, key, min, max) do
    field = Atom.to_string(key)

    case Map.fetch(policy, field) do
      :error ->
        {:error, invalid(field, "missing")}

      {:ok, value} when not is_integer(value) ->
        {:error, invalid(field, "not_integer")}

      {:ok, value} when value < min ->
        {:error, invalid(field, "below_minimum", min)}

      {:ok, value} when max != nil and value > max ->
        {:error, invalid(field, "above_ceiling", max)}

      {:ok, value} ->
        {:ok, value}
    end
  end

  @doc "The `invalid_queue_policy` join error."
  def invalid(field, detail, limit \\ nil) do
    %{reason: "invalid_queue_policy", field: field, detail: detail}
    |> then(&if(limit == nil, do: &1, else: Map.put(&1, :limit, limit)))
  end
end
