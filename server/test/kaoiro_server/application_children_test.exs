defmodule KaoiroServer.ApplicationChildrenTest do
  # Asks the running supervision tree what it has.
  use ExUnit.Case, async: false

  alias KaoiroServer.Application, as: App

  # issue 482. The store reads TokenDenylist when it starts and must exist
  # before any channel can read its table, so its place in the list is part of
  # its contract.
  test "the status line store follows the stores it reads and precedes the Endpoint" do
    children = App.children()

    index = fn module ->
      Enum.find_index(children, &(&1 == module or match?({^module, _opts}, &1)))
    end

    store = index.(KaoiroServer.AgentStatusLines)

    assert is_integer(store)
    assert store > index.(KaoiroServer.TokenDenylist)
    assert store > index.(KaoiroServer.AgentDirectory)
    assert store < index.(KaoiroServerWeb.Endpoint)
  end

  # issue #537. ConversationStates reads Rooms on every record, and no channel
  # may send before both exist.
  test "Rooms precedes ConversationStates and the Endpoint" do
    children = App.children()

    index = fn module ->
      Enum.find_index(children, &(&1 == module or match?({^module, _}, &1)))
    end

    assert index.(KaoiroServer.Rooms) < index.(KaoiroServer.ConversationStates)
    assert index.(KaoiroServer.ConversationStates) < index.(KaoiroServerWeb.Endpoint)
  end

  test "the test node runs the status line store" do
    assert is_pid(Process.whereis(KaoiroServer.AgentStatusLines))
  end
end
