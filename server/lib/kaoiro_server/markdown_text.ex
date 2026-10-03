defmodule KaoiroServer.MarkdownText do
  @moduledoc """
  The one validation order for operator- and agent-authored markdown text
  (issue 482 design r5 section 3). It is shared by every store that accepts
  such text, so the order cannot drift between them.

  `validate/2` runs, in this order:

    1. not a binary, or not valid UTF-8 -> `{:error, :invalid}`;
    2. `\\r\\n` and a lone `\\r` become `\\n`;
    3. a C0 control other than `\\n` and `\\t`, or DEL ->
       `{:error, :invalid_characters}`;
    4. `String.trim/1`; an empty result is `{:ok, :clear}`;
    5. more than `max_bytes` bytes -> `{:error, {:too_large, bytes}}`.

  The control scan (3) runs BEFORE the trim (4). Trimming first would let a
  vertical tab or form feed at an edge be stripped and the rest accepted, or
  turn a string made only of them into a clear. The size check (5) applies to
  the stored form, after normalization and trimming, and counts bytes: a
  grapheme or code point count would admit a 4x larger multibyte text.

  Success returns the stored form: `{:ok, {:set, text}}` for text, and
  `{:ok, :clear}` when nothing is left. Callers translate the error atoms into
  their own wire codes.
  """

  @control_characters ~r/[\x00-\x08\x0b-\x1f\x7f]/

  @type error :: :invalid | :invalid_characters | {:too_large, pos_integer()}

  @spec validate(term(), pos_integer()) ::
          {:ok, {:set, String.t()}} | {:ok, :clear} | {:error, error()}
  def validate(input, max_bytes) when is_integer(max_bytes) and max_bytes > 0 do
    with :ok <- check_utf8(input),
         normalized = normalize_line_endings(input),
         :ok <- check_controls(normalized) do
      normalized
      |> String.trim()
      |> check_size(max_bytes)
    end
  end

  defp check_utf8(input) when is_binary(input) do
    if String.valid?(input), do: :ok, else: {:error, :invalid}
  end

  defp check_utf8(_input), do: {:error, :invalid}

  defp normalize_line_endings(text), do: String.replace(text, ["\r\n", "\r"], "\n")

  defp check_controls(text) do
    if Regex.match?(@control_characters, text), do: {:error, :invalid_characters}, else: :ok
  end

  defp check_size("", _max_bytes), do: {:ok, :clear}

  defp check_size(text, max_bytes) do
    case byte_size(text) do
      bytes when bytes > max_bytes -> {:error, {:too_large, bytes}}
      _ -> {:ok, {:set, text}}
    end
  end
end
