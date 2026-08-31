# issue #282 案a (director裁定 2026-08-31): CI runner (2-core, max_cases 8)
# measurements repeatedly showed assert_receive/assert_reply response
# latency exceeding ExUnit's 100ms default -- BEAM scheduler contention,
# not a host-level stall (the CI job's monotonic-clock gap probe reported
# none of those runs). Raised for CI only; local runs keep the 100ms
# default so a genuine deadlock/regression is still caught fast during
# development. `CI` is GitHub Actions' own convention, explicitly passed
# into the `mix test` container by `.github/workflows/ci.yml`'s `-e CI`
# (docker run does not inherit the runner's environment automatically).
if System.get_env("CI") do
  ExUnit.start(assert_receive_timeout: 500)
else
  ExUnit.start()
end
