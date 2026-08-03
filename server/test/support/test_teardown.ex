defmodule KaoiroServer.TestTeardown do
  @moduledoc """
  Stops the isolated GenServer a store test started, absorbing only the
  benign end-of-test race (#171). Test-only — `test/support` is compiled
  in `:test` alone.

  ## The race

  Store tests start their GenServer with `start_link` from `setup`, so it
  is linked to the test process, and none of the stores traps exits.
  ExUnit ends a case by sending `:test_finished` and then
  `exit(:shutdown)` on the test process, without waiting for it to die;
  `on_exit` callbacks run concurrently in a process of their own. So the
  store can die from the link signal at any point while `on_exit` is
  stopping it, and teardown fails on its own even though the test body
  passed.

  ## What is absorbed, and what is not

  ふじ first observed the flake on 2026-07-23 (4th review, advisory 3);
  #169 cushioned it with a blanket `catch :exit, _ -> :ok`, which also
  swallowed genuine teardown regressions — a crash in `terminate/2`, a
  brutal kill, a call timing out inside `terminate/2` (ふじ 2026-07-28
  advisory 3). `stop_quietly/1` narrows the cushion to the reasons that
  mean "the store died on its own, the way ExUnit kills it":

    * `:noproc` — the store was ALREADY dead when a monitor was set up
      (`:proc_lib.stop/3`'s own monitor, or `:gen`'s inside
      `:sys.terminate/3`).
    * `:shutdown` — the store was still alive at that point and the
      queued link signal killed it a moment later, so the DOWN carries
      its real exit reason. `terminate/2` closes DETS, which is a call
      into another process, so this window spans the whole close rather
      than a couple of microseconds.

  Everything else still fails teardown, which is the point: a
  `terminate/2` that raises, `:killed` (something brutal-killed the
  store), and a `:timeout` bubbling out of `terminate/2` (a call in there
  that never answered) all reach the caller.

  Two limits on that, both inherent to judging by exit reason alone:

    * A `terminate/2` that EXITS `:shutdown` itself produces
      `{:shutdown, {GenServer, :stop, _}}` — the very envelope the benign
      link race produces — so the two cannot be told apart and such a
      crash is absorbed (ふじ 2026-08-03, S1). No store has such a
      callback today: eight close DETS, `SessionResets` defines none, so
      nothing is hidden in practice. Separating them would need evidence
      beyond the reason, e.g. a monitor established before the stop.
    * A store that had already vanished before `whereis_alive/1` looked
      is skipped without being stopped, and its original exit reason is
      not recoverable from here — so a brutal kill that landed that early
      goes unnoticed. Catching that would need a monitor installed back
      at `start_link` time, which #171 does not attempt.

  `stop_quietly/1` keeps `GenServer.stop/1`'s default `:infinity` on
  purpose, so a `terminate/2` that never returns surfaces as ExUnit's own
  `on_exit` timeout rather than as a `{:timeout, {GenServer, :stop, _}}`
  exit — that shape exists only when a finite timeout is passed. Do not
  add one to obtain it: `:proc_lib.stop/3` derives its remaining wait as
  `Timeout - elapsed_ms`, which goes negative under load and raises
  `ErlangError :timeout_value` instead of exiting (measured on stdlib
  8.0.1).

  ## Recognised envelopes (fail-closed)

  `GenServer.stop/3` exits `{reason, {GenServer, :stop, args}}`, wrapping
  whatever `:proc_lib.stop/3` gave it. `benign_teardown_exit?/1` accepts
  exactly these three envelopes, each measured on OTP 29.0.2 /
  stdlib 8.0.1:

      {:noproc,   {GenServer, :stop, _}}
      {:shutdown, {GenServer, :stop, _}}
      {{:shutdown, {:sys, :terminate, _}}, {GenServer, :stop, _}}

  The first covers the store already being gone; the second, the link
  signal landing while `:proc_lib.stop/3` waits; the third, the signal
  landing before the store has handled the `terminate` system message,
  so `:gen`'s monitor fires inside `:sys.terminate/3` and that frame
  stays on the reason.

  There is deliberately no `{{:noproc, {:sys, :terminate, _}}, ...}`
  entry, even though it looks like the symmetric counterpart.
  `:proc_lib.stop/3` catches `exit:{noproc, {sys, terminate, _}}` in its
  FIRST clause and re-exits a bare `noproc`, so a `:noproc` that reached
  the caller through `:sys.terminate/3` never keeps that frame — measured:
  `:sys.terminate(dead, …)` exits `{:noproc, {:sys, :terminate, _}}` but
  `:proc_lib.stop(dead, …)` exits plain `:noproc`. The only way that
  shape can arrive is the store's OWN `terminate/2` calling
  `:sys.terminate/3` on something already dead — a real defect, and one
  this list must reject.

  The list is closed on purpose: the PATH to the leaf matters as much as
  the leaf. An earlier version unwrapped any `{reason, mfa}` layer, which
  made a real `terminate/2` crash look benign — a store whose
  `terminate/2` calls a dependency that is already gone exits

      {{:noproc, {GenServer, :call, [_dep, _msg, _timeout]}},
       {GenServer, :stop, _}}

  and generic unwrapping walked down to that unrelated inner `:noproc`
  and absorbed it (ふじ, reproduced here on OTP 29.0.2).

  Anything outside the list fails teardown loudly, a shape some future
  OTP introduces included. That is the intended trade: an OTP change
  shows up as a visible teardown failure, and the fix is to measure the
  new shape, pin it with a test, and extend this list — never to loosen
  the match.
  """

  # Leaf reasons that mean the store died the way ExUnit kills it.
  # Deliberately excludes :killed and :timeout — see @moduledoc.
  @benign_leaf ~w(noproc shutdown)a

  @doc """
  Stops `server` (a pid or a locally registered name), absorbing only a
  benign end-of-test exit. Any other exit is re-raised so teardown fails
  and the regression stays visible.
  """
  @spec stop_quietly(pid() | atom()) :: :ok
  def stop_quietly(server) do
    if pid = whereis_alive(server) do
      try do
        GenServer.stop(pid)
      catch
        :exit, reason ->
          if benign_teardown_exit?(reason), do: :ok, else: exit(reason)
      end
    end

    :ok
  end

  @doc """
  True when `reason` is one of the three recognised benign envelopes
  listed in the `@moduledoc`, and only those.

  The match is fail-closed: an unrecognised shape — including a benign
  leaf reached through some other wrapper — is rejected, so teardown
  fails loudly instead of silently accepting something never measured.
  """
  @spec benign_teardown_exit?(term()) :: boolean()
  def benign_teardown_exit?({inner, {GenServer, :stop, args}}) when is_list(args),
    do: benign_stop_inner?(inner)

  def benign_teardown_exit?(_reason), do: false

  # What `:proc_lib.stop/3` handed to `GenServer.stop/3`: either the leaf
  # reason itself, or `:shutdown` still wearing its `:sys.terminate/3`
  # frame. `:noproc` never keeps that frame (proc_lib collapses it — see
  # @moduledoc), so accepting it there would absorb a real defect.
  defp benign_stop_inner?(leaf) when leaf in @benign_leaf, do: true

  defp benign_stop_inner?({:shutdown, {:sys, :terminate, args}}) when is_list(args),
    do: true

  defp benign_stop_inner?(_inner), do: false

  # `Process.alive?/1` rejects a name and `Process.whereis/1` rejects a
  # pid, so the two call-site variants the 9 store tests used are folded
  # here. Anything else raises rather than silently skipping the stop.
  defp whereis_alive(server) when is_pid(server) do
    if Process.alive?(server), do: server
  end

  defp whereis_alive(server) when is_atom(server), do: Process.whereis(server)
end
