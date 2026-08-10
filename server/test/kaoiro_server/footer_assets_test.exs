defmodule KaoiroServer.FooterAssetsTest do
  # Mutates the :footer_dir config and the FooterAssets owner's state.
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.FooterAssets
  alias KaoiroServer.PersonaAssets

  setup do
    original = Application.get_env(:kaoiro_server, :footer_dir)

    on_exit(fn ->
      if original == nil do
        Application.delete_env(:kaoiro_server, :footer_dir)
      else
        Application.put_env(:kaoiro_server, :footer_dir, original)
      end

      # Also resets the last-known-good state: an unset dir resolves both
      # layers as "missing", i.e. positively determined as absent.
      FooterAssets.rebuild()
    end)

    :ok
  end

  defp use_footer_dir(dir) do
    Application.put_env(:kaoiro_server, :footer_dir, dir)
    :ok = FooterAssets.rebuild()
  end

  defp write_footer(dir, name, content) do
    File.write!(Path.join(dir, name), content)
  end

  test "内蔵デフォルトは peer-routing contract (ADR-0038) を含む" do
    footer = FooterAssets.built_in_system_footer()
    assert footer =~ "list_agents"
    assert footer =~ "kaoiro peer"
    assert footer =~ "代替生成しない"
    assert footer =~ "役割名"
    assert footer =~ "利用可能 tool を全て列挙"
    assert footer =~ "メッセージの行頭に `#` を置かない"
    assert footer =~ "`issue #NNN` のように語を前置すること"
    # trim 済み (F6) — priv ファイル末尾の改行は実効値に載らない。
    refute String.ends_with?(footer, "\n")
  end

  test "KAOIRO_FOOTER_DIR 未設定ならファイル優先は無効" do
    Application.delete_env(:kaoiro_server, :footer_dir)
    :ok = FooterAssets.rebuild()

    assert FooterAssets.snapshot() == %{
             system: FooterAssets.built_in_system_footer(),
             user: nil
           }
  end

  @tag :tmp_dir
  test "system-footer.md は内蔵デフォルトを完全に置き換える", %{tmp_dir: tmp} do
    write_footer(tmp, "system-footer.md", "置き換えた規約")
    use_footer_dir(tmp)

    assert FooterAssets.snapshot() == %{system: "置き換えた規約", user: nil}
  end

  @tag :tmp_dir
  test "user-footer.md は system の後ろに載り、system は内蔵のまま", %{tmp_dir: tmp} do
    write_footer(tmp, "user-footer.md", "運用ルール")
    use_footer_dir(tmp)

    assert FooterAssets.snapshot() == %{
             system: FooterAssets.built_in_system_footer(),
             user: "運用ルール"
           }
  end

  @tag :tmp_dir
  test "欠落・空はどちらも縮退する (system→内蔵 / user→なし)", %{tmp_dir: tmp} do
    # 欠落。
    use_footer_dir(tmp)
    assert %{system: built_in, user: nil} = FooterAssets.snapshot()
    assert built_in == FooterAssets.built_in_system_footer()

    # 空 (trim 後に空文字列) も同じ縮退。
    write_footer(tmp, "system-footer.md", "  \n\t\n")
    write_footer(tmp, "user-footer.md", "")
    :ok = FooterAssets.rebuild()

    assert FooterAssets.snapshot() == %{
             system: FooterAssets.built_in_system_footer(),
             user: nil
           }
  end

  @tag :tmp_dir
  test "BOM 除去 → CRLF→LF → trim が実効値になる", %{tmp_dir: tmp} do
    write_footer(tmp, "system-footer.md", "\uFEFF\r\n一行目\r\n二行目\r\n\r\n")
    use_footer_dir(tmp)

    assert FooterAssets.snapshot().system == "一行目\n二行目"
  end

  @tag :tmp_dir
  test "invalid UTF-8 は read_error で、LKG が無ければ縮退 + warn", %{tmp_dir: tmp} do
    # 先に空 dir で rebuild し、LKG を「ファイルなし」と確定させる。
    use_footer_dir(tmp)

    File.write!(Path.join(tmp, "system-footer.md"), <<0xFF, 0xFE, 0x41>>)

    log = capture_log(fn -> :ok = FooterAssets.rebuild() end)

    assert FooterAssets.snapshot().system == FooterAssets.built_in_system_footer()
    assert log =~ "footer read error: #{Path.join(Path.expand(tmp), "system-footer.md")}"
    assert log =~ "not valid UTF-8"
  end

  @tag :tmp_dir
  test "稼働中の read_error は直前の正常値 (LKG) を維持する", %{tmp_dir: tmp} do
    write_footer(tmp, "system-footer.md", "正常に読めた規約")
    use_footer_dir(tmp)
    assert FooterAssets.snapshot().system == "正常に読めた規約"

    # atomic save の途中のような一時的な破損。
    File.write!(Path.join(tmp, "system-footer.md"), <<0xFF>>)
    log = capture_log(fn -> :ok = FooterAssets.rebuild() end)

    assert FooterAssets.snapshot().system == "正常に読めた規約"
    assert log =~ "footer read error"

    # 復旧すればまたファイル値に戻る。
    write_footer(tmp, "system-footer.md", "復旧した規約")
    :ok = FooterAssets.rebuild()
    assert FooterAssets.snapshot().system == "復旧した規約"
  end

  # ふじ S1 (2026-08-03): LKG が GenServer state だと owner の crash-restart
  # で「一度も読めていない」状態へ落ち、直後の read_error が内蔵へ縮退して
  # しまう。persistent_term 保持なので restart を跨いで維持されること。
  @tag :tmp_dir
  test "owner が restart しても LKG は維持される", %{tmp_dir: tmp} do
    write_footer(tmp, "system-footer.md", "restart を跨ぐ規約")
    use_footer_dir(tmp)
    assert FooterAssets.snapshot().system == "restart を跨ぐ規約"

    File.write!(Path.join(tmp, "system-footer.md"), <<0xFF>>)
    capture_log(fn -> :ok = FooterAssets.rebuild() end)
    assert FooterAssets.snapshot().system == "restart を跨ぐ規約"

    # 再起動後の init が publish したものだけを見るため、restart 前の
    # state を消しておく… のではなく snapshot だけ落とす。state ごと消すと
    # LKG も消えて、この test が検証したい当のものが失われる。
    state = :persistent_term.get({FooterAssets, :state})
    :persistent_term.put({FooterAssets, :state}, %{state | snapshot: nil})

    capture_log(fn -> restart_owner() end)

    assert FooterAssets.snapshot().system == "restart を跨ぐ規約",
           "restart 後に LKG を失って内蔵へ縮退している"
  end

  defp restart_owner do
    pid = Process.whereis(FooterAssets)
    ref = Process.monitor(pid)
    :ok = GenServer.stop(FooterAssets)
    assert_receive {:DOWN, ^ref, :process, ^pid, _}, 5_000

    # `GenServer.stop/1` returns only after the process is gone, so the
    # supervisor's exit signal is already queued; this synchronous call
    # lands behind it and therefore behind the restart.
    _ = Supervisor.which_children(KaoiroServer.Supervisor)

    # `:gen` registers the name BEFORE calling init/1, so a live pid does
    # not mean init/1 finished. A system message does: it queues behind
    # init/1 and is only answered once the process is in its loop.
    _ = :sys.get_state(FooterAssets)
    :ok
  end

  @tag :tmp_dir
  test "削除は LKG で蘇らず内蔵へ縮退する", %{tmp_dir: tmp} do
    write_footer(tmp, "system-footer.md", "消される規約")
    use_footer_dir(tmp)
    assert FooterAssets.snapshot().system == "消される規約"

    File.rm!(Path.join(tmp, "system-footer.md"))
    :ok = FooterAssets.rebuild()

    assert FooterAssets.snapshot().system == FooterAssets.built_in_system_footer()
  end

  @tag :tmp_dir
  test "symlink は lstat で弾かれ read_error になる", %{tmp_dir: tmp} do
    target = Path.join(tmp, "target.md")
    File.write!(target, "symlink 越しの規約")
    :ok = File.ln_s(target, Path.join(tmp, "system-footer.md"))

    Application.put_env(:kaoiro_server, :footer_dir, tmp)
    log = capture_log(fn -> :ok = FooterAssets.rebuild() end)

    assert FooterAssets.snapshot().system == FooterAssets.built_in_system_footer()
    assert log =~ "not a regular file (symlink)"
  end

  @tag :tmp_dir
  test "rebuild ごとに 2 軸 + 文字数 + 短縮 SHA を info で出す", %{tmp_dir: tmp} do
    write_footer(tmp, "system-footer.md", "provenance 用の規約")

    level = Logger.level()
    Logger.configure(level: :info)
    on_exit(fn -> Logger.configure(level: level) end)

    log = capture_log(fn -> use_footer_dir(tmp) end)

    assert log =~
             "footer rebuild layer=system input_state=file effective_source=file chars=15"

    assert log =~ "footer rebuild layer=user input_state=missing effective_source=absent"
    assert log =~ ~r/layer=system .* sha256=[0-9a-f]{16}/
    assert log =~ "layer=user input_state=missing effective_source=absent chars=0 sha256=-"
  end

  @tag :tmp_dir
  test "persona rebuild と競合しても footer 値が退行しない", %{tmp_dir: tmp} do
    footer_dir = Path.join(tmp, "footers")
    persona_dir = Path.join(tmp, "packs")
    File.mkdir_p!(footer_dir)
    File.mkdir_p!(persona_dir)
    write_footer(footer_dir, "system-footer.md", "競合下の system")
    write_footer(footer_dir, "user-footer.md", "競合下の user")

    original_persona_dir = Application.get_env(:kaoiro_server, :persona_dir)

    on_exit(fn ->
      if original_persona_dir == nil do
        Application.delete_env(:kaoiro_server, :persona_dir)
      else
        Application.put_env(:kaoiro_server, :persona_dir, original_persona_dir)
      end

      PersonaAssets.rebuild()
    end)

    Application.put_env(:kaoiro_server, :persona_dir, persona_dir)
    use_footer_dir(footer_dir)

    # PersonaWatcher 側 (pack rebuild) と FooterWatcher 側 (footer
    # rebuild) の event が同時に来た状況。どちらの owner も相手の
    # persistent_term key を書かないので、どの順に確定しても footer は
    # 内蔵版へ巻き戻らない。
    [
      Task.async(fn -> Enum.each(1..30, fn _ -> PersonaAssets.rebuild() end) end),
      Task.async(fn -> Enum.each(1..30, fn _ -> FooterAssets.rebuild() end) end)
    ]
    |> Task.await_many(30_000)

    assert FooterAssets.snapshot() == %{system: "競合下の system", user: "競合下の user"}
    assert PersonaAssets.prompt("default") == "競合下の system\n\n競合下の user"
  end
end
