defmodule KaoiroServer.OAuthTest do
  # Mutates the :oauth_* provider config (ADR-0042).
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias KaoiroServer.OAuth

  @env_keys [
    :oauth_google_client_id,
    :oauth_google_client_secret,
    :oauth_github_client_id,
    :oauth_github_client_secret,
    :oauth_nextcloud_client_id,
    :oauth_nextcloud_client_secret,
    :oauth_nextcloud_base_url,
    :oauth_allowlist_path
  ]

  setup do
    clear_env()
    on_exit(&clear_env/0)
  end

  describe "enabled_providers/0" do
    test "何も設定しなければ空 (OAuth は無効)" do
      assert OAuth.enabled_providers() == []
      refute OAuth.enabled?("google")
    end

    test "id と secret が揃った provider だけ有効になる" do
      Application.put_env(:kaoiro_server, :oauth_github_client_id, "gh-id")
      Application.put_env(:kaoiro_server, :oauth_github_client_secret, "gh-secret")
      # secret 欠けの google は有効化されない。
      Application.put_env(:kaoiro_server, :oauth_google_client_id, "g-id")

      assert OAuth.enabled_providers() == ["github"]
      assert OAuth.enabled?("github")
      refute OAuth.enabled?("google")
    end

    test "nextcloud は base_url も揃って初めて有効になる" do
      Application.put_env(:kaoiro_server, :oauth_nextcloud_client_id, "nc-id")
      Application.put_env(:kaoiro_server, :oauth_nextcloud_client_secret, "nc-secret")

      refute OAuth.enabled?("nextcloud")

      Application.put_env(:kaoiro_server, :oauth_nextcloud_base_url, "https://cloud.test")

      assert OAuth.enabled?("nextcloud")
    end

    test "未知の provider 名は常に無効" do
      refute OAuth.enabled?("facebook")
      assert OAuth.provider_names() == ["google", "github", "nextcloud"]
    end
  end

  describe "authorize_url/1" do
    test "未設定 provider は fail-closed" do
      assert {:error, :unknown_provider} = OAuth.authorize_url("nextcloud")
      assert {:error, :unknown_provider} = OAuth.authorize_url("facebook")
    end

    test "provider の authorize URL と state を返す" do
      configure_nextcloud()

      assert {:ok, %{url: url, session_params: %{state: state}}} =
               OAuth.authorize_url("nextcloud")

      assert String.starts_with?(url, "https://cloud.test/apps/oauth2/authorize?")
      assert url =~ "client_id=nc-id"
      assert url =~ URI.encode_www_form("/auth/nextcloud/callback")
      assert url =~ "state=#{state}"
      assert is_binary(state) and byte_size(state) > 16
    end

    test "redirect_uri は endpoint の url 設定から導出する" do
      configure_nextcloud()

      assert {:ok, %{url: url}} = OAuth.authorize_url("nextcloud")

      expected = KaoiroServerWeb.Endpoint.url() <> "/auth/nextcloud/callback"
      assert url =~ URI.encode_www_form(expected)
    end
  end

  describe "callback/3" do
    test "未設定 provider は fail-closed" do
      assert {:error, :unknown_provider} = OAuth.callback("nextcloud", %{}, %{state: "s"})
    end
  end

  describe "identity/2" do
    test "google は検証済み email だけを uid にする (小文字化)" do
      assert {:ok, %{provider: "google", uid: "ao@example.com"}} =
               OAuth.identity("google", %{"email" => "AO@Example.com", "email_verified" => true})
    end

    test "google は未検証 email を拒否する (許可リスト成りすまし防止)" do
      assert {:error, :no_identity} =
               OAuth.identity("google", %{"email" => "ao@example.com", "email_verified" => false})

      assert {:error, :no_identity} =
               OAuth.identity("google", %{"email" => "ao@example.com"})

      assert {:error, :no_identity} =
               OAuth.identity("google", %{"email_verified" => true})
    end

    test "github は login (preferred_username) を uid にする" do
      assert {:ok, %{provider: "github", uid: "ao"}} =
               OAuth.identity("github", %{"sub" => "42", "preferred_username" => "ao"})

      assert {:error, :no_identity} = OAuth.identity("github", %{"sub" => "42"})
    end

    test "nextcloud は user id (sub) を uid にする" do
      assert {:ok, %{provider: "nextcloud", uid: "ao"}} =
               OAuth.identity("nextcloud", %{"sub" => "ao"})

      assert {:error, :no_identity} = OAuth.identity("nextcloud", %{"sub" => ""})
    end
  end

  describe "起動経路" do
    test "設定済み provider の判定は endpoint に触らない (application 起動が壊れない)" do
      # KaoiroServer.Application.start/2 は supervision tree より前に
      # Auth.warn_token_config/0 -> OAuth.warn_config/0 を呼ぶ。そこから
      # Endpoint.url/0 に到達すると persistent term 未設定で raise し、
      # OAuth を設定した瞬間だけ起動不能になる (レビュー指摘)。別 BEAM で
      # 実際に起動させて回帰を押さえる。
      # 子 BEAM に有効 provider を印字させ、それを assert する。単に
      # booted_ok だけ見ると、env 名の変更で OAuth が無効化されても
      # green のまま = ガードが黙って空になる。
      script = "IO.puts(Enum.join(KaoiroServer.OAuth.enabled_providers(), \",\"))"

      {output, status} =
        System.cmd("mix", ["run", "--no-compile", "-e", script <> "; IO.puts(:booted_ok)"],
          env: [
            {"MIX_ENV", "test"},
            {"KAOIRO_OAUTH_GITHUB_CLIENT_ID", "gh-id"},
            {"KAOIRO_OAUTH_GITHUB_CLIENT_SECRET", "gh-secret"},
            {"KAOIRO_OAUTH_NEXTCLOUD_CLIENT_ID", "nc-id"},
            {"KAOIRO_OAUTH_NEXTCLOUD_CLIENT_SECRET", "nc-secret"},
            {"KAOIRO_OAUTH_NEXTCLOUD_BASE_URL", "https://cloud.test"}
          ],
          stderr_to_stdout: true
        )

      assert status == 0, output
      assert output =~ "booted_ok"
      assert output =~ "github,nextcloud"
    end
  end

  describe "warn_config/0" do
    test "OAuth 未設定なら何も警告しない (token のみの構成は正常)" do
      log = capture_log(fn -> assert :ok = OAuth.warn_config() end)

      refute log =~ "OAUTH"
    end

    test "provider があるのに許可リスト未設定なら警告する (fail-closed)" do
      configure_nextcloud()

      log = capture_log(fn -> assert :ok = OAuth.warn_config() end)

      assert log =~ "KAOIRO_OAUTH_ALLOWLIST_PATH unset"
      assert log =~ "nextcloud"
      assert log =~ "fail-closed"
    end

    test "許可リストだけあって provider が無ければ警告する" do
      Application.put_env(:kaoiro_server, :oauth_allowlist_path, "/tmp/allowlist")

      log = capture_log(fn -> assert :ok = OAuth.warn_config() end)

      assert log =~ "no OAuth provider is"
    end

    test "provider の設定が中途半端なら警告する" do
      Application.put_env(:kaoiro_server, :oauth_google_client_id, "g-id")

      log = capture_log(fn -> assert :ok = OAuth.warn_config() end)

      assert log =~ "KAOIRO_OAUTH_GOOGLE_* is incomplete"
    end

    test "provider と許可リストが揃っていれば警告しない" do
      configure_nextcloud()
      Application.put_env(:kaoiro_server, :oauth_allowlist_path, "/tmp/allowlist")

      log = capture_log(fn -> assert :ok = OAuth.warn_config() end)

      refute log =~ "OAUTH"
    end
  end

  defp configure_nextcloud do
    Application.put_env(:kaoiro_server, :oauth_nextcloud_client_id, "nc-id")
    Application.put_env(:kaoiro_server, :oauth_nextcloud_client_secret, "nc-secret")
    Application.put_env(:kaoiro_server, :oauth_nextcloud_base_url, "https://cloud.test/")
  end

  defp clear_env do
    Enum.each(@env_keys, &Application.delete_env(:kaoiro_server, &1))
  end
end
