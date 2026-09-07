defmodule KaoiroServer.TestTimeouts do
  @moduledoc """
  Receive budgets for channel replies whose handler is too slow for
  ExUnit's own default. Test-only — `test/support` is compiled in `:test`
  alone.

  A budget is a MULTIPLE of ExUnit's configured `:assert_receive_timeout`,
  never an absolute millisecond literal, because that base is not a
  constant: `test_helper.exs` raises it to 500 under `CI` (issue #282).
  A literal picked to sit above the local default therefore equals the
  base in CI, and the headroom it was written for silently becomes zero.
  """

  @purge_multiplier 5

  @doc """
  Budget for a successful `delete_agent` reply — #{@purge_multiplier}x the
  base.

  `delete_agent` is the slowest reply path in the agents channel: the
  reply only follows `purge_agent_records/1`, which clears ~13 stores in
  sequence, 9 of them DETS-backed and four of those `GenServer.call` +
  `:dets.sync/1` before their own reply. Measured on a loaded host: p50
  57 ms, p90 320 ms, max 446 ms.

  Issue #266 sized this at a literal 500 on 2026-08-30, when the base was
  an unconfigured 100; issue #282 raised the CI base to 500 the next day,
  leaving the CI budget with no headroom at all (issue #320 flake C).
  """
  def purge_reply(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def purge_reply(base) when is_integer(base) and base > 0 do
    @purge_multiplier * base
  end
end
