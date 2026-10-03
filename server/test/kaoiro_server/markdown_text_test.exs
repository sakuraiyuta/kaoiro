defmodule KaoiroServer.MarkdownTextTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.MarkdownText

  @max 16_384

  defp validate(input), do: MarkdownText.validate(input, @max)

  describe "size" do
    test "exactly the limit is accepted and one byte more is rejected with its size" do
      at_limit = String.duplicate("a", @max)

      assert {:ok, {:set, ^at_limit}} = validate(at_limit)
      assert {:error, {:too_large, 16_385}} = validate(at_limit <> "a")
    end

    # Negative control against counting graphemes or code points: 5,462
    # characters of three bytes each are 16,386 bytes.
    test "multibyte text is counted in bytes" do
      fits = String.duplicate("あ", 5_461) <> "a"
      too_big = String.duplicate("あ", 5_462)

      assert byte_size(fits) == @max
      assert {:ok, {:set, ^fits}} = validate(fits)

      assert String.length(too_big) == 5_462
      assert {:error, {:too_large, 16_386}} = validate(too_big)
    end

    test "the limit applies to the stored form, after trimming" do
      padded = String.duplicate(" ", @max + 10) <> "a" <> String.duplicate("\n", 10)

      assert {:ok, {:set, "a"}} = validate(padded)
    end

    test "the limit applies after line endings are normalized" do
      crlf = String.duplicate("a\r\n", 8_000)

      assert byte_size(crlf) == 24_000
      assert {:ok, {:set, stored}} = validate(crlf)
      assert stored == String.duplicate("a\n", 7_999) <> "a"
    end

    test "the caller chooses the limit" do
      assert {:ok, {:set, "0123456789"}} = MarkdownText.validate("0123456789", 10)
      assert {:error, {:too_large, 11}} = MarkdownText.validate("01234567890", 10)
    end
  end

  describe "line endings" do
    test "CRLF and a lone CR are stored as LF" do
      assert {:ok, {:set, "a\nb\nc"}} = validate("a\r\nb\rc")
    end

    test "CR CR LF is two line breaks, not one" do
      assert {:ok, {:set, "a\n\nb"}} = validate("a\r\r\nb")
    end
  end

  describe "controls" do
    test "newline and tab are accepted, so multi-line markdown can be stored" do
      text = "# Title\n\n- item\n\n\tcode"

      assert {:ok, {:set, ^text}} = validate(text)
    end

    test "NUL, backspace, escape, unit separator and DEL are each rejected" do
      for control <- ["\x00", "\x08", "\e", "\x1f", "\x7f"] do
        assert {:error, :invalid_characters} = validate("a" <> control <> "b"),
               "expected #{inspect(control)} to be rejected"
      end
    end

    # The scan runs before the trim. If it ran after, an edge VT or FF would be
    # stripped and the text accepted, and a string of them alone would become a
    # clear.
    test "vertical tab and form feed are rejected at the edge, alone and inside" do
      for text <- ["\vhello", "hello\v", "\fhello\f", "\v", "\f", "\v\f", "he\vllo", " \v "] do
        assert {:error, :invalid_characters} = validate(text),
               "expected #{inspect(text)} to be rejected"
      end
    end
  end

  describe "clear" do
    test "empty and whitespace-only input is a clear" do
      for text <- ["", " ", "\n", "\t", " \n\t \r\n ", "\u{00A0}", "\u{3000}"] do
        assert {:ok, :clear} = validate(text), "expected #{inspect(text)} to clear"
      end
    end

    test "stored text is the trimmed value" do
      assert {:ok, {:set, "hi\n\nthere"}} = validate("  \n hi\n\nthere \n\t")
    end
  end

  describe "invalid input" do
    test "anything that is not a binary is invalid" do
      for input <- [nil, 1, :text, ["a"], %{"text" => "a"}] do
        assert {:error, :invalid} = validate(input)
      end
    end

    test "a binary that is not UTF-8 is invalid" do
      assert {:error, :invalid} = validate(<<0xFF, 0xFE>>)
      assert {:error, :invalid} = validate("ok" <> <<0xC3>>)
    end

    test "invalid UTF-8 is reported as such before a control is looked for" do
      assert {:error, :invalid} = validate(<<0xFF, 0>>)
    end
  end
end
