defmodule KaoiroServer.PersonaRebuildLockTest do
  # Mutates :persona_dir / :persona_cache_dir config and the
  # persistent_term cache PersonaAssets shares across the whole suite —
  # same isolation discipline as PersonaAssetsTest.
  use ExUnit.Case, async: false

  alias KaoiroServer.PersonaAssets
  alias KaoiroServer.PersonaRebuildLock

  setup do
    original = Application.get_env(:kaoiro_server, :persona_dir)
    original_cache = Application.get_env(:kaoiro_server, :persona_cache_dir)

    on_exit(fn ->
      restore_env(:persona_dir, original)
      restore_env(:persona_cache_dir, original_cache)
      PersonaAssets.rebuild()
    end)

    :ok
  end

  defp restore_env(key, nil), do: Application.delete_env(:kaoiro_server, key)
  defp restore_env(key, value), do: Application.put_env(:kaoiro_server, key, value)

  describe "issue #195 round-3: boot ownership (warm init)" do
    @tag :tmp_dir
    test "warm child の起動時 rebuild 失敗は Supervisor.start_link を即座に失敗させ、" <>
           "retry loop へ入らない (must-1)",
         %{tmp_dir: tmp} do
      parent = Path.join(tmp, "locked")
      File.mkdir_p!(parent)
      File.chmod!(parent, 0o500)
      on_exit(fn -> File.chmod(parent, 0o700) end)

      Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(parent, "cache"))
      Application.put_env(:kaoiro_server, :persona_dir, tmp)

      # cold start = persistent_term に cache が無い状態(既存の
      # persona_assets_test.exs の cold-start テストと同じ強制手段)。
      :persistent_term.erase({PersonaAssets, :cache})

      # Supervisor.start_link はテストプロセスへ link するため、init/1 の
      # raise はデフォルトで test process 自体を巻き込んで落とす — 実測で
      # 確認したのと同じ理由(trap_exit していない呼び出し元プロセスは
      # supervisor の初期化失敗の EXIT signal で道連れに死ぬ)。
      Process.flag(:trap_exit, true)

      name = :"warm_fail_#{System.unique_integer([:positive])}"

      result =
        Supervisor.start_link([{PersonaRebuildLock, warm: true, name: name}],
          strategy: :one_for_one
        )

      # 契約として pin するのは (a) failed_to_start_child による即時の
      # 失敗と (b) 失敗後にプロセスが残らないことの2点のみ。経過時間の
      # しきい値は退けた(ふじ round-3 should-fix, 2026-08-05): 正しい
      # no-retry でも scheduler/filesystem 負荷次第で遅くなり得るし、
      # 誤った高速 retry でも短時間で終わり得るため、時間しきい値は
      # no-retry の証拠にならず CI flake の種でしかない。retry loop へ
      # 入っていないこと自体は、この失敗が `{:shutdown,
      # :reached_max_restart_intensity}`(retry を使い切った後の形)では
      # なく `{:failed_to_start_child, _}`(初期 child 起動失敗の形)で
      # あることそのものが示す(モジュール doc 参照: 実測で両者は別の形)。
      assert {:error,
              {:shutdown,
               {:failed_to_start_child, PersonaRebuildLock,
                {%RuntimeError{message: message}, _st}}}} =
               result

      assert message =~ "cold start"
      assert message =~ "cache dir unusable"

      refute Process.whereis(name), "失敗した起動の後に lock process が残ってはいけない"
    end
  end

  describe "issue #195 round-3: public runtime path goes through the lock" do
    @tag :tmp_dir
    test ":sys.suspend(PersonaRebuildLock) 中は PersonaAssets.rebuild/0 が完了せず、" <>
           "resume 後に完了する (must-1)",
         %{tmp_dir: tmp} do
      # ふじ round-3 差し戻し: 前回はここで `PersonaRebuildLock.rebuild/1`
      # を直接呼んでいたが、それが pin するのは「PersonaRebuildLock が
      # 自分自身の GenServer を経由する」ことだけで、本番の public
      # entrypoint である `PersonaAssets.rebuild/0` が本当にこの lock を
      # 経由しているかは証明しない — 将来 `PersonaAssets.rebuild/0` が
      # `do_rebuild/0` を直呼びする形へ回帰しても、このテストは緑のまま
      # だった。実在する registered singleton を suspend し、
      # `PersonaAssets.rebuild/0` 経由で呼ぶことで、pin する対象を
      # public entrypoint 自体へ揃える。
      ingest = Path.join(tmp, "packs")
      cache = Path.join(tmp, "cache")
      File.mkdir_p!(ingest)
      File.mkdir_p!(cache)
      Application.put_env(:kaoiro_server, :persona_dir, ingest)
      Application.put_env(:kaoiro_server, :persona_cache_dir, cache)

      :sys.suspend(PersonaRebuildLock)

      # 実在する singleton を suspend するため、assertion failure で
      # resume し忘れると以降の全テスト(このプロセス以外からの
      # PersonaAssets.rebuild/0 呼び出しも含む)を巻き込んで止める。
      # try/after で resume を無条件に保証する — 正常系でも try 内で
      # 明示的に resume するので、after の呼び出しは冪等な安全網。
      try do
        task = Task.async(fn -> PersonaAssets.rebuild() end)

        refute Task.yield(task, 200),
               "suspend 中に PersonaAssets.rebuild/0 が完了した — " <>
                 "public entrypoint が lock を迂回している疑い"

        :sys.resume(PersonaRebuildLock)

        assert {:ok, :ok} = Task.yield(task, 5_000)
      after
        :sys.resume(PersonaRebuildLock)
      end
    end
  end
end
