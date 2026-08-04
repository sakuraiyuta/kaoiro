defmodule KaoiroServer.TestTeardownTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog
  import KaoiroServer.TestTeardown

  # terminate/2 で止まったまま返らない GenServer。stop が :sys.terminate に
  # 入っている最中に exit signal を届ける窓を、待ち合わせで決定的に作る。
  defmodule Wedged do
    use GenServer

    @impl true
    def init(waiter), do: {:ok, waiter}

    @impl true
    def terminate(_reason, waiter) do
      send(waiter, {:terminating, self()})
      Process.sleep(:infinity)
    end
  end

  # terminate/2 が例外で落ちる GenServer。benign でない exit を決定的に作る。
  defmodule Rude do
    use GenServer

    @impl true
    def init(state), do: {:ok, state}

    @impl true
    def terminate(_reason, _state), do: raise("teardown boom")
  end

  # terminate/2 が渡された処理を実行する GenServer。既に消えた相手を触らせて、
  # exit reason の内側に teardown race とは無関係の :noproc を作るのに使う。
  defmodule Dependent do
    use GenServer

    @impl true
    def init(on_terminate), do: {:ok, on_terminate}

    @impl true
    def terminate(_reason, on_terminate), do: on_terminate.()
  end

  # handle_info で待たせておく GenServer。stop が送る system message を
  # mailbox に積ませたまま殺す窓を作るのに使う。
  defmodule Busy do
    use GenServer

    @impl true
    def init(waiter), do: {:ok, waiter}

    @impl true
    def handle_info(:block, waiter) do
      send(waiter, {:blocking, self()})

      receive do
        :never -> {:noreply, waiter}
      end
    end
  end

  # link しない process を起こして殺す。GenServer.stop から見て「既に居ない」
  # 相手を作るための下ごしらえ。
  defp dead_pid do
    {:ok, pid} = Agent.start(fn -> :ok end)
    ref = Process.monitor(pid)
    Process.exit(pid, :kill)
    assert_receive {:DOWN, ^ref, :process, ^pid, :killed}
    pid
  end

  # stop が送った system message が mailbox に積まれるまで待つ。sleep で
  # 決め打ちせず、実際に積まれたことを見てから次へ進む。
  defp wait_for_system_terminate(pid, attempts \\ 200) do
    {:messages, messages} = Process.info(pid, :messages)

    cond do
      Enum.any?(messages, &match?({:system, _from, {:terminate, _}}, &1)) ->
        :ok

      attempts <= 0 ->
        flunk("system terminate message が mailbox に積まれなかった")

      true ->
        Process.sleep(5)
        wait_for_system_terminate(pid, attempts - 1)
    end
  end

  # stop が terminate/2 に到達したところで `signal` を送り、GenServer.stop が
  # 返す exit reason を得る。ExUnit のリンク死が stop 中に届く窓の再現。
  defp exit_during_terminate(signal) do
    {:ok, pid} = GenServer.start(Wedged, self())
    task = Task.async(fn -> catch_exit(GenServer.stop(pid)) end)

    assert_receive {:terminating, ^pid}, 1_000
    Process.exit(pid, signal)

    Task.await(task, 5_000)
  end

  describe "benign_teardown_exit?/1 — 実測の exit reason" do
    test "既に死んだ pid への GenServer.stop は benign" do
      assert benign_teardown_exit?(catch_exit(GenServer.stop(dead_pid())))
    end

    test ":sys.terminate 経由の :noproc は proc_lib が bare へ潰す" do
      # envelope 3 が良性 race では発生しえない根拠。ここが崩れたら
      # whitelist を実測し直すこと。
      dead = dead_pid()

      assert {:noproc, {:sys, :terminate, _}} =
               catch_exit(:sys.terminate(dead, :normal, :infinity))

      assert :noproc = catch_exit(:proc_lib.stop(dead, :normal, :infinity))
    end

    test "登録名が消えている場合の GenServer.stop も benign" do
      name = :"gone_#{System.unique_integer([:positive])}"

      assert benign_teardown_exit?(catch_exit(GenServer.stop(name)))
    end

    test "stop 中に :shutdown で殺された場合も benign (ExUnit のリンク死)" do
      assert benign_teardown_exit?(exit_during_terminate(:shutdown))
    end

    test "stop 中に :kill で殺された場合は benign ではない" do
      refute benign_teardown_exit?(exit_during_terminate(:kill))
    end

    test "system message 待ちのまま :shutdown で殺されると :sys.terminate 層が残る" do
      # 実測 3 形のうち入れ子形 (envelope 3) の live pin。callback を塞いで
      # stop の {:system, _, {:terminate, _}} を mailbox に積ませ、処理される
      # 前に :shutdown を届けると :gen の monitor が先に発火し、
      # {:sys, :terminate, _} 層が reason に残る。OTP がこの層を畳むように
      # 変わったらここが落ちる (ふじ #171-S2)。
      {:ok, pid} = GenServer.start(Busy, self())
      send(pid, :block)
      assert_receive {:blocking, ^pid}, 1_000

      task = Task.async(fn -> catch_exit(GenServer.stop(pid)) end)
      wait_for_system_terminate(pid)
      Process.exit(pid, :shutdown)

      reason = Task.await(task, 5_000)

      assert match?({{:shutdown, {:sys, :terminate, _}}, {GenServer, :stop, _}}, reason),
             "envelope 3 の形が変わった: #{inspect(reason, limit: 6)}"

      assert benign_teardown_exit?(reason)
    end

    test "terminate/2 の crash は benign ではない" do
      {:ok, pid} = GenServer.start(Rude, [])
      {reason, _log} = with_log(fn -> catch_exit(GenServer.stop(pid)) end)

      refute benign_teardown_exit?(reason)
    end
  end

  describe "benign_teardown_exit?/1 — reason の形" do
    test "実測 3 形をどれも拾う" do
      mfa = {GenServer, :stop, [:srv, :normal, :infinity]}
      sys = fn reason -> {reason, {:sys, :terminate, [self(), :normal, :infinity]}} end

      assert benign_teardown_exit?({:noproc, mfa})
      assert benign_teardown_exit?({:shutdown, mfa})
      assert benign_teardown_exit?({sys.(:shutdown), mfa})

      # :sys.terminate 層を着けたままの :noproc は良性 race では出ない
      # (proc_lib が bare へ潰す)。出るのは store 自身の terminate/2 が
      # 死んだ相手へ :sys.terminate した場合 = 本物の欠陥。
      refute benign_teardown_exit?({sys.(:noproc), mfa})
    end

    test "認識済み envelope の外にある benign leaf は拾わない (fail-closed)" do
      # GenServer.stop/3 は必ず {reason, {GenServer, :stop, args}} で包むので、
      # 裸の leaf や別の包み方は teardown 由来ではない。
      refute benign_teardown_exit?(:noproc)
      refute benign_teardown_exit?(:shutdown)
      refute benign_teardown_exit?({:noproc, :whatever})
      refute benign_teardown_exit?({:shutdown, :closed})

      # terminate/2 が自前で exit({:shutdown, detail}) した形。任意 detail を
      # 丸ごと受理すると shutdown bug を隠す。
      refute benign_teardown_exit?(
               {{:shutdown, :dependency_failure}, {GenServer, :stop, [:srv, :normal, :infinity]}}
             )
    end

    test "leaf が benign でも :sys.terminate 以外の経路なら拾わない" do
      # ふじ M1 の反例。terminate/2 が消えた依存へ call すると内側に無関係な
      # :noproc が現れる。任意 MFA を剥がす実装はこれを race と取り違えた。
      refute benign_teardown_exit?(
               {{:noproc, {GenServer, :call, [:missing_dep, :close, 5_000]}},
                {GenServer, :stop, [:srv, :normal, :infinity]}}
             )

      # :sys.terminate 層が二重に積まれた形も未実測なので拒否。
      refute benign_teardown_exit?(
               {{{:noproc, {:sys, :terminate, [:srv]}}, {:sys, :terminate, [:srv]}},
                {GenServer, :stop, [:srv, :normal, :infinity]}}
             )
    end

    test "teardown の異常は握り潰さない" do
      # terminate/2 の中で call が返らず :timeout が伝播した形。stop 自体は
      # :infinity なので、下の {:timeout, {GenServer, :stop, _}} は有限
      # timeout を渡したときだけの形 (詳細は TestTeardown の @moduledoc)。
      refute benign_teardown_exit?(
               {{:timeout, {GenServer, :call, [:srv, :msg, 5_000]}},
                {GenServer, :stop, [:srv, :normal, :infinity]}}
             )

      refute benign_teardown_exit?({:timeout, {GenServer, :stop, [:srv, :normal, 5]}})

      # terminate/2 での crash。
      refute benign_teardown_exit?(
               {{%RuntimeError{message: "boom"}, []},
                {GenServer, :stop, [:srv, :normal, :infinity]}}
             )

      refute benign_teardown_exit?(:killed)
      refute benign_teardown_exit?(:normal)
      refute benign_teardown_exit?({:calling_self, {GenServer, :stop, [:srv, :normal, 0]}})
    end

    test "外側が GenServer.stop の envelope でなければ拾わない" do
      refute benign_teardown_exit?({:noproc, {GenServer, :stop, :not_a_list}})
      refute benign_teardown_exit?({:noproc, {GenServer, :call, [:srv, :msg, 5_000]}})
      refute benign_teardown_exit?({:noproc, {:not_an_mfa, :pair}})
    end
  end

  describe "stop_quietly/1" do
    test "生きている pid を止める" do
      {:ok, pid} = Agent.start(fn -> :ok end)

      assert stop_quietly(pid) == :ok
      refute Process.alive?(pid)
    end

    test "既に死んでいる pid では何もしない" do
      assert stop_quietly(dead_pid()) == :ok
    end

    test "登録名でも止まり、未登録名では何もしない" do
      name = :"tt_#{System.unique_integer([:positive])}"
      {:ok, pid} = Agent.start(fn -> :ok end, name: name)

      assert stop_quietly(name) == :ok
      refute Process.alive?(pid)
      assert stop_quietly(name) == :ok
    end

    test "terminate/2 が消えた依存へ call して :noproc になっても握り潰さない" do
      # ふじ M1 の反例を実プロセスで。内側の :noproc は teardown race のもの
      # ではないので、握り潰すと terminate crash が見えなくなる。
      dep = :"missing_dep_#{System.unique_integer([:positive])}"
      {:ok, pid} = GenServer.start(Dependent, fn -> GenServer.call(dep, :close) end)
      {reason, _log} = with_log(fn -> catch_exit(stop_quietly(pid)) end)

      assert match?(
               {{:noproc, {GenServer, :call, [^dep, :close, _]}}, {GenServer, :stop, _}},
               reason
             )
    end

    test "terminate/2 が消えた依存へ :sys.terminate しても握り潰さない" do
      # 同じ構造だが MFA が {:sys, :terminate, _} になる形。良性 race の
      # envelope と MFA が一致するので、leaf だけ見る実装はこれを取りこぼす。
      dead = dead_pid()

      {:ok, pid} =
        GenServer.start(Dependent, fn -> :sys.terminate(dead, :normal, :infinity) end)

      {reason, _log} = with_log(fn -> catch_exit(stop_quietly(pid)) end)

      assert match?(
               {{:noproc, {:sys, :terminate, [^dead | _]}}, {GenServer, :stop, _}},
               reason
             )
    end

    test "benign でない exit はそのまま再送出する" do
      {:ok, pid} = GenServer.start(Rude, [])
      {reason, _log} = with_log(fn -> catch_exit(stop_quietly(pid)) end)

      assert match?(
               {{%RuntimeError{message: "teardown boom"}, _stack}, {GenServer, :stop, _}},
               reason
             )
    end
  end
end
