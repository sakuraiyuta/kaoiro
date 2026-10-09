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

  A call site that binds a budget into a module attribute (as
  `@purge_reply_timeout` does) evaluates it at COMPILE time. It still
  picks up the configured base because `mix test` requires
  `test_helper.exs` before it compiles any test file (verified against
  Mix 1.20.1 `test.ex` and by a compile-time probe under `CI=1`). A call
  site inside a test body instead evaluates at RUN time, same base.
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

  @durable_reply_multiplier 5

  @doc """
  Budget for a channel reply that waits on a durable write: the handler
  replies only after a `GenServer.call` that ends in `:dets.sync/1` (an
  fsync). #{@durable_reply_multiplier}x the base, so 500 ms locally and
  2500 ms under `CI`. This is the default `assert_reply` budget of
  `KaoiroServerWeb.ChannelCase`; it is the single knob for heavy-load
  adjustment, so change the multiplier here, not per site.

  Sized against the tail of one such fsync, measured on a shared host
  (issue #477, 2026-10-01): p50 18 ms, and in one 300-call window 7 calls
  exceeded 100 ms (p99 161 ms, max 333 ms). Locally 500 ms is only 1.5x that
  maximum, so a longer stall still misses it: this narrows the flake, it does
  not remove it.

  That host had load average 25 on 24 cores. Issue #479's run on a 4-core
  host (2026-10-08) timed out 4 of 358 agents-channel calls at 100 ms under
  1-minute load about 14, and its uncensored run (budget 2000 ms, load about
  8) had a maximum of 73.8 ms over 471 calls. Load per core on the 4-core
  host was about 3.5, against about 1.04 on the 24-core host, so its tail
  may be longer than 333 ms. This is an inference; it was not measured.
  """
  def durable_reply(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def durable_reply(base) when is_integer(base) and base > 0 do
    @durable_reply_multiplier * base
  end

  @store_step_multiplier 20

  @doc """
  Budget for a wait on a DETS-backed store process, running in another
  process, to reach a step: opening its file and publishing at start, or the
  sync of a write that a spawned task called. #{@store_step_multiplier}x the
  base, so 2000 ms locally and 10000 ms under `CI`.

  The waiting test costs nothing when the step is quick, so the budget is
  sized against the tail under CPU starvation, not the median. Measured on the
  4-core shared host (2026-10-04) with 150 to 300 starts of an
  `AgentStatusLines` store on a 4-agent file, timed from the spawn to the first
  phase-C point:

  | load | p50 | p90 | max |
  |---|---|---|---|
  | idle (load average about 4) | 0 ms | 0 ms | 5 ms |
  | 8 busy loops | 128 ms | 190 ms | 244 ms |
  | 16 busy loops | 0 ms | 246 ms | 385 ms |

  Under load the default 100 ms was missed in most starts. 2000 ms is 5x the
  worst of those.
  """
  def store_step(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def store_step(base) when is_integer(base) and base > 0 do
    @store_step_multiplier * base
  end

  @doc """
  Budget for the wait between writing an allow-list file and the watcher's
  file event reaching the test (debounce, then reconcile, then broadcast).
  Two `out_of_band/0` budgets: 1000 ms locally and 5000 ms under `CI`.

  Two times the out_of_band budget, because the largest probe sample on a
  4-core host under load was 285 ms over 30 runs (issue 554). The rule is
  that the budget is at least twice the largest observed sample. In-process
  waits (`:DOWN` after `GenServer.stop/1`) stay on `out_of_band/0`.
  """
  def file_event(base \\ Application.fetch_env!(:ex_unit, :assert_receive_timeout))

  def file_event(base) when is_integer(base) and base > 0 do
    2 * out_of_band(base)
  end
end
