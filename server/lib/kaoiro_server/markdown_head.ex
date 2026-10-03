defmodule KaoiroServer.MarkdownHead do
  @moduledoc """
  The server-side "head" of a markdown text: the longest prefix made of whole
  graphemes that fits in `max_bytes` (issue 482 design r4 section 2).

  The cut is computed once, on the server, when the text is committed, and the
  result travels with the text. Clients never cut it again, so a server and a
  dashboard on different Unicode versions cannot disagree on where it ends.
  `bytes` (the size of the full text) is `byte_size(text)` and is the caller's
  to report.

  A grapheme boundary is also a code point boundary, so the head is valid
  UTF-8 and never splits a user-perceived character. When even the first
  grapheme does not fit (for example a base character followed by hundreds of
  combining marks) the head is `""` and `truncated` is true.
  """

  @doc """
  `{head, truncated}`. `text` must be valid UTF-8 (`MarkdownText.validate/2`
  guarantees it); anything else raises `ArgumentError`.
  """
  @spec cut(String.t(), pos_integer()) :: {String.t(), boolean()}
  def cut(text, max_bytes) when is_binary(text) and is_integer(max_bytes) and max_bytes > 0 do
    if not String.valid?(text), do: raise(ArgumentError, "text is not valid UTF-8")

    if byte_size(text) <= max_bytes do
      {text, false}
    else
      {prefix(text, max_bytes, 0, []), true}
    end
  end

  defp prefix(text, max_bytes, used, kept) do
    case String.next_grapheme(text) do
      {grapheme, rest} when used + byte_size(grapheme) <= max_bytes ->
        prefix(rest, max_bytes, used + byte_size(grapheme), [grapheme | kept])

      _ ->
        kept |> Enum.reverse() |> IO.iodata_to_binary()
    end
  end
end
