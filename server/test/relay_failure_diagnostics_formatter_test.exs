defmodule KaoiroServer.Test.RelayFailureDiagnosticsFormatterTest do
  use ExUnit.Case, async: false

  alias KaoiroServer.Test.RelayFailureDiagnosticsFormatter, as: Formatter

  test "registers the diagnostic formatter only in CI" do
    registered = ExUnit.configuration()[:formatters]

    if System.get_env("CI") do
      assert Formatter in registered
    else
      refute Formatter in registered
    end
  end

  test "dumps one diagnostic block for a missing-message timeout" do
    failure =
      ExUnit.AssertionError.exception(
        message: "Assertion failed, no matching message after 500ms"
      )

    test = %ExUnit.Test{
      name: :owner_stop,
      tags: %{line: 42},
      time: 1_200_000,
      state: {:failed, [{:error, failure, []}]}
    }

    output =
      ExUnit.CaptureIO.capture_io(:stderr, fn ->
        assert {:noreply, :state} = Formatter.handle_cast({:test_finished, test}, :state)
      end)

    assert length(Regex.scan(~r/=== relay assertion diagnostics ===/, output)) == 1
    assert output =~ "name: :owner_stop"
    assert output =~ "line: 42"
    assert output =~ "time_us: 1200000"
  end

  test "does not dump diagnostics for a different failure" do
    failure = ExUnit.AssertionError.exception(message: "unrelated assertion")
    test = %ExUnit.Test{state: {:failed, [{:error, failure, []}]}}

    output =
      ExUnit.CaptureIO.capture_io(:stderr, fn ->
        assert {:noreply, :state} = Formatter.handle_cast({:test_finished, test}, :state)
      end)

    assert output == ""
  end

  test "dumps diagnostics when a non-exception exit reason precedes a missing-message timeout" do
    failure = ExUnit.AssertionError.exception(message: "no matching message after 500ms")

    test = %ExUnit.Test{
      state: {:failed, [{:exit, :unexpected_exit, []}, {:error, failure, []}]}
    }

    output =
      ExUnit.CaptureIO.capture_io(:stderr, fn ->
        assert {:noreply, :state} = Formatter.handle_cast({:test_finished, test}, :state)
      end)

    assert length(Regex.scan(~r/=== relay assertion diagnostics ===/, output)) == 1
  end

  test "continues when an optional process is absent" do
    assert Formatter.process_snapshot(:momo_402_missing_process) == %{probe: :unavailable}
  end
end
