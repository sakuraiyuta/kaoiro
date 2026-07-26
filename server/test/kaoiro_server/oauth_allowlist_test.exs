defmodule KaoiroServer.OAuthAllowlistTest do
  # Mutates :oauth_allowlist_path (ADR-0042).
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog
  import KaoiroServer.OAuthAllowlistFixture

  alias KaoiroServer.OAuthAllowlist

  setup do
    Application.delete_env(:kaoiro_server, :oauth_allowlist_path)
    on_exit(fn -> Application.delete_env(:kaoiro_server, :oauth_allowlist_path) end)
  end

  describe "role_for/2 fail-closed" do
    test "path 未設定なら誰も許可しない" do
      assert OAuthAllowlist.role_for("google", "ao@example.com") == nil
      assert OAuthAllowlist.configured?() == false
    end

    test "ファイルが無ければ誰も許可せず warn を出す" do
      path = Path.join(System.tmp_dir!(), "kaoiro_test_allowlist_missing")
      File.rm(path)
      Application.put_env(:kaoiro_server, :oauth_allowlist_path, path)

      log =
        capture_log(fn ->
          assert OAuthAllowlist.role_for("google", "ao@example.com") == nil
        end)

      assert log =~ "OAuth allow-list unreadable"
      assert log =~ ":enoent"
    end

    test "エントリに無い identity は許可しない" do
      put_allowlist("google:ao@example.com:operator")

      assert OAuthAllowlist.role_for("google", "other@example.com") == nil
      assert OAuthAllowlist.role_for("github", "ao@example.com") == nil
    end

    test "空・非バイナリの identity は許可しない" do
      put_allowlist("google:ao@example.com:operator")

      assert OAuthAllowlist.role_for("google", "") == nil
      assert OAuthAllowlist.role_for("google", nil) == nil
      assert OAuthAllowlist.role_for(nil, "ao@example.com") == nil
    end
  end

  describe "role_for/2 parse" do
    test "role 省略時は viewer (安全側既定)" do
      put_allowlist("github:ao")

      assert OAuthAllowlist.role_for("github", "ao") == :viewer
    end

    test "role 明記を解決する" do
      put_allowlist("""
      github:ao:operator
      github:momo:viewer
      """)

      assert OAuthAllowlist.role_for("github", "ao") == :operator
      assert OAuthAllowlist.role_for("github", "momo") == :viewer
    end

    test "google の email は大小文字を無視する" do
      put_allowlist("google:AO@Example.com:operator")

      assert OAuthAllowlist.role_for("google", "ao@example.com") == :operator
      assert OAuthAllowlist.role_for("google", "AO@EXAMPLE.COM") == :operator
    end

    test "github / nextcloud の識別子は大小文字をそのまま比較する" do
      put_allowlist("""
      github:Ao:operator
      nextcloud:Kuroe:operator
      """)

      assert OAuthAllowlist.role_for("github", "Ao") == :operator
      assert OAuthAllowlist.role_for("github", "ao") == nil
      assert OAuthAllowlist.role_for("nextcloud", "Kuroe") == :operator
      assert OAuthAllowlist.role_for("nextcloud", "kuroe") == nil
    end

    test "コメント行・空行・前後の空白を無視する" do
      put_allowlist("""
      # マスター
      \s\s
        github:ao:operator\s\s

      #github:disabled:operator
      """)

      assert OAuthAllowlist.role_for("github", "ao") == :operator
      assert OAuthAllowlist.role_for("github", "disabled") == nil
    end

    test "各フィールドの前後の空白は落とす (無言の死にエントリを作らない)" do
      put_allowlist("""
      github: ao :operator
      google: AO@Example.com
      """)

      assert OAuthAllowlist.role_for("github", "ao") == :operator
      assert OAuthAllowlist.role_for("google", "ao@example.com") == :viewer
    end

    test "不正な行は warn + skip し、他の行は生かす" do
      log =
        capture_log(fn ->
          put_allowlist("""
          broken
          gogle:ao:operator
          github:ao:admin
          github::operator
          github:ao:operator
          """)

          assert OAuthAllowlist.role_for("github", "ao") == :operator
        end)

      assert log =~ "ignoring malformed OAuth allow-list entry on line 1"
      assert log =~ "line 2"
      assert log =~ "line 3"
      assert log =~ "line 4"
      # 識別子そのものはログに残さない。
      refute log =~ "gogle:ao"
    end
  end

  test "毎回 parse するので行の削除が即反映される (キャッシュなし)" do
    path = put_allowlist("github:ao:operator")
    assert OAuthAllowlist.role_for("github", "ao") == :operator

    File.write!(path, "")

    assert OAuthAllowlist.role_for("github", "ao") == nil
  end
end
