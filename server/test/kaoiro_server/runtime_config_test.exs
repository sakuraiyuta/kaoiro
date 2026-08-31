defmodule KaoiroServer.RuntimeConfigTest do
  use ExUnit.Case, async: true

  # issue #120 横断: 全 DETS path 系 config が (a) test.exs で per-run 名で
  # 設定され、(b) runtime.exs の env 上書きで nil に潰されないこと。
  # 元々検証されていた visibility 3 key に加え、issue #120 で「env 存在時のみ
  # 上書き」に統一した session_pointers / agent_directory / permission_modes、
  # must-fix 1 (ふじ 2026-07-25) で横断対象に追加した token_denylist、
  # issue #247 の delivery_states、issue #197 の users、ADR-0055 phase-33
  # Stage B の session_lifecycle_events を含む、deployment.md 1.2 の
  # canonical 10 DETS store 全てを確認する (inter_agent_history は
  # ADR-0051 で撤廃)。ふじ Stage B round 2 non-blocking (2026-08-31):
  # users_path はこの横断対象から漏れていた — 「全」を名乗る comment と
  # 実体が長らくずれていたので、canonical 側 (10) に合わせて追加した。
  @paths [
    clear_watermarks_path: "kaoiro_test_clear_watermarks_",
    session_starts_path: "kaoiro_test_session_starts_",
    ingress_order_path: "kaoiro_test_ingress_order_",
    delivery_states_path: "kaoiro_test_delivery_states_",
    session_pointers_path: "kaoiro_test_session_pointers_",
    agent_directory_path: "kaoiro_test_agent_directory_",
    permission_modes_path: "kaoiro_test_permission_modes_",
    token_denylist_path: "kaoiro_test_token_denylist_",
    session_lifecycle_events_path: "kaoiro_test_session_lifecycle_events_",
    users_path: "kaoiro_test_users_"
  ]

  test "test用のDETS pathはruntime configでnil上書きされない" do
    for {key, prefix} <- @paths do
      path = Application.fetch_env!(:kaoiro_server, key)

      assert is_binary(path)
      assert Path.basename(path) =~ prefix
      assert String.ends_with?(path, ".dets")
    end
  end

  # ふじ #120 must-fix 1 追加検証 (2026-07-25): 全 10 path が互いに衝突しない
  # ことの smoke test。真の nonce 共有 (unique_integer への per-store 退行
  # 検出) は捕まえられない — 各 basename の prefix (kaoiro_test_<store>_) が
  # store ごとに一意なのでこの assert は退行しても pass する。suffix を
  # normalize して比較する形へ retrofit するのは将来の候補 (クロエ #120
  # 再レビュー 2026-07-25 advisory 1)。
  test "全 DETS path は互いに一意 (basename 全体で衝突しない smoke test)" do
    paths =
      for {key, _prefix} <- @paths, do: Application.fetch_env!(:kaoiro_server, key)

    assert Enum.uniq(paths) == paths, "DETS test path が衝突: #{inspect(paths)}"
  end

  test "compose と dev launcher は delivery ledger を永続 / project-local path へ配線する" do
    repo_root = Path.expand("../../..", __DIR__)
    compose = File.read!(Path.join(repo_root, "server/docker-compose.yaml"))
    dev_launcher = File.read!(Path.join(repo_root, "scripts/dev.sh"))

    assert compose =~ "KAOIRO_DELIVERY_STATES_PATH: /var/lib/kaoiro/delivery_states.dets"
    assert compose =~ "- kaoiro-state:/var/lib/kaoiro"

    assert dev_launcher =~
             "KAOIRO_DELIVERY_STATES_PATH=\"${KAOIRO_DELIVERY_STATES_PATH:-$data_dir/delivery_states.dets}\""
  end

  # ふじ Stage B round 1 must-fix B1 (2026-08-31): runtime.exs read the env
  # var but no canonical persistence surface (compose / dev launcher) set
  # it, so a production deploy silently fell through to the container's
  # /tmp default and lost the timeline on every recreation.
  test "compose と dev launcher は session_lifecycle timeline を永続 / project-local path へ配線する" do
    repo_root = Path.expand("../../..", __DIR__)
    compose = File.read!(Path.join(repo_root, "server/docker-compose.yaml"))
    dev_launcher = File.read!(Path.join(repo_root, "scripts/dev.sh"))

    assert compose =~
             "KAOIRO_SESSION_LIFECYCLE_EVENTS_PATH: /var/lib/kaoiro/session_lifecycle_events.dets"

    assert dev_launcher =~
             "KAOIRO_SESSION_LIFECYCLE_EVENTS_PATH=\"${KAOIRO_SESSION_LIFECYCLE_EVENTS_PATH:-$data_dir/session_lifecycle_events.dets}\""
  end
end
