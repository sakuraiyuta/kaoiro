defmodule KaoiroServer.AgentStatusLinesFootprintTest do
  # The memory bound comes from structure, not from a figure: ETS `:memory`
  # does not count off-heap binaries, so a gauge cannot tell a latest-only row
  # from one that mirrors the history. These checks read the real production
  # state and rows (issue 482 design r6 section 5, r7 section 3, r8 section 5).
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentStatusLines
  alias KaoiroServer.StatusLinesFixture, as: Fixture

  @text_bytes 16_384
  @head_bytes 512

  describe "a store holding full histories" do
    setup do
      ctx = Fixture.start_store()

      for agent <- 1..3, n <- 1..20 do
        # A different leading letter per entry keeps the binaries distinct, so
        # nothing is shared and a mirrored history would show.
        text = String.duplicate(<<?a + rem(agent * 20 + n, 26)>>, @text_bytes)
        {:ok, _} = AgentStatusLines.put("a.#{agent}", text, ctx.name)
      end

      %{ctx: ctx}
    end

    test "publishes one latest-only row per agent, and only the latest text and its head", %{
      ctx: ctx
    } do
      rows = :ets.tab2list(ctx.table)

      assert length(rows) == 3
      assert {:ok, entries} = AgentStatusLines.history("a.1", ctx.name)
      assert length(entries) == 20

      for row <- rows do
        assert :ok = check_row(row)
        {_id, entry, head, true, @text_bytes} = row
        assert byte_size(entry.text) == @text_bytes
        assert byte_size(head) == @head_bytes
      end
    end

    test "keeps no text and no entry list in the process state", %{ctx: ctx} do
      assert :ok = check_state(:sys.get_state(ctx.pid))
    end
  end

  describe "the checker itself" do
    @text String.duplicate("t", @text_bytes)
    @head String.duplicate("t", @head_bytes)
    @entry %{seq: 1, text: @text, updated_at: "2026-10-03T00:00:00.000000Z"}

    test "accepts the latest text with its head" do
      assert :ok = check_row({"a.one", @entry, @head, true, @text_bytes})
    end

    test "accepts a stamped clear" do
      cleared = %{@entry | text: nil}
      assert :ok = check_row({"a.one", cleared, "", false, 0})
    end

    test "rejects a row that carries the history" do
      assert {:error, :shape} = check_row({"a.one", @entry, @head, true, @text_bytes, [@entry]})

      with_history = Map.put(@entry, :history, [@entry])
      assert {:error, :list_in_row} = check_row({"a.one", with_history, @head, true, @text_bytes})
    end

    test "rejects a row holding another large binary" do
      other = %{@entry | updated_at: String.duplicate("x", 100)}
      assert {:error, _} = check_row({"a.one", other, @head, true, @text_bytes})
    end

    test "rejects an oversize head or text" do
      assert {:error, _} = check_row({"a.one", @entry, @head <> "t", true, @text_bytes})
      big = %{@entry | text: @text <> "t"}
      assert {:error, _} = check_row({"a.one", big, @head, true, @text_bytes + 1})
    end

    test "state check rejects a large binary and a list of entries" do
      assert :ok = check_state(%{name: :store, retention: 20})
      assert {:error, _} = check_state(%{name: :store, cache: @text})
      assert {:error, _} = check_state(%{name: :store, cache: [@entry]})
    end
  end

  # {id, entry, head, truncated, bytes}, with exactly the latest text and its
  # head as the only binaries over 64 bytes and no list anywhere.
  defp check_row({id, %{seq: seq, text: text, updated_at: at}, head, truncated, bytes} = row)
       when is_binary(id) and is_integer(seq) and is_binary(at) and is_binary(head) and
              is_boolean(truncated) and is_integer(bytes) do
    large = row |> binaries(64) |> Enum.sort()
    allowed = [text, head] |> Enum.filter(&(is_binary(&1) and byte_size(&1) > 64)) |> Enum.sort()

    cond do
      is_binary(text) and byte_size(text) > @text_bytes -> {:error, :text_too_large}
      byte_size(head) > @head_bytes -> {:error, :head_too_large}
      lists(row) != [] -> {:error, :list_in_row}
      large != allowed -> {:error, :unexpected_binary}
      true -> :ok
    end
  end

  defp check_row(_row), do: {:error, :shape}

  defp check_state(state) do
    cond do
      state |> binaries(1_024) != [] ->
        {:error, :large_binary_in_state}

      state
      |> lists()
      |> Enum.any?(&Enum.any?(&1, fn item -> is_map(item) and Map.has_key?(item, :seq) end)) ->
        {:error, :entries_in_state}

      true ->
        :ok
    end
  end

  # Every binary longer than `over` bytes, found anywhere in the term. Funs and
  # pids are not followed: they carry no text.
  defp binaries(term, over), do: collect(term, fn t -> is_binary(t) and byte_size(t) > over end)

  defp lists(term), do: collect(term, &is_list/1)

  defp collect(term, keep?) do
    found = if keep?.(term), do: [term], else: []
    found ++ Enum.flat_map(children(term), &collect(&1, keep?))
  end

  defp children(term) when is_tuple(term), do: Tuple.to_list(term)
  defp children(term) when is_list(term), do: term
  defp children(term) when is_map(term), do: Enum.flat_map(term, fn {k, v} -> [k, v] end)
  defp children(_term), do: []
end
