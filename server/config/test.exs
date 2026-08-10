import Config

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :kaoiro_server, KaoiroServerWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "QuGyT2gNZpDdXTzHcZKPuBUNVFi4omSMAOW2apvMFd3dOx453osH4dzIL8LjwC6e",
  server: false

# ふじ #120 must-fix 2: BEAM-safe run-scoped nonce (2026-07-25).
# System.unique_integer([:positive]) は同一 BEAM 内でしか一意でなく、
# 並行 mix test invocation (16 process 同時起動) で path が衝突すると
# 実測された。System.pid() (OS プロセス pid) と 8 バイトの暗号乱数を
# 組み合わせ、別 BEAM 間でも衝突しない run-scoped nonce を 1 回生成し、
# 全 DETS store が共有する。文字列は path-safe な base64 (padding なし)。
run_nonce =
  "#{System.pid()}_" <>
    Base.url_encode64(:crypto.strong_rand_bytes(8), padding: false)

# Per-run throwaway DETS file for the session_id pointer store (issue
# #49). run_nonce 共有により concurrent `mix test` invocations 間でも
# path が衝突しない — 同じ理由で下の全 DETS store も同じ nonce を使う。
config :kaoiro_server,
       :session_pointers_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_session_pointers_#{run_nonce}.dets"
       )

# Per-run throwaway DETS file for the permission_mode pick store (#58).
config :kaoiro_server,
       :permission_modes_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_permission_modes_#{run_nonce}.dets"
       )

# Per-run throwaway DETS file for the agent identity ledger (ADR-0030).
config :kaoiro_server,
       :agent_directory_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_agent_directory_#{run_nonce}.dets"
       )

# Per-run throwaway DETS file for the user identity ledger (issue #197,
# ADR-0050 D1). Same run_nonce isolation as the store above — without
# it, concurrent `mix test` invocations share the default
# $TMPDIR/kaoiro_users.dets file and open the same DETS table from
# multiple BEAMs (issue #187's failure mode, reproduced by もも).
config :kaoiro_server,
       :users_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_users_#{run_nonce}.dets"
       )

config :kaoiro_server,
       :clear_watermarks_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_clear_watermarks_#{run_nonce}.dets"
       )

config :kaoiro_server,
       :session_starts_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_session_starts_#{run_nonce}.dets"
       )

# Per-run throwaway DETS file for the IngressOrder allocator (ふじ
# R5 must-fix, 2026-07-23) and its A4 advisory (2026-07-23, 3rd
# review): without this, the app-started singleton wrote the shared
# `System.tmp_dir!()/kaoiro_ingress_order.dets` fallback that the
# module default_path/0 returns, so successive `mix test` runs
# accumulated `last_us` / `last_seq` state — and worse, collided with
# a running `mix phx.server` dev instance on the same host. Same
# per-run unique_integer suffix pattern as the stores above.
config :kaoiro_server,
       :ingress_order_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_ingress_order_#{run_nonce}.dets"
       )

# Per-run throwaway DETS file for the token denylist (ふじ #120 must-fix 1,
# 2026-07-25). 未設定時は module 側 default_path が共有 `/tmp/kaoiro_token_denylist.dets`
# に落ち、app supervisor が singleton を常時起動するため test の revocation
# 状態が dev/prod と交錯していた。認証境界の正本なので他 DETS store と
# 同じ per-run 隔離を適用。
config :kaoiro_server,
       :token_denylist_path,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_token_denylist_#{run_nonce}.dets"
       )

# Per-run persona extraction cache root (ADR-0046 F1). Without this the
# default lands in `$TMPDIR/kaoiro-persona-cache-<hash of ingest dir>`,
# which two concurrent `mix test` invocations pointed at the same ingest
# dir would share — and reclaim/extract there is rm_rf + unzip, not a
# DETS append. Same run_nonce isolation as the stores above.
config :kaoiro_server,
       :persona_cache_dir,
       Path.join(
         System.tmp_dir!(),
         "kaoiro_test_persona_cache_#{run_nonce}"
       )

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
