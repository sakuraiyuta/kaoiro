defmodule KaoiroServer.DeliveryPolicies.State do
  @moduledoc false
  @max_revision 9_007_199_254_740_991

  def revision?(value), do: is_integer(value) and value in 1..@max_revision
  def expected?(value), do: (is_integer(value) and value == 0) or revision?(value)
  def policy?(value), do: value in [:on, :off]

  def valid?(nil, nil), do: true
  def valid?(nil, counter), do: revision?(counter)

  def valid?(%{policy: policy, revision: revision} = row, counter),
    do:
      map_size(row) == 2 and policy?(policy) and revision?(revision) and revision?(counter) and
        counter >= revision

  def valid?(_, _), do: false

  def change(row, counter, policy, expected) do
    cond do
      not policy?(policy) or not expected?(expected) -> {:error, :invalid_payload}
      not valid?(row, counter) -> {:error, :policy_unknown}
      if(row, do: row.revision, else: 0) != expected -> {:error, :revision_conflict, row}
      counter == @max_revision -> {:error, :revision_exhausted}
      true -> {:ok, %{policy: policy, revision: (counter || 0) + 1}}
    end
  end

  def seed(explicit, defaults, engine) do
    cond do
      explicit in [:on, :off] -> explicit
      defaults[engine] == false -> :off
      true -> :on
    end
  end

  def view(row, snapshot) do
    known = is_map(row)
    support = is_map(snapshot) and snapshot.support
    applied = if is_map(snapshot), do: snapshot.applied_revision
    confirmed = known and is_map(snapshot) and (not support or applied == row.revision)

    %{
      "policy" => if(known, do: Atom.to_string(row.policy), else: "unknown"),
      "confirmed" => confirmed,
      "pending" => known and not confirmed,
      "wrapper_support" => is_map(snapshot) and support == true
    }
    |> optional("revision", if(known, do: row.revision))
    |> optional("applied_revision", applied)
  end

  def denial(nil, _snapshot), do: "policy_unknown"
  def denial(%{policy: :off}, _snapshot), do: "recipient_policy_off"

  def denial(%{revision: revision}, %{support: true, applied_revision: applied})
      when applied != revision,
      do: "policy_unconfirmed"

  def denial(_, _), do: nil

  defp optional(map, _, nil), do: map
  defp optional(map, key, value), do: Map.put(map, key, value)
end
