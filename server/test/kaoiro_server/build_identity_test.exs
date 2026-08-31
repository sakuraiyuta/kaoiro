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
end
