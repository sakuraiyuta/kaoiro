defmodule KaoiroServerWeb.ChannelCaseBudgetTest do
  # Pins the budget of ChannelCase's assert_reply: the durable-write default
  # for a call without a budget, and the given value for a call with one. Both
  # read the budget off the failure text of a reply that never arrives, so they
  # do not depend on how long a real reply takes.
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.TestTimeouts

  test "assert_reply waits the durable-write budget by default" do
    ref = make_ref()

    error = assert_raise ExUnit.AssertionError, fn -> assert_reply ref, :ok end

    assert error.message =~
             "no matching message after #{TestTimeouts.durable_reply()}ms"
  end

  test "an explicit budget is used as given, not replaced by the default" do
    ref = make_ref()

    error =
      assert_raise ExUnit.AssertionError, fn ->
        assert_reply ref, :ok, %{}, TestTimeouts.durable_reply() + 1
      end

    assert error.message =~
             "no matching message after #{TestTimeouts.durable_reply() + 1}ms"
  end
end
