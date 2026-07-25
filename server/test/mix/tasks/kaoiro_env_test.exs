defmodule Mix.Tasks.Kaoiro.EnvTest do
  use ExUnit.Case, async: true

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
    end
  end
end
