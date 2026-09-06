defmodule KaoiroServer.RuntimeConfigTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.PersistencePaths

  # issue #120 横断: 全 DETS path 系 config が (a) test.exs で per-run 名で
  # 設定され、(b) runtime.exs の env 上書きで nil に潰されないこと。対象は
  # KaoiroServer.PersistencePaths から派生する (issue #310)。手書きの一覧は
  # 「全」を名乗りながら permission_settings_path を落としていた —
  # 派生にすればその乖離自体が起こらない。
  @paths for store <- PersistencePaths.stores(),
             do: {store.config_key, "kaoiro_test_#{store.store}_"}

  test "test用のDETS pathはruntime configでnil上書きされない" do
    for {key, prefix} <- @paths do
      path = Application.fetch_env!(:kaoiro_server, key)

      assert is_binary(path)
      assert Path.basename(path) =~ prefix
      assert String.ends_with?(path, ".dets")
    end
  end

  # ふじ #120 must-fix 1 追加検証 (2026-07-25): 全 path が互いに衝突しない
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

  # issue #217 の class: runtime.exs が env を読むこと自体は deploy の証拠に
  # ならない。どれか 1 面に載り損ねた store は container の /tmp default へ
  # 落ち、再作成のたびに失われる (backup 集合も同じ一覧から作られる)。
  # PersistencePaths から派生させ、新しい store が 1 面だけに載る状態を
  # 起こせなくする (issue #310)。以前は delivery_states /
  # session_lifecycle_events / quagmire_settings の 3 store だけを手書きで
  # 見ていた。
  test "全 canonical store が compose / dev launcher / .env.example / runbook に配線されている" do
    repo_root = Path.expand("../../..", __DIR__)
    compose = File.read!(Path.join(repo_root, "server/docker-compose.yaml"))
    dev_launcher = File.read!(Path.join(repo_root, "scripts/dev.sh"))
    env_example = File.read!(Path.join(repo_root, "server/.env.example"))
    deployment = File.read!(Path.join(repo_root, "docs/specs/deployment.md"))

    for store <- PersistencePaths.stores() do
      volume_path = PersistencePaths.volume_path(store)

      assert compose =~ "#{store.env}: #{volume_path}",
             "docker-compose.yaml does not declare #{store.env}"

      assert dev_launcher =~
               "#{store.env}=\"${#{store.env}:-$data_dir/#{store.default_file}}\"",
             "scripts/dev.sh does not export #{store.env}"

      assert env_example =~ "#{store.env}=#{volume_path}",
             "server/.env.example does not document #{store.env}"

      assert deployment =~ "`#{store.env}`",
             "docs/specs/deployment.md does not list #{store.env}"
    end
  end
end
