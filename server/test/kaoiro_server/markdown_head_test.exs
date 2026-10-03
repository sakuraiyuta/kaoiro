defmodule KaoiroServer.MarkdownHeadTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.MarkdownHead

  @max 512

  defp cut(text), do: MarkdownHead.cut(text, @max)

  describe "when the text fits" do
    test "512 bytes is returned whole and is not truncated" do
      text = String.duplicate("a", 512)

      assert {^text, false} = cut(text)
    end

    test "an empty text is returned whole" do
      assert {"", false} = cut("")
    end
  end

  describe "when it does not fit" do
    test "513 bytes is truncated to 512" do
      text = String.duplicate("a", 513)

      assert {head, true} = cut(text)
      assert head == String.duplicate("a", 512)
    end

    # 171 characters of three bytes are 513 bytes; 170 of them are 510.
    test "a multibyte text is cut on a character boundary" do
      text = String.duplicate("あ", 171)

      assert byte_size(text) == 513
      assert {head, true} = cut(text)
      assert head == String.duplicate("あ", 170)
      assert byte_size(head) == 510
    end

    # Negative control against cutting by code points: "e" would fit in the
    # remaining byte, but its combining mark would not, so the cluster is
    # excluded whole.
    test "a combining sequence straddling the limit is excluded whole" do
      text = String.duplicate("a", 511) <> "e\u{0301}" <> "tail"

      assert {head, true} = cut(text)
      assert head == String.duplicate("a", 511)
    end

    test "a ZWJ emoji family straddling the limit is excluded whole" do
      family = "👨‍👩‍👧‍👦"
      text = String.duplicate("a", 500) <> family <> "tail"

      assert byte_size(family) == 25
      assert String.length(family) == 1
      assert {head, true} = cut(text)
      assert head == String.duplicate("a", 500)
    end

    test "a grapheme that ends exactly on the limit is kept" do
      text = String.duplicate("a", 509) <> "あ" <> "tail"

      assert {head, true} = cut(text)
      assert byte_size(head) == 512
      assert String.ends_with?(head, "あ")
    end

    test "a first grapheme larger than the limit gives an empty head" do
      one_grapheme = "e" <> String.duplicate("\u{0301}", 300)

      assert String.length(one_grapheme) == 1
      assert byte_size(one_grapheme) > @max
      assert {"", true} = cut(one_grapheme)
    end

    test "every head is valid UTF-8 and within the limit" do
      corpus = [
        String.duplicate("あ", 400),
        String.duplicate("e\u{0301}", 400),
        String.duplicate("😀", 200),
        String.duplicate("👨‍👩‍👧‍👦", 40),
        String.duplicate("a", 1_000) <> "あ",
        "# Title\n\n" <> String.duplicate("- item\n", 200)
      ]

      for text <- corpus do
        assert {head, true} = cut(text)
        assert String.valid?(head)
        assert byte_size(head) <= @max
        assert String.starts_with?(text, head)
      end
    end
  end

  test "the caller chooses the limit" do
    assert {"abcde", true} = MarkdownHead.cut("abcdefgh", 5)
    assert {"abcdefgh", false} = MarkdownHead.cut("abcdefgh", 8)
  end

  test "text that is not valid UTF-8 is refused instead of cut" do
    assert_raise ArgumentError, fn -> MarkdownHead.cut("ok" <> <<0xC3>>, @max) end
  end
end
