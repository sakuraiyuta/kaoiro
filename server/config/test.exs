import Config

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :kaoiro_server, KaoiroServerWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "QuGyT2gNZpDdXTzHcZKPuBUNVFi4omSMAOW2apvMFd3dOx453osH4dzIL8LjwC6e",
  server: false

# Per-run throwaway DETS file for the session_id pointer store (issue
# #49). unique_integer suffix isolates concurrent `mix test` invocations
# and prevents accumulation across test-suite runs — same rationale as
# the InterAgentHistory / IngressOrder per-run configs below.
config :kaoiro_server,
       :session_pointers_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_session_pointers_#{System.unique_integer([:positive])}.dets"
       )

# Per-run throwaway DETS file for the permission_mode pick store (#58).
config :kaoiro_server,
       :permission_modes_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_permission_modes_#{System.unique_integer([:positive])}.dets"
       )

# Per-run throwaway DETS file for the agent identity ledger (ADR-0030).
config :kaoiro_server,
       :agent_directory_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_agent_directory_#{System.unique_integer([:positive])}.dets"
       )

# Per-run throwaway DETS file for durable inter-agent history (#105).
config :kaoiro_server,
       :inter_agent_history_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_inter_agent_history_#{System.unique_integer([:positive])}.dets"
       )

config :kaoiro_server,
       :clear_watermarks_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_clear_watermarks_#{System.unique_integer([:positive])}.dets"
       )

config :kaoiro_server,
       :session_starts_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_session_starts_#{System.unique_integer([:positive])}.dets"
       )

# Per-run throwaway DETS file for the IngressOrder allocator (ふじ
# R5 must-fix, 2026-07-23) and its A4 advisory (2026-07-23, 3rd
# review): without this, the app-started singleton wrote the shared
# `System.tmp_dir!()/kaoiro_ingress_order.dets` fallback that the
# module default_path/0 returns, so successive `mix test` runs
# accumulated `last_us` / `last_seq` state — and worse, collided with
# a running `mix phx.server` dev instance on the same host. Same
# per-run unique_integer suffix pattern as InterAgentHistory above.
config :kaoiro_server,
       :ingress_order_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_ingress_order_#{System.unique_integer([:positive])}.dets"
       )

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
