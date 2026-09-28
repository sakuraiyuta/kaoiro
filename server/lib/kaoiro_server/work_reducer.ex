defmodule KaoiroServer.WorkReducer do
  @moduledoc false

  @terminal ~w(completed cancelled declined expired)
  @revision_ops ~w(revise hold release accept_verdict revoke_verdict complete cancel transfer release_transfer)

  def reduce(works, principal, %{"op" => "assign"} = op, context, config) do
    recipient = context[:recipient]
    operator? = principal["kind"] == "user"
    assignee = if operator?, do: op["assignee"], else: recipient
    director = if operator?, do: op["director"], else: principal
    title = op["title"]
    scopes = op["resource_scope"] || []

    with :ok <- valid_title(title),
         :ok <- valid_scopes(scopes),
         :ok <- valid_agent(assignee),
         :ok <- valid_principal(director),
         :ok <- check_capacity(works, principal, assignee, config, operator?),
         :ok <- assign_link_available(works, context),
         :ok <- global_receipt_capacity(works, principal, config),
         :ok <- review_authority(works, principal, op["reviews"]) do
      id = random_id("wrk_")
      now = timestamp()
      state = if operator?, do: "active", else: "nominated"

      origin =
        if operator?,
          do: nil,
          else: %{conversation_id: context[:conversation_id], turn_number: context[:turn_number]}

      work = %{
        work_id: id,
        title: title,
        origin: origin,
        reviews: op["reviews"],
        director: director,
        assignee: %{"kind" => "agent", "id" => assignee},
        resource_scope: scopes,
        requires_verdict: op["requires_verdict"] != false,
        state: state,
        revision: if(operator?, do: 1, else: 0),
        authority_epoch: 1,
        transfers: [],
        subject: nil,
        holds: [],
        verdicts: [],
        accepted_verdicts: [],
        links: if(origin, do: [origin.conversation_id], else: []),
        receipts: [],
        checks: [],
        created_at: now,
        updated_at: now
      }

      result = %{
        op: "assign",
        operation_id: op["operation_id"],
        outcome: "applied",
        work: stamp(work)
      }

      {:ok, Map.put(works, id, work), id, result}
    end
  end

  def reduce(works, principal, %{"op" => name, "work_id" => id} = op, context, config) do
    with %{state: state} = work <- works[id] || {:error, :unknown_work},
         :ok <- carriage(works, work, principal, context),
         :ok <- actor(work, principal, name),
         :ok <- revision(work, op, name),
         :ok <- state_precondition(work, name, state),
         :ok <- receipt_capacity(works, work, principal, config),
         {:ok, next_works, result_work, extras} <- apply_op(works, work, principal, op, config) do
      {next_works, result_work} = maybe_link_new_conversation(next_works, result_work, context)

      result = %{
        op: name,
        operation_id: op["operation_id"],
        outcome: "applied",
        work: stamp(result_work)
      }

      result = Map.merge(result, extras)
      {:ok, next_works, id, result}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :unknown_work}
    end
  end

  def reduce(_, _, _, _, _), do: {:error, :work_state_conflict}

  def status(works, principal, nil) do
    mine =
      for {_id, work} <- works,
          work.state not in @terminal,
          principal == work.director or principal == work.assignee,
          do: work

    pending =
      for {_id, work} <- works,
          transfer <- work.transfers,
          transfer.state == "pending" and transfer.old_assignee == principal,
          do: Map.put(transfer, :work_id, work.work_id)

    {:ok, %{works: mine, pending_transfers: pending}}
  end

  def status(works, principal, id) do
    case works[id] do
      nil ->
        {:error, :unknown_work}

      work ->
        cond do
          principal["kind"] == "user" or principal == work.director or principal == work.assignee or
              reviewer_of?(works, principal, id) ->
            {:ok, %{work: work}}

          true ->
            pending =
              for transfer <- work.transfers,
                  transfer.state == "pending" and transfer.old_assignee == principal,
                  do: Map.put(transfer, :work_id, id)

            if pending == [],
              do: {:error, :unknown_work},
              else: {:ok, %{work_id: id, access: "transfer_pending", pending_transfers: pending}}
        end
    end
  end

  def check(works, principal, %{"work_id" => id} = request) do
    case works[id] do
      nil ->
        {:error, :unknown_work}

      work ->
        if principal != work.assignee do
          {:error, :work_not_authorized}
        else
          action = request["action"]

          reason =
            cond do
              work.state != "active" ->
                :work_state_conflict

              principal != work.assignee ->
                :work_not_authorized

              request["expected_revision"] != work.revision ->
                :stale_work_revision

              Enum.any?(work.transfers, &(&1.state == "pending")) ->
                :transfer_pending

              work.holds != [] ->
                :work_state_conflict

              action == "land" and work.subject == nil ->
                :subject_mismatch

              action == "land" and request["subject_hash"] != work.subject.hash ->
                :subject_mismatch

              action == "land" and work.requires_verdict and not effective_verdict?(works, work) ->
                :verdict_not_effective

              action not in ~w(start land) ->
                :work_state_conflict

              true ->
                nil
            end

          at = timestamp()

          audit = %{
            principal: principal,
            action: action,
            revision: work.revision,
            subject_hash: request["subject_hash"],
            result: reason || "ok",
            at: at,
            target: request["target"]
          }

          cap = config()[:work_checks_per_work]
          next = %{work | checks: Enum.take([audit | work.checks], cap)}

          result =
            if reason, do: %{ok: false, reason: reason, work: next}, else: %{ok: true, work: next}

          {:ok, id, next, result}
        end
    end
  end

  def check(_, _, _), do: {:error, :unknown_work}

  def transfer_ack(works, principal, id, transfer_id) do
    case works[id] do
      nil ->
        {:error, :unknown_work}

      work ->
        case Enum.find(work.transfers, &(&1.transfer_id == transfer_id)) do
          %{state: "pending", old_assignee: ^principal} ->
            transfers =
              Enum.map(work.transfers, fn t ->
                if t.transfer_id == transfer_id, do: %{t | state: "acknowledged"}, else: t
              end)

            {:ok, %{work | transfers: transfers, updated_at: timestamp()}}

          _ ->
            {:error, :work_not_authorized}
        end
    end
  end

  defp apply_op(works, work, _principal, %{"op" => "accept_assignment"}, config) do
    active =
      Enum.count(works, fn {_, candidate} ->
        candidate.state == "active" and candidate.assignee == work.assignee
      end)

    if active >= config[:work_active_per_assignee],
      do: {:error, :work_capacity},
      else: updated(work, works, %{state: "active", revision: 1})
  end

  defp apply_op(works, work, _principal, %{"op" => "decline"}, _config) do
    updated(work, works, %{state: "declined"})
  end

  defp apply_op(works, work, _principal, %{"op" => "revise"}, _config) do
    updated(work, works, %{revision: work.revision + 1, verdicts: invalidate(work.verdicts)})
  end

  defp apply_op(works, work, _principal, %{"op" => "hold", "reason" => reason}, config)
       when is_binary(reason) and reason != "" do
    if length(work.holds) >= config[:work_pending_transfers] * 2 do
      {:error, :work_capacity}
    else
      hold = %{hold_id: random_id("hold_"), reason: reason, set_at_revision: work.revision + 1}

      updated(work, works, %{
        revision: work.revision + 1,
        holds: [hold | work.holds],
        verdicts: invalidate(work.verdicts)
      })
    end
  end

  defp apply_op(works, work, _principal, %{"op" => "release", "hold_id" => id} = op, _config) do
    cond do
      not Enum.any?(work.holds, &(&1.hold_id == id)) ->
        {:error, :work_state_conflict}

      subject_hash(work) != op["subject_hash"] ->
        {:error, :subject_mismatch}

      true ->
        updated(work, works, %{
          revision: work.revision + 1,
          holds: Enum.reject(work.holds, &(&1.hold_id == id)),
          verdicts: invalidate(work.verdicts)
        })
    end
  end

  defp apply_op(
         works,
         work,
         _principal,
         %{"op" => "submit", "subject" => %{"hash" => hash, "label" => label}},
         _config
       )
       when is_binary(hash) and hash != "" and is_binary(label) and label != "" do
    seq = if work.subject, do: work.subject.seq + 1, else: 1

    refs =
      Enum.map(work.accepted_verdicts, fn ref ->
        if ref.subject_hash != hash, do: Map.put(ref, :void, "subject_changed"), else: ref
      end)

    updated(work, works, %{
      subject: %{hash: hash, label: label, seq: seq},
      accepted_verdicts: refs
    })
  end

  defp apply_op(
         works,
         work,
         principal,
         %{
           "op" => "verdict",
           "subject" => %{"work_id" => target, "hash" => hash},
           "outcome" => outcome
         },
         config
       )
       when outcome in ~w(approve request_changes reject) do
    cond do
      work.reviews != target ->
        {:error, :work_state_conflict}

      length(work.verdicts) >= config[:work_verdicts_per_work] ->
        {:error, :work_capacity}

      true ->
        verdict = %{
          verdict_id: random_id("vrd_"),
          author: principal,
          subject: %{work_id: target, hash: hash},
          outcome: outcome,
          basis_revision: work.revision,
          state: "recorded"
        }

        previous =
          Enum.map(work.verdicts, fn v ->
            if v.author == principal and v.state == "recorded",
              do: %{v | state: "superseded"},
              else: v
          end)

        updated(work, works, %{verdicts: [verdict | previous]})
    end
  end

  defp apply_op(
         works,
         work,
         principal,
         %{"op" => "withdraw_verdict", "verdict_id" => id},
         _config
       ) do
    case Enum.find(work.verdicts, &(&1.verdict_id == id)) do
      %{author: ^principal, state: "recorded"} ->
        updated(work, works, %{
          verdicts:
            Enum.map(work.verdicts, fn v ->
              if v.verdict_id == id, do: %{v | state: "withdrawn"}, else: v
            end)
        })

      _ ->
        {:error, :work_state_conflict}
    end
  end

  defp apply_op(
         works,
         work,
         _principal,
         %{
           "op" => "accept_verdict",
           "verdict_ref" => %{"work_id" => review_id, "verdict_id" => verdict_id},
           "subject_hash" => hash
         },
         config
       ) do
    review = works[review_id]
    verdict = if review, do: Enum.find(review.verdicts, &(&1.verdict_id == verdict_id))

    cond do
      review == nil or review.reviews != work.work_id ->
        {:error, :work_state_conflict}

      verdict == nil or verdict.state != "recorded" or verdict.outcome != "approve" ->
        {:error, :work_state_conflict}

      subject_hash(work) != hash or verdict.subject.hash != hash ->
        {:error, :subject_mismatch}

      length(work.accepted_verdicts) >= config[:work_accepted_verdicts_per_work] ->
        {:error, :work_capacity}

      true ->
        ref = %{
          verdict_ref: %{work_id: review_id, verdict_id: verdict_id},
          subject_hash: hash,
          at_revision: work.revision + 1
        }

        updated(work, works, %{
          revision: work.revision + 1,
          accepted_verdicts: [ref | work.accepted_verdicts]
        })
    end
  end

  defp apply_op(
         works,
         work,
         _principal,
         %{"op" => "revoke_verdict", "verdict_ref" => ref},
         _config
       ) do
    next = Enum.reject(work.accepted_verdicts, &(&1.verdict_ref == ref))

    if next == work.accepted_verdicts,
      do: {:error, :work_state_conflict},
      else: updated(work, works, %{revision: work.revision + 1, accepted_verdicts: next})
  end

  defp apply_op(works, work, _principal, %{"op" => "complete", "subject_hash" => hash}, _config) do
    cond do
      work.subject == nil or not is_binary(hash) or hash == "" ->
        {:error, :subject_mismatch}

      subject_hash(work) != hash ->
        {:error, :subject_mismatch}

      work.holds != [] ->
        {:error, :work_state_conflict}

      Enum.any?(work.transfers, &(&1.state == "pending")) ->
        {:error, :transfer_pending}

      work.requires_verdict and not effective_verdict?(works, work) ->
        {:error, :verdict_not_effective}

      true ->
        updated(work, works, %{state: "completed", revision: work.revision + 1})
    end
  end

  defp apply_op(works, work, _principal, %{"op" => "cancel"}, _config) do
    updated(work, works, %{
      state: "cancelled",
      revision: work.revision + 1,
      verdicts: invalidate(work.verdicts)
    })
  end

  defp apply_op(works, work, _principal, %{"op" => "transfer"} = op, config) do
    director = op["director"] || work.director

    assignee =
      if op["assignee"], do: %{"kind" => "agent", "id" => op["assignee"]}, else: work.assignee

    changed_writer? = assignee != work.assignee

    cond do
      director == work.director and not changed_writer? ->
        {:error, :work_state_conflict}

      changed_writer? and
          Enum.count(work.transfers, &(&1.state == "pending")) >= config[:work_pending_transfers] ->
        {:error, :work_capacity}

      true ->
        epoch = work.authority_epoch + 1

        transfers =
          if changed_writer?,
            do: [
              %{
                transfer_id: random_id("trf_"),
                epoch: epoch,
                old_assignee: work.assignee,
                new_assignee: assignee,
                state: "pending"
              }
              | work.transfers
            ],
            else: work.transfers

        updated(work, works, %{
          director: director,
          assignee: assignee,
          transfers: transfers,
          authority_epoch: epoch,
          revision: work.revision + 1
        })
    end
  end

  defp apply_op(
         works,
         work,
         _principal,
         %{"op" => "release_transfer", "transfer_id" => id},
         _config
       ) do
    if Enum.any?(work.transfers, &(&1.transfer_id == id and &1.state == "pending")) do
      updated(work, works, %{
        revision: work.revision + 1,
        transfers:
          Enum.map(work.transfers, fn t ->
            if t.transfer_id == id, do: %{t | state: "overridden"}, else: t
          end)
      })
    else
      {:error, :work_state_conflict}
    end
  end

  defp apply_op(_, _, _, _, _), do: {:error, :work_state_conflict}

  defp updated(work, works, changes) do
    next = work |> Map.merge(changes) |> Map.put(:updated_at, timestamp())
    {:ok, Map.put(works, work.work_id, next), next, %{}}
  end

  defp actor(work, principal, name) do
    cond do
      name in ~w(accept_assignment decline submit verdict withdraw_verdict) and
          principal == work.assignee ->
        :ok

      name in ~w(transfer release_transfer) and principal["kind"] == "user" ->
        :ok

      name in ~w(revise hold release accept_verdict revoke_verdict complete cancel) and
          (principal == work.director or principal["kind"] == "user") ->
        :ok

      true ->
        {:error, :work_not_authorized}
    end
  end

  defp carriage(_works, _work, _principal, %{operator: true}), do: :ok

  defp carriage(works, work, principal, context) do
    cid = context[:conversation_id]
    recipient = context[:recipient]

    counterpart =
      if principal == work.director, do: work.assignee["id"], else: work.director["id"]

    linked_elsewhere? =
      Enum.any?(works, fn {id, other} -> id != work.work_id and cid in other.links end)

    linked? = cid in work.links or context[:new_conversation?] == true

    if linked? and not linked_elsewhere? and recipient == counterpart,
      do: :ok,
      else: {:error, :work_carriage_invalid}
  end

  defp assign_link_available(_works, %{operator: true}), do: :ok

  defp assign_link_available(works, %{conversation_id: cid}) do
    if Enum.any?(works, fn {_id, work} -> cid in work.links end),
      do: {:error, :work_link_conflict},
      else: :ok
  end

  defp maybe_link_new_conversation(works, work, %{operator: true}), do: {works, work}

  defp maybe_link_new_conversation(works, work, %{new_conversation?: true, conversation_id: cid}) do
    linked = %{work | links: Enum.uniq([cid | work.links])}
    {Map.put(works, work.work_id, linked), linked}
  end

  defp maybe_link_new_conversation(works, work, _), do: {works, work}

  defp revision(work, op, name) do
    cond do
      name in @revision_ops and op["expected_revision"] != work.revision ->
        {:error, :stale_work_revision}

      name in ~w(submit verdict) and op["basis_revision"] != work.revision ->
        {:error, :stale_work_revision}

      true ->
        :ok
    end
  end

  defp state_precondition(_work, name, state) when name in ~w(accept_assignment decline) do
    if state == "nominated", do: :ok, else: {:error, :work_state_conflict}
  end

  defp state_precondition(_work, name, state) when name in ~w(transfer cancel) do
    if state in @terminal, do: {:error, :work_state_conflict}, else: :ok
  end

  defp state_precondition(_work, _name, "active"), do: :ok
  defp state_precondition(_, _, _), do: {:error, :work_state_conflict}

  defp receipt_capacity(works, work, principal, config) do
    per_work = Enum.count(work.receipts, &(&1.principal == principal))

    total =
      Enum.reduce(works, 0, fn {_, w}, acc ->
        acc + Enum.count(w.receipts, &(&1.principal == principal))
      end)

    if per_work >= config[:work_receipts_per_work_principal] or
         total >= config[:work_receipts_per_principal], do: {:error, :work_capacity}, else: :ok
  end

  defp global_receipt_capacity(works, principal, config) do
    total =
      Enum.reduce(works, 0, fn {_, work}, count ->
        count + Enum.count(work.receipts, &(&1.principal == principal))
      end)

    if total >= config[:work_receipts_per_principal], do: {:error, :work_capacity}, else: :ok
  end

  defp check_capacity(works, principal, assignee, config, operator?) do
    active =
      Enum.count(works, fn {_, w} -> w.state == "active" and w.assignee["id"] == assignee end)

    nominated_by =
      Enum.count(works, fn {_, w} -> w.state == "nominated" and w.director == principal end)

    nominated_to =
      Enum.count(works, fn {_, w} -> w.state == "nominated" and w.assignee["id"] == assignee end)

    cond do
      map_size(works) >= config[:work_max_records] ->
        {:error, :work_capacity}

      operator? and active >= config[:work_active_per_assignee] ->
        {:error, :work_capacity}

      not operator? and
          (nominated_by >= config[:work_nominated_per_principal] or
             nominated_to >= config[:work_nominated_per_principal]) ->
        {:error, :work_capacity}

      true ->
        :ok
    end
  end

  defp review_authority(_works, _principal, nil), do: :ok

  defp review_authority(works, principal, id) do
    case works[id] do
      %{director: ^principal} -> :ok
      %{} -> if(principal["kind"] == "user", do: :ok, else: {:error, :work_not_authorized})
      _ -> {:error, :work_not_authorized}
    end
  end

  defp valid_title(value) when is_binary(value) and byte_size(value) in 1..256, do: :ok
  defp valid_title(_), do: {:error, :work_state_conflict}

  defp valid_scopes(values) when is_list(values) and length(values) <= 16 do
    if Enum.all?(values, &(is_binary(&1) and byte_size(&1) in 1..256)),
      do: :ok,
      else: {:error, :work_state_conflict}
  end

  defp valid_scopes(_), do: {:error, :work_state_conflict}
  defp valid_agent(value) when is_binary(value) and value != "", do: :ok
  defp valid_agent(_), do: {:error, :work_state_conflict}

  defp valid_principal(%{"kind" => kind, "id" => id})
       when kind in ~w(agent user) and is_binary(id), do: :ok

  defp valid_principal(_), do: {:error, :work_state_conflict}

  defp reviewer_of?(works, principal, id) do
    Enum.any?(works, fn {_, work} -> work.reviews == id and work.assignee == principal end)
  end

  defp effective_verdict?(works, work) do
    Enum.any?(work.accepted_verdicts, fn ref ->
      review = works[ref.verdict_ref.work_id]

      verdict =
        if review, do: Enum.find(review.verdicts, &(&1.verdict_id == ref.verdict_ref.verdict_id))

      ref[:void] == nil and ref.subject_hash == subject_hash(work) and
        review != nil and review.state != "cancelled" and verdict != nil and
        verdict.state == "recorded" and verdict.outcome == "approve" and
        verdict.subject.hash == subject_hash(work)
    end)
  end

  defp invalidate(verdicts),
    do:
      Enum.map(verdicts, fn verdict ->
        if verdict.state == "recorded", do: %{verdict | state: "invalidated"}, else: verdict
      end)

  defp subject_hash(%{subject: %{hash: hash}}), do: hash
  defp subject_hash(_), do: nil

  defp stamp(work),
    do: %{
      work_id: work.work_id,
      revision: work.revision,
      authority_epoch: work.authority_epoch,
      state: work.state
    }

  defp timestamp, do: DateTime.utc_now() |> DateTime.to_iso8601()

  defp random_id(prefix),
    do: prefix <> Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

  defp config, do: Application.get_env(:kaoiro_server, :work_store, [])
end
