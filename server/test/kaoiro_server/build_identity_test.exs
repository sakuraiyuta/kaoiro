defmodule KaoiroServer.BuildIdentityTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.BuildIdentity

  describe "valid_revision?/1" do
    test "literal \"unknown\" は valid" do
      assert BuildIdentity.valid_revision?("unknown")
    end

    test "ロワーケース 40 桁 hex は valid" do
      assert BuildIdentity.valid_revision?("0123456789abcdef0123456789abcdef01234567")
    end

    test "アッパーケースは invalid (ロワーケース限定)" do
      refute BuildIdentity.valid_revision?("0123456789ABCDEF0123456789ABCDEF01234567")
    end

    test "39 桁 (短すぎ) は invalid" do
      refute BuildIdentity.valid_revision?("0123456789abcdef0123456789abcdef0123456")
    end

    test "41 桁 (長すぎ) は invalid" do
      refute BuildIdentity.valid_revision?("0123456789abcdef0123456789abcdef012345678")
    end

    test "16進以外の文字を含むと invalid" do
      refute BuildIdentity.valid_revision?("gggggggggggggggggggggggggggggggggggggggg")
    end

    test "空文字は invalid" do
      refute BuildIdentity.valid_revision?("")
    end

    test "文字列以外は invalid" do
      refute BuildIdentity.valid_revision?(nil)
      refute BuildIdentity.valid_revision?(12_345)
      refute BuildIdentity.valid_revision?(true)
    end
  end

  describe "valid_version?/1" do
    test "CalVer YYYY.M.PATCH は valid" do
      assert BuildIdentity.valid_version?("2026.9.0")
    end

    test "accepts a six-digit patch and rejects a seven-digit patch" do
      assert BuildIdentity.valid_version?("2026.9.123456")
      refute BuildIdentity.valid_version?("2026.9.1234567")
    end

    test "the current project version is valid" do
      version = Path.expand("../../../VERSION", __DIR__) |> File.read!() |> String.trim()

      assert BuildIdentity.valid_version?(version)
    end

    test "unknown は build identity の fail-soft 値として valid" do
      assert BuildIdentity.valid_version?("unknown")
    end

    test "月 0 / 13 は invalid" do
      refute BuildIdentity.valid_version?("2026.0.0")
      refute BuildIdentity.valid_version?("2026.13.0")
    end

    test "文字列以外は invalid" do
      refute BuildIdentity.valid_version?(nil)
      refute BuildIdentity.valid_version?(2026)
    end
  end

  describe "valid_channel?/1" do
    test "dev と release は valid" do
      assert BuildIdentity.valid_channel?("dev")
      assert BuildIdentity.valid_channel?("release")
    end

    test "それ以外は invalid" do
      refute BuildIdentity.valid_channel?("main")
      refute BuildIdentity.valid_channel?(nil)
    end
  end

  describe "valid_identity?/4" do
    test "clean known release is valid" do
      assert BuildIdentity.valid_identity?(
               "0123456789abcdef0123456789abcdef01234567",
               false,
               "2026.9.0",
               "release"
             )
    end

    test "release with unknown revision or dirty state is invalid" do
      refute BuildIdentity.valid_identity?("unknown", false, "2026.9.0", "release")

      refute BuildIdentity.valid_identity?(
               "0123456789abcdef0123456789abcdef01234567",
               true,
               "2026.9.0",
               "release"
             )
    end

    test "dev permits diagnostic unknown/dirty values" do
      assert BuildIdentity.valid_identity?("unknown", true, "unknown", "dev")
    end
  end
end
