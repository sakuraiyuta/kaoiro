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

  Call sites bind a budget into a module attribute, so it is evaluated at
  COMPILE time. It still picks up the configured base because `mix test`
  requires `test_helper.exs` before it compiles any test file (verified
  against Mix 1.20.1 `test.ex` and by a compile-time probe under `CI=1`).
  """

  @purge_multiplier 5

  @doc """
  Budget for a successful `delete_agent` reply — #{@purge_multiplier}x the
  base.

  `delete_agent` is the slowest reply path in the agents channel: the
  reply only follows `purge_agent_records/1`, which clears ~13 stores in
  sequence, 9 of them DETS-backed and four of those `GenServer.call` +
  `:dets.sync/1` before their own reply. Measured on a loaded host (53
  purge-path samples, 2026-09-07): p50 57 ms, p90 320 ms, max 446 ms.

  Issue #266 sized this at a literal 500 on 2026-08-30, when the base was
  an unconfigured 100; issue #282 raised the CI base to 500 the next day,
  leaving the CI budget with no headroom at all (issue #320 flake C).
  """
  def purge_reply(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def purge_reply(base) when is_integer(base) and base > 0 do
    @purge_multiplier * base
  end

  @out_of_band_multiplier 5

  @doc """
  Budget for a receive that waits on an effect reaching this process
  through ANOTHER one — a monitor's `:DOWN`, a link's `:EXIT`, a file
  watcher's broadcast — instead of on a direct reply.
  #{@out_of_band_multiplier}x the base, so 500 ms locally, unchanged from
  the literal these sites carried.

  The multiplier equals `purge_reply/1`'s by coincidence, not by shared
  derivation, so the two are kept apart: that one comes from issue #266's
  sizing of the purge chain, this one from the literal 500 these sites
  carried when the base was 100. Merging them would let a change made for
  one reason move the other silently.
  """
  def out_of_band(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def out_of_band(base) when is_integer(base) and base > 0 do
    @out_of_band_multiplier * base
  end

  @slow_path_multiplier 10

  @doc """
  Budget for a wait whose completion depends on another process finishing
  work this one cannot observe — a `GenServer.stop/1` cycle deliberately
  raced against a signal, or a loop of channel round-trips inside a single
  test. #{@slow_path_multiplier}x the base, so 1000 ms locally, unchanged
  from the literal these sites carried.
  """
  def slow_path(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def slow_path(base) when is_integer(base) and base > 0 do
    @slow_path_multiplier * base
  end

  @supervised_restart_multiplier 50

  @doc """
  Budget for stopping a supervised process and waiting for its `:DOWN`,
  where the supervisor's restart competes for the same scheduler.
  #{@supervised_restart_multiplier}x the base, so 5000 ms locally,
  unchanged from the literal the site carried.
  """
  def supervised_restart(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def supervised_restart(base) when is_integer(base) and base > 0 do
    @supervised_restart_multiplier * base
  end
end
