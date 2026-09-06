defmodule KaoiroServer.PermissionSettings.State do
  @moduledoc """
  Pure transition and projection functions for the per-agent entry shape
  `KaoiroServer.PermissionSettings` persists (issue #305, ADR-0033
  F3/F4, director round-2 correction 2026-09-06: "pure State module,
  GenServer does only I/O"). No GenServer, no DETS — every function here
  takes plain data in (`entry`, `sanitized` observation maps, `counter`)
  and returns plain data out. `PermissionSettings` itself decides ONLY
  which function to call and how to persist the result; it never decides
  WHAT the new state should be — that decision lives entirely here, so
  it can be read, tested, and reasoned about without any DETS or process
  concerns in the way.

  An `entry` is `%{engine, control, next, ledger}`:

  - `control` — the latest accepted request and its progress, shaped
    like `PermissionControlExt` (revision/requested/status/submitted/
    effective/last_effective/reason/rolled_back_to/constraints) plus
    `actor`/`at` for audit.
  - `next` — `%{revision, requested}`, what the wrapper should apply at
    its next execution.
  - `ledger` — `%{revision => %{requested, submitted, effective,
    prior_next}}` for every revision this agent has ever been submitted
    or seeded at. `prior_next` binds a request to the server-owned
    selection that was current when it was accepted.
  """

  @max_safe_integer 9_007_199_254_740_991
  @sandbox_values ~w(read-only workspace-write danger-full-access)
  @approval_values ~w(untrusted on-request on-failure never)
  @enforcement_values ~w(os mode advisory)
  @ledger_safety_cap 32

  # ---- submit ----------------------------------------------------------

  @doc """
  Merges `patch` into `entry.next.requested`, allocates the next
  revision (`counter + 1`), and returns the fully-updated entry — no
  persistence, no side effects. Returns `{:ok, new_revision, new_entry}`
  or `{:error, :revision_exhausted}` when `counter` is already at the
  safe-integer ceiling, or `{:error, :permission_not_ready}` when no
  launch baseline exists yet.
  """
  def submit(nil, _counter, _engine, _patch, _actor, _at), do: {:error, :permission_not_ready}

  def submit(entry, counter, engine, patch, actor, at) do
    if counter >= @max_safe_integer do
      {:error, :revision_exhausted}
    else
      new_revision = counter + 1
      requested = Map.merge(entry.next.requested, patch)

      # issue #305 M3(c), ふじ round 1 store-probe (SUCCESSOR_SUBMITTED):
      # a NEW request must not blindly wipe the outgoing revision's
      # in-flight submission — protocol.md: "the top-level request is
      # B/pending while submitted and a known effective may describe A"
      # (revision B arrives while A runs). Only `:applying` has anything
      # in-flight to carry forward; `:pending` (never captured by an
      # exec) has nothing, and a settled status (applied/failed/unknown)
      # is retained via `last_effective` already, not the top-level
      # submitted/effective slot.
      {submitted, effective} =
        if entry.control.status == :applying do
          {entry.control.submitted, entry.control.effective}
        else
          {nil, nil}
        end

      new_entry = %{
        entry
        | engine: engine,
          control: %{
            revision: new_revision,
            requested: requested,
            status: :pending,
            submitted: submitted,
            effective: effective,
            last_effective: entry.control.last_effective,
            reason: nil,
            rolled_back_to: nil,
            actor: actor,
            at: at,
            # Fixed per engine (protocol.md), not per-request: carried
            # forward unchanged from the prior control. seed/3 is the
            # only place a fresh value ever enters.
            constraints: entry.control.constraints
          },
          next: %{revision: new_revision, requested: requested},
          ledger:
            Map.put(entry.ledger, new_revision, %{
              requested: requested,
              submitted: nil,
              effective: nil,
              prior_next: entry.next
            })
      }

      {:ok, new_revision, prune_entry(new_entry)}
    end
  end

  # ---- observe -----------------------------------------------------------

  @doc """
  Applies a sanitized wrapper-reported `ext.permission_control` observation
  (see `sanitize_control/1`) to `entry` (`nil` when the agent has no
  settings yet). `counter` is the agent's revision high-water mark
  (survives `nil` entries — see `PermissionSettings` moduledoc). Returns:

  - `{:ok, new_entry}` — apply and persist this.
  - `{:reject, :unallocated_seed, revision, counter}` — a first-ever (or
    engine-changed) observation named a non-zero revision the counter
    never allocated (issue #305 M3(a)); nothing to persist.
  - `{:reject, :unknown_revision, revision, known}` — a revision beyond
    the entry's own current one (protocol.md: "The server owns revision
    allocation"); nothing to persist.
  - `:no_change` — a stale (already-superseded) observation that does
    not confirm an applied policy; nothing to persist, nothing to log.
  """
  def observe(nil, engine, sanitized, counter), do: seed(engine, sanitized, counter)

  def observe(%{engine: stored_engine} = _entry, engine, sanitized, counter)
      when stored_engine != engine do
    # protocol.md: "an engine change must not replay another engine's
    # settings" — reset control/next, keep the counter (this store's
    # own counter map is keyed by agent_id, untouched by seeding).
    seed(engine, sanitized, counter)
  end

  def observe(entry, _engine, sanitized, _counter) do
    cond do
      sanitized.revision == entry.control.revision ->
        {:ok, merge_current_revision(entry, sanitized)}

      sanitized.revision < entry.control.revision ->
        merge_stale_revision(entry, sanitized)

      true ->
        {:reject, :unknown_revision, sanitized.revision, entry.control.revision}
    end
  end

  defp seed(engine, sanitized, counter) do
    # issue #305 M3(a), ふじ round 1 store-probe (UNALLOCATED): a
    # first-ever observation reporting a non-zero revision the counter
    # never allocated must not seed a baseline there — the next
    # legitimate `submit/6` would allocate `counter + 1`, landing BELOW
    # this bogus baseline and being misread as stale by `observe/4`'s
    # own revision comparison. Revision 0 is always legitimate (the
    # launch baseline) even before any operator request, since the
    # counter starts at 0.
    if sanitized.revision != 0 and sanitized.revision > counter do
      {:reject, :unallocated_seed, sanitized.revision, counter}
    else
      entry = %{
        engine: engine,
        control: %{
          revision: sanitized.revision,
          requested: sanitized.requested,
          status: sanitized.status,
          submitted: sanitized.submitted,
          effective: sanitized.effective,
          last_effective: sanitized.effective || sanitized.last_effective,
          reason: sanitized.reason,
          rolled_back_to: sanitized.rolled_back_to,
          actor: nil,
          at: nil,
          constraints: sanitized.constraints
        },
        next: %{revision: sanitized.revision, requested: sanitized.requested},
        ledger: %{
          sanitized.revision => %{
            requested: sanitized.requested,
            submitted: sanitized.submitted,
            effective: sanitized.effective,
            prior_next: nil
          }
        }
      }

      {:ok, prune_entry(entry)}
    end
  end

  defp merge_current_revision(entry, sanitized) do
    sanitized = discard_unknown_effective(sanitized)
    mismatch? = sanitized.requested != entry.control.requested

    ledger =
      update_ledger_entry(
        entry.ledger,
        entry.control.revision,
        sanitized,
        if(mismatch?, do: entry.control.requested, else: sanitized.requested)
      )

    {control, next} =
      if mismatch? do
        mismatch_transition(entry, sanitized)
      else
        settled_transition(entry, sanitized, ledger)
      end

    prune_entry(%{entry | control: control, next: next, ledger: ledger})
  end

  defp discard_unknown_effective(%{status: :unknown} = sanitized),
    do: %{sanitized | effective: nil}

  defp discard_unknown_effective(sanitized), do: sanitized

  # A mismatch is failed rather than unknown because an unknown wire record
  # requires its submission pair to match the server request. It remains
  # blocked, but retains the server-selected next pair without rollback.
  defp mismatch_transition(entry, sanitized) do
    control = %{
      entry.control
      | status: :failed,
        submitted: sanitized.submitted,
        effective: sanitized.effective,
        reason: "policy_mismatch",
        rolled_back_to: nil
    }

    {control, entry.next}
  end

  # issue #305 M3(d), director round-2 correction 2026-09-06: a
  # pre-application rejection (`:failed` status with `rolled_back_to`
  # present, or with no `submitted` of its own — see
  # `fallback_to_predecessor/2`'s doc) rolls `next` back to the ledger's
  # own PRIOR selection — never to the wrapper-reported `rolled_back_to`
  # VALUE. The original ruling searched the ledger for an entry whose
  # `requested` matched the wrapper's claimed `rolled_back_to`; withdrawn
  # because the wrapper's claim is exactly as untrustworthy as any other
  # self-report, and protocol.md ("No automatic transition may widen
  # permissions") forbids promoting a wrapper-NAMED historical selection
  # into `next` — a forged `rolled_back_to` naming a WIDER selection that
  # genuinely existed somewhere in this agent's own history would
  # otherwise be accepted verbatim. `control.rolled_back_to` published
  # to clients/audit is likewise SERVER-derived from this same fallback,
  # never the wrapper's value (mirrors M6(b)'s `previous` — never relay a
  # wrapper-supplied audit claim unresolved).
  defp settled_transition(entry, sanitized, ledger) do
    # "Never submitted" must read the MERGED value, not `sanitized.submitted`
    # alone: a failure report legitimately omits `submitted` when a PRIOR
    # report already established it for this same revision (protocol.md
    # "Retain A's submission... until its outcome is handled" applies
    # within one revision too, not only across a superseding one) — using
    # only this report's own field would misclassify a genuine
    # post-application failure as pre-application.
    submitted = sanitized.submitted || entry.control.submitted

    pre_application_rejection? =
      sanitized.status == :failed and
        (sanitized.rolled_back_to != nil or submitted == nil)

    if pre_application_rejection? do
      fallback = fallback_to_prior_next(entry, ledger)

      control = %{
        entry.control
        | status: :failed,
          submitted: submitted,
          effective: nil,
          reason: sanitized.reason,
          rolled_back_to: fallback.requested
      }

      {control, fallback}
    else
      control = %{
        entry.control
        | status: sanitized.status,
          submitted: submitted,
          effective: sanitized.effective,
          last_effective: sanitized.effective || entry.control.last_effective,
          reason: sanitized.reason,
          rolled_back_to: nil
      }

      {control, entry.next}
    end
  end

  # A delayed observation for an already-superseded revision may still
  # be real evidence (protocol.md: "A delayed observation for a finished
  # execution may update historical evidence, never the current
  # execution's badge") — but only when it actually confirms an applied
  # policy. A stale failure has no current-state effect. Also refreshes
  # the ledger entry for `sanitized.revision` so a later rollback lookup
  # (M3(d)) resolves this revision's freshest known effective, not a
  # stale nil left over from when it was first submitted.
  defp merge_stale_revision(entry, sanitized) do
    if sanitized.status == :applied and sanitized.effective do
      control = %{entry.control | last_effective: sanitized.effective}
      ledger = update_ledger_entry(entry.ledger, sanitized.revision, sanitized)
      {:ok, prune_entry(%{entry | control: control, ledger: ledger})}
    else
      :no_change
    end
  end

  defp update_ledger_entry(ledger, revision, sanitized) do
    update_ledger_entry(ledger, revision, sanitized, sanitized.requested)
  end

  defp update_ledger_entry(ledger, revision, sanitized, requested) do
    Map.update(
      ledger,
      revision,
      %{
        requested: requested,
        submitted: sanitized.submitted,
        effective: sanitized.effective,
        prior_next: nil
      },
      fn stored ->
        %{
          stored
          | requested: requested,
            submitted: sanitized.submitted || stored.submitted,
            effective: sanitized.effective || stored.effective
        }
      end
    )
  end

  # A rejection falls back to the selection that was current when this
  # revision was accepted. A numerically older ledger row may itself have
  # been rejected, so revision order is not a safe recovery rule.
  defp fallback_to_prior_next(entry, ledger) do
    case Map.get(ledger, entry.control.revision) do
      %{prior_next: %{revision: revision, requested: requested}} ->
        %{revision: revision, requested: requested}

      _legacy_entry_without_prior_next ->
        entry.next
    end
  end

  # ---- ledger pruning ----------------------------------------------------

  defp prune_entry(entry), do: %{entry | ledger: prune_ledger(entry.ledger, entry)}

  @doc """
  Bounds ledger growth (issue #305 M3, director ruling 2026-09-06).
  Retains only entries a live lookup can still need — the current
  `control`/`next` revisions, an unresolved control's `prior_next`, and
  `last_effective`'s own revision, if present — plus a safety cap
  (`#{@ledger_safety_cap}`); older entries beyond the cap are pruned
  OLDEST first. `resolve_permission_previous/2`'s own contract
  (`wrapper_channel.ex`): `previous` resolves only within whatever the
  ledger still holds — a revision pruned away resolves to an earlier
  surviving one, or `nil`, never an error.
  """
  def prune_ledger(ledger, entry) do
    if map_size(ledger) <= @ledger_safety_cap do
      ledger
    else
      prune_to_cap(ledger, protected_revisions(entry), @ledger_safety_cap)
    end
  end

  defp protected_revisions(entry) do
    base = MapSet.new([entry.control.revision, entry.next.revision])

    base =
      if entry.control.status in [:pending, :applying, :unknown] do
        case Map.get(entry.ledger, entry.control.revision) do
          %{prior_next: %{revision: revision}} -> MapSet.put(base, revision)
          _ -> base
        end
      else
        base
      end

    case entry.control.last_effective do
      %{"revision" => revision} -> MapSet.put(base, revision)
      _ -> base
    end
  end

  defp prune_to_cap(ledger, protected, cap) do
    if map_size(ledger) <= cap do
      ledger
    else
      droppable =
        ledger
        |> Map.keys()
        |> Enum.reject(&MapSet.member?(protected, &1))
        |> Enum.sort()

      case droppable do
        [oldest | _] -> prune_to_cap(Map.delete(ledger, oldest), protected, cap)
        # Every remaining entry is protected; cannot shrink further.
        [] -> ledger
      end
    end
  end

  # ---- read-time defense (M-A) -------------------------------------------

  @doc """
  Sanitizes an entry loaded from DETS: defaults a missing `:ledger` key and
  rejects a legacy `client_socket:` fingerprint-prefixed `control.actor.id`
  back to `nil` (issue #305 M-A, クロエ round 2 / director round-2 correction
  2026-09-06 — the same read-path rejection `session_lifecycle_events.ex`
  applies to `actor.id`; `control.actor` is not itself wire-exposed today,
  but nothing structurally prevents a future reader from doing so).
  """
  def sanitize_loaded_entry(entry) do
    entry
    |> Map.put_new(:ledger, %{})
    |> sanitize_loaded_actor()
  end

  defp sanitize_loaded_actor(%{control: %{actor: %{"id" => id}}} = entry)
       when is_binary(id) do
    if String.starts_with?(id, "client_socket:") do
      put_in(entry, [:control, :actor], nil)
    else
      entry
    end
  end

  defp sanitize_loaded_actor(entry), do: entry

  # ---- projection (M1) ----------------------------------------------------

  @doc """
  Projects a stored entry into the `{control, next}` pair a `permission_sync`
  join push sends (protocol.md, "Persistence, join synchronization, and
  resume"). `nil` in, `{nil, nil}` out.

  Applied ONLY at join time, unconditionally (not gated on "did the
  server actually restart" — that distinction is not reliably observable
  from a loaded entry, and the same caution applies to a same-process
  rejoin, protocol.md: "A same-process rejoin must not turn a cached
  observation into a fresh application"). `applying` and `applied` round
  to `pending`: a join is a readiness barrier, not a fresh reconfirmation
  of a previous connection's observation. Presenting a stale `applied` as
  still current would also make a wrapper's own
  audit dedupe (keyed off a fresh `applied` transition) re-fire for a
  status it never freshly re-observed on THIS connection. `submitted`/
  `effective` are dropped on rounding — presenting them next to a
  rounded-down `pending` status would contradict it — but `last_effective`
  always survives the rounding (seeded from `effective` when the stored
  status was `applied`) so historical evidence is never lost. `unknown`
  remains blocked across a join; it retains its `submitted` and `reason`,
  while current `effective` and `rolled_back_to` remain absent. `failed`
  is never rounded: its `reason`/`rolled_back_to` are exactly what the
  operator needs to see, unchanged, on every rejoin.
  """
  def sync_view(nil), do: {nil, nil}

  def sync_view(%{control: control, next: next}) do
    rounded =
      if control.status in [:applying, :applied] do
        %{control | status: :pending, submitted: nil, effective: nil}
      else
        control
      end

    projected =
      if rounded.status == :unknown do
        %{rounded | effective: nil, rolled_back_to: nil}
      else
        rounded
      end

    {control_wire(projected), next}
  end

  @doc """
  Wire-shapes an internal atom-keyed `control` record into the
  string-keyed `PermissionControlExt` shape the wire protocol uses.
  Optional fields absent from `control` are OMITTED, never emitted as an
  explicit `null` (issue #305 M1, ふじ round 1: the real C `ServerLink`
  parser rejects `permission_sync` for `baseline`/`pending`/`applying`/
  `unknown` states once an optional field is present as literal `null`
  instead of simply absent — measured against the real C build). The
  top-level `{control: null, next: null}` explicit-empty-sync case
  (`sync_view/1`'s `nil` clause above) is unaffected by this function —
  that pair stays literal `null` by director/ふじ ruling, since it means
  something different ("no saved settings") from an omitted optional
  field inside a real control. `submitted`/`effective`/`last_effective`
  are kept opaque (relayed verbatim), matching `sanitize_control/1`'s own
  stance on the read side: they are never re-typed field by field.
  """
  def control_wire(control) do
    %{
      "revision" => control.revision,
      "requested" => permission_pair_wire(control.requested),
      "status" => Atom.to_string(control.status),
      "constraints" => %{
        "approval" => control.constraints.approval,
        "enforcement" => control.constraints.enforcement
      }
    }
    |> maybe_put_wire("submitted", control.submitted)
    |> maybe_put_wire("effective", control.effective)
    |> maybe_put_wire("last_effective", control.last_effective)
    |> maybe_put_wire("reason", control.reason)
    |> maybe_put_wire("rolled_back_to", permission_pair_wire(control.rolled_back_to))
  end

  defp permission_pair_wire(nil), do: nil

  defp permission_pair_wire(%{sandbox: sandbox, network_access: network_access}),
    do: %{"sandbox" => sandbox, "network_access" => network_access}

  defp maybe_put_wire(map, _key, nil), do: map
  defp maybe_put_wire(map, key, value), do: Map.put(map, key, value)

  # ---- wire shape validation ------------------------------------------

  @doc """
  Defensive, fail-soft sanitizer for the wrapper-reported
  `ext.permission_control` map (string keys, as received off the
  wire). Mirrors SessionPointers.sanitize_snapshot's stance: unknown or
  malformed input is dropped, never trusted past a shape+enum check.
  Nested submission/observation maps are kept opaque (not re-typed
  field by field) — they are relayed back out verbatim to clients and
  audit, and over-narrowing them here would silently drop legitimate
  engine-observed fields (session_id, turn_id, execution_id, ...).
  Returns `nil` on any malformed shape.
  """
  def sanitize_control(
        %{
          "revision" => revision,
          "requested" => %{"sandbox" => sandbox, "network_access" => network_access},
          "status" => status,
          "constraints" => %{"approval" => approval, "enforcement" => enforcement}
        } = raw
      )
      when is_integer(revision) and revision >= 0 and
             sandbox in @sandbox_values and is_boolean(network_access) and
             approval in @approval_values and enforcement in @enforcement_values do
    with {:ok, status_atom} <- sanitize_status(status) do
      %{
        revision: revision,
        requested: %{sandbox: sandbox, network_access: network_access},
        status: status_atom,
        constraints: %{approval: approval, enforcement: enforcement},
        submitted: Map.get(raw, "submitted"),
        effective: Map.get(raw, "effective"),
        last_effective: Map.get(raw, "last_effective"),
        reason: sanitize_string(Map.get(raw, "reason")),
        rolled_back_to: sanitize_rolled_back_to(Map.get(raw, "rolled_back_to"))
      }
    else
      _ -> nil
    end
  end

  def sanitize_control(_other), do: nil

  @control_statuses ~w(pending applying applied failed unknown)
  defp sanitize_status(status) when status in @control_statuses,
    do: {:ok, String.to_existing_atom(status)}

  defp sanitize_status(_other), do: :error

  defp sanitize_string(value) when is_binary(value), do: value
  defp sanitize_string(_other), do: nil

  defp sanitize_rolled_back_to(%{"sandbox" => sandbox, "network_access" => network_access})
       when sandbox in @sandbox_values and is_boolean(network_access) do
    %{sandbox: sandbox, network_access: network_access}
  end

  defp sanitize_rolled_back_to(_other), do: nil

  # ---- audit ledger check --------------------------------------------

  @doc """
  `true` when `revision` is within `counter`'s allocated range: 0 (the
  launch baseline, always legitimate even before any operator request)
  or at most `counter` itself. See `PermissionSettings.known_revision?/3`
  for why this checks the COUNTER, not the current `control.revision`.
  """
  def known_revision?(counter, revision), do: revision <= counter
end
