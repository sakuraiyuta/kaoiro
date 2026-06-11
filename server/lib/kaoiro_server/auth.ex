defmodule KaoiroServer.Auth do
  @moduledoc """
  Token auth for the wrapper and client sockets (ADR-0011).

  Token lists come from env via runtime config:

  - `:wrapper_tokens` — `"agent_id:token,agent_id:token"`
  - `:client_tokens` — `"token:role,..."` (role: `viewer` | `operator`)

  An unset/empty list disables enforcement for that socket — development
  convenience; clients then act as operator so the bidirectional flow
  can be exercised (specs/protocol.md, specs/threat-model.md).
  """

  require Logger

  @doc """
  Authorizes a wrapper connection for `agent_id`. `:ok` when the token
  matches, or when no wrapper tokens are configured.
  """
  def authorize_wrapper(agent_id, token) do
    tokens = parse_pairs(Application.get_env(:kaoiro_server, :wrapper_tokens))

    if tokens == %{} do
      :ok
    else
      # Run the comparison even for an unknown agent_id so timing does
      # not reveal which agent_ids have token entries.
      expected = Map.get(tokens, agent_id, "")
      presented = if is_binary(token), do: token, else: ""
      matched = Plug.Crypto.secure_compare(expected, presented)

      if Map.has_key?(tokens, agent_id) and matched do
        :ok
      else
        {:error, :unauthorized}
      end
    end
  end

  @doc """
  Resolves a client token to its role (`:viewer` | `:operator`).
  `{:ok, :operator}` for any connection when no client tokens are
  configured (dev mode).
  """
  def client_role(token) do
    tokens = parse_pairs(Application.get_env(:kaoiro_server, :client_tokens))

    cond do
      tokens == %{} -> {:ok, :operator}
      role = role_for(tokens, token) -> {:ok, role}
      true -> {:error, :unauthorized}
    end
  end

  defp role_for(tokens, token) when is_binary(token) do
    # Constant-time scan: compare against every entry so lookup timing
    # does not reveal whether a token exists.
    Enum.reduce(tokens, nil, fn {expected, role}, acc ->
      if matches?(expected, token), do: parse_role(role), else: acc
    end)
  end

  defp role_for(_tokens, _token), do: nil

  defp parse_role("viewer"), do: :viewer
  defp parse_role("operator"), do: :operator
  defp parse_role(_), do: nil

  defp matches?(expected, presented) do
    is_binary(expected) and is_binary(presented) and
      Plug.Crypto.secure_compare(expected, presented)
  end

  # "a:b,c:d" -> %{"a" => "b", "c" => "d"}; malformed entries are
  # skipped with a warning (fail visible, not fatal).
  defp parse_pairs(raw) when is_binary(raw) and raw != "" do
    raw
    |> String.split(",", trim: true)
    |> Enum.reduce(%{}, fn pair, acc ->
      case String.split(pair, ":", parts: 2) do
        [key, value] when key != "" and value != "" ->
          Map.put(acc, String.trim(key), String.trim(value))

        _ ->
          Logger.warning("ignoring malformed auth token entry")
          acc
      end
    end)
  end

  defp parse_pairs(_raw), do: %{}
end
