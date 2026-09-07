defmodule KaoiroServer.TestTimeoutsTest do
  # The last test rewrites :ex_unit's own configuration, so this case must
  # not run beside another one.
  use ExUnit.Case, async: false

  alias KaoiroServer.TestTimeouts

  test "the purge budget is the same multiple of either environment's base" do
    assert TestTimeouts.purge_reply(100) == 500
    assert TestTimeouts.purge_reply(500) == 2500
  end

  test "the purge budget leaves headroom over the base it was derived from" do
    for base <- [100, 500] do
      assert TestTimeouts.purge_reply(base) > base
    end
  end

  test "the default base is ExUnit's configured assert_receive_timeout" do
    original = Application.fetch_env!(:ex_unit, :assert_receive_timeout)
    on_exit(fn -> Application.put_env(:ex_unit, :assert_receive_timeout, original) end)
    # Raised rather than lowered: if anything else did read the base while
    # it is overridden, a longer budget is harmless and a shorter one is not.
    Application.put_env(:ex_unit, :assert_receive_timeout, 1000)

    assert TestTimeouts.purge_reply() == 5000
  end
end
