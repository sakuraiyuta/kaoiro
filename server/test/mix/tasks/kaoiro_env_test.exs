defmodule Mix.Tasks.Kaoiro.EnvTest do
  use ExUnit.Case, async: false

  alias Mix.Tasks.Kaoiro.Env

  @answers %{
    secret_key_base: "s3cret",
    phx_host: "kaoiro.example.com",
    port: "",
    bind_ip: "",
    client_tokens: ["ctok:operator"],
    wrapper_tokens: ["lab-pc-1.ao:wtok"],
    runner_tokens: ["lab-pc-1:rtok"],
    persona_dir: ""
  }

  describe "generate_token/0" do
    test "32 バイト = 64 文字の hex" do
      assert Env.generate_token() =~ ~r/^[0-9a-f]{64}$/
    end

    test "呼び出しごとに異なる" do
      refute Env.generate_token() == Env.generate_token()
    end
  end

  describe "generate_secret/0" do
    test "phx.gen.secret と同じ 64 文字" do
      secret = Env.generate_secret()
      assert String.length(secret) == 64
      # hex token では短すぎるので base64 側であることを確かめる。
      refute secret =~ ~r/^[0-9a-f]+$/
    end
  end

  describe "render/1" do
    test "必須項目は素の代入として出る" do
      body = Env.render(@answers)

      assert body =~ "SECRET_KEY_BASE=s3cret"
      assert body =~ "PHX_HOST=kaoiro.example.com"
      assert String.ends_with?(body, "\n")
    end

    test "token 3 種をカンマ区切りで書く" do
      body =
        Env.render(%{
          @answers
          | client_tokens: ["a:operator", "b:viewer"],
            wrapper_tokens: ["h.ao:w1", "h.momo:w2"]
        })

      assert body =~ "KAOIRO_CLIENT_TOKENS=a:operator,b:viewer"
      assert body =~ "KAOIRO_WRAPPER_TOKENS=h.ao:w1,h.momo:w2"
      assert body =~ "KAOIRO_RUNNER_TOKENS=lab-pc-1:rtok"
    end

    test "token を集めなかった種別はコメントアウトする" do
      body = Env.render(%{@answers | runner_tokens: []})

      assert body =~ "#KAOIRO_RUNNER_TOKENS="
      refute body =~ ~r/^KAOIRO_RUNNER_TOKENS=/m
    end

    test "任意項目は空なら注記付きコメントで出す" do
      body = Env.render(@answers)

      assert body =~ "#PORT="
      assert body =~ "default 4000"
      assert body =~ "#KAOIRO_BIND_IP="
      refute body =~ ~r/^PORT=/m
    end

    test "任意項目に値があれば素の代入になる" do
      body = Env.render(%{@answers | port: "4001", bind_ip: "127.0.0.1"})

      assert body =~ "PORT=4001"
      assert body =~ "KAOIRO_BIND_IP=127.0.0.1"
      refute body =~ "#PORT="
    end

    test "DETS パスは常にコメントのみ (wizard 対象外)" do
      body = Env.render(@answers)

      assert body =~ "#KAOIRO_SESSION_POINTERS_PATH="
      assert body =~ "#KAOIRO_TOKEN_DENYLIST_PATH="
      refute body =~ ~r/^KAOIRO_[A-Z_]*_PATH=/m
    end

    test "fail-closed / fail-open の違いを注意書きに残す" do
      body = Env.render(@answers)

      assert body =~ "fail-closed"
      assert body =~ "issue #138"
      assert body =~ "CLIENT token unset"
    end

    test "OAuth を設定しない場合は従来の .env 本文のまま" do
      without_oauth = Env.render(@answers)
      no_provider_enabled = Env.render(Map.put(@answers, :oauth, nil))

      all_providers_disabled =
        Env.render(Map.put(@answers, :oauth, %{providers: [], allowlist_entries: []}))

      assert no_provider_enabled == without_oauth
      assert all_providers_disabled == without_oauth
      refute no_provider_enabled =~ "KAOIRO_OAUTH_"
      refute no_provider_enabled =~ "Dashboard OAuth"
    end

    test "有効にした provider だけ OAuth 環境変数へ書く" do
      body =
        Env.render(
          Map.put(@answers, :oauth, %{
            providers: [
              %{provider: "google", client_id: "google-id", client_secret: "google-secret"},
              %{
                provider: "nextcloud",
                client_id: "nextcloud-id",
                client_secret: "nextcloud-secret",
                base_url: "https://cloud.example.com"
              }
            ],
            allowlist_entries: ["google:master@example.com:operator"]
          })
        )

      assert body =~ "KAOIRO_OAUTH_GOOGLE_CLIENT_ID=google-id"
      assert body =~ "KAOIRO_OAUTH_GOOGLE_CLIENT_SECRET=google-secret"
      assert body =~ "KAOIRO_OAUTH_NEXTCLOUD_CLIENT_ID=nextcloud-id"
      assert body =~ "KAOIRO_OAUTH_NEXTCLOUD_CLIENT_SECRET=nextcloud-secret"
      assert body =~ "KAOIRO_OAUTH_NEXTCLOUD_BASE_URL=https://cloud.example.com"
      assert body =~ "KAOIRO_OAUTH_ALLOWLIST_PATH=/etc/kaoiro/oauth-allowlist.txt"
      assert body =~ "OAuth login is enabled; access follows the allow-list"
      refute body =~ "KAOIRO_OAUTH_GITHUB_CLIENT_ID="
    end
  end

  describe "render_allowlist/1" do
    test "書式コメント付きの許可リストを生成する" do
      body =
        Env.render_allowlist([
          "google:master@example.com:operator",
          "github:ao"
        ])

      assert body =~ "# One entry per line: provider:identifier[:role]"
      assert body =~ "# role: viewer | operator (optional; defaults to viewer)"
      assert body =~ "google:master@example.com:operator"
      assert body =~ "github:ao"
      assert String.ends_with?(body, "\n")
    end
  end

  describe "interactive OAuth setup" do
    setup do
      original_shell = Mix.shell()
      Mix.shell(Mix.Shell.Process)

      on_exit(fn -> Mix.shell(original_shell) end)

      :ok
    end

    test "OAuth の .env と allowlist を生成し、secret を出力へ再表示しない" do
      dir = Path.join(System.tmp_dir!(), "kaoiro_env_test_#{System.unique_integer([:positive])}")
      env_path = Path.join(dir, ".env")
      allowlist_path = Path.join(dir, "oauth-allowlist.txt")
      File.mkdir_p!(dir)

      on_exit(fn -> File.rm_rf!(dir) end)

      [
        "",
        "kaoiro.example.com",
        "",
        "",
        "n",
        "n",
        "n",
        "",
        "y",
        "n",
        "y",
        "github-id",
        "github-secret",
        "n",
        "github:ao",
        "n"
      ]
      |> Enum.each(&send(self(), {:mix_shell_input, :prompt, &1}))

      Env.run(["--path", env_path])

      env = File.read!(env_path)
      allowlist = File.read!(allowlist_path)
      output = shell_output()

      assert env =~ "KAOIRO_OAUTH_GITHUB_CLIENT_ID=github-id"
      assert env =~ "KAOIRO_OAUTH_GITHUB_CLIENT_SECRET=github-secret"
      assert env =~ "KAOIRO_OAUTH_ALLOWLIST_PATH=/etc/kaoiro/oauth-allowlist.txt"
      refute env =~ "KAOIRO_OAUTH_GOOGLE_CLIENT_ID="
      assert allowlist =~ "github:ao"
      assert Bitwise.band(File.stat!(env_path).mode, 0o777) == 0o600
      assert Bitwise.band(File.stat!(allowlist_path).mode, 0o777) == 0o600
      assert output =~ "Keep #{allowlist_path} out of git"
      assert output =~ "- #{allowlist_path}:/etc/kaoiro/oauth-allowlist.txt:ro"
      assert output =~ "docs/specs/deployment.md section 1.6"
      refute output =~ "plain-HTTP deployment"
      refute output =~ "github-secret"
    end

    test "既定の相対パスでは compose mount と OAuth の次の手順を正しく出す" do
      dir = Path.join(System.tmp_dir!(), "kaoiro_env_test_#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)

      on_exit(fn -> File.rm_rf!(dir) end)

      File.cd!(dir, fn ->
        [
          "",
          "kaoiro.example.com",
          "",
          "",
          "n",
          "n",
          "n",
          "",
          "y",
          "n",
          "y",
          "github-id",
          "github-secret",
          "n",
          "github:ao",
          "n"
        ]
        |> Enum.each(&send(self(), {:mix_shell_input, :prompt, &1}))

        Env.run([])

        assert File.exists?(".env")
        assert File.exists?("oauth-allowlist.txt")

        assert shell_output() =~ """
               Next:
                 1. Review .env (tokens and OAuth secrets are in plain text — keep it out of git).
                 2. Keep ./oauth-allowlist.txt out of git, then add this read-only mount under
                    docker-compose.yaml's service `volumes:`:
                      - ./oauth-allowlist.txt:/etc/kaoiro/oauth-allowlist.txt:ro
                 3. Register each provider's redirect URI in its console; see
                    docs/specs/deployment.md section 1.6.
                 4. Start the stack: docker compose up -d --build
                 5. On each agent host, run the runner wizard
                    (deploy/kaoiro-runner-setup.sh) and pair its token with the
                    KAOIRO_RUNNER_TOKENS entry above.
               Deployment details live in the runbook (issue #142).
               """
      end)
    end

    test "既存 allowlist の上書きを断ると内容を保ち、Google の注意を出す" do
      dir = Path.join(System.tmp_dir!(), "kaoiro_env_test_#{System.unique_integer([:positive])}")
      env_path = Path.join(dir, ".env")
      allowlist_path = Path.join(dir, "oauth-allowlist.txt")
      original_allowlist = "github:existing:operator\n"
      File.mkdir_p!(dir)
      File.write!(allowlist_path, original_allowlist)

      on_exit(fn -> File.rm_rf!(dir) end)

      [
        "",
        "kaoiro.example.com",
        "",
        "",
        "n",
        "n",
        "n",
        "",
        "y",
        "y",
        "google-id",
        "google-secret",
        "n",
        "n",
        "google:master@example.com:operator",
        "n",
        "n"
      ]
      |> Enum.each(&send(self(), {:mix_shell_input, :prompt, &1}))

      Env.run(["--path", env_path])

      output = shell_output()

      assert File.read!(allowlist_path) == original_allowlist
      assert Bitwise.band(File.stat!(env_path).mode, 0o777) == 0o600
      assert output =~ "Kept #{allowlist_path}; existing OAuth allow-list unchanged."
      assert output =~ "Google OAuth cannot be used on a plain-HTTP deployment"
      assert output =~ "- #{allowlist_path}:/etc/kaoiro/oauth-allowlist.txt:ro"

      assert output =~ """
             Next:
               1. Review #{env_path} (tokens and OAuth secrets are in plain text — keep it out of git).
               2. Keep #{allowlist_path} out of git, then add this read-only mount under
                  docker-compose.yaml's service `volumes:`:
                    - #{allowlist_path}:/etc/kaoiro/oauth-allowlist.txt:ro
               3. Register each provider's redirect URI in its console; see
                  docs/specs/deployment.md section 1.6.
               4. Google OAuth cannot be used on a plain-HTTP deployment (localhost is the exception).
               5. Start the stack: docker compose up -d --build
               6. On each agent host, run the runner wizard
                  (deploy/kaoiro-runner-setup.sh) and pair its token with the
                  KAOIRO_RUNNER_TOKENS entry above.
             Deployment details live in the runbook (issue #142).
             """
    end

    test "OAuth をスキップすると従来の生成物と次の手順を保つ" do
      dir = Path.join(System.tmp_dir!(), "kaoiro_env_test_#{System.unique_integer([:positive])}")
      env_path = Path.join(dir, ".env")
      File.mkdir_p!(dir)

      on_exit(fn -> File.rm_rf!(dir) end)

      ["n", "s3cret", "kaoiro.example.com", "", "", "n", "n", "n", "", "n"]
      |> Enum.each(&send(self(), {:mix_shell_input, :prompt, &1}))

      Env.run(["--path", env_path])

      assert File.read!(env_path) ==
               Env.render(%{
                 secret_key_base: "s3cret",
                 phx_host: "kaoiro.example.com",
                 port: "",
                 bind_ip: "",
                 client_tokens: [],
                 wrapper_tokens: [],
                 runner_tokens: [],
                 persona_dir: ""
               })

      refute File.exists?(Path.join(dir, "oauth-allowlist.txt"))
      assert Bitwise.band(File.stat!(env_path).mode, 0o777) == 0o600

      assert shell_output() =~ """
             Next:
               1. Review #{env_path} (tokens are in plain text — keep it out of git).
               2. Start the stack: docker compose up -d --build
               3. On each agent host, run the runner wizard
                  (deploy/kaoiro-runner-setup.sh) and pair its token with the
                  KAOIRO_RUNNER_TOKENS entry above.
             Deployment details live in the runbook (issue #142).
             """
    end
  end

  defp shell_output(messages \\ []) do
    receive do
      {:mix_shell, _kind, [message]} when is_binary(message) ->
        shell_output([message | messages])
    after
      0 -> messages |> Enum.reverse() |> Enum.join("\n")
    end
  end
end
