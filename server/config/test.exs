import Config

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :kaoiro_server, KaoiroServerWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "QuGyT2gNZpDdXTzHcZKPuBUNVFi4omSMAOW2apvMFd3dOx453osH4dzIL8LjwC6e",
  server: false

# Throwaway DETS file for the session_id pointer store (issue #49); the
# app-started instance writes here, isolated from any real data.
config :kaoiro_server,
       :session_pointers_path,
       Path.join(System.tmp_dir!(), "kaoiro_test_session_pointers.dets")

# Throwaway DETS file for the permission_mode pick store (#58); the app-
# started instance writes here, isolated from any real data.
config :kaoiro_server,
       :permission_modes_path,
       Path.join(System.tmp_dir!(), "kaoiro_test_permission_modes.dets")

# Throwaway DETS file for the agent identity ledger (ADR-0030); the
# app-started instance writes here, isolated from any real data.
config :kaoiro_server,
       :agent_directory_path,
       Path.join(System.tmp_dir!(), "kaoiro_test_agent_directory.dets")

# Per-run throwaway DETS file for durable inter-agent history (#105).
config :kaoiro_server,
       :inter_agent_history_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_inter_agent_history_#{System.unique_integer([:positive])}.dets"
       )

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
