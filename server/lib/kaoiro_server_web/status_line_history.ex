defmodule KaoiroServerWeb.StatusLineHistory do
  @moduledoc """
  The `status_line_history` reply (issue 482 design r3 D5, r5 section 6).

  A change log holds at most 100 entries of at most 16 KiB, and JSON at most
  doubles an ASCII text, so the largest legal reply is about 3.3 MB against a
  transport budget of 8 MB. The runtime check below is a backstop for the day
  either constant is raised without the other: an oversized reply is refused
  with `status_line_history_too_large` instead of being cut or dropped by the
  transport.
  """

  alias KaoiroServer.{StatusLineWire, TransportLimits}

  @spec reply([map()], (String.t(), map() -> boolean())) ::
          {:ok, map()} | {:error, :status_line_history_too_large}
  def reply(entries, fits? \\ &TransportLimits.reply_frame_fits?/2) do
    reply = %{"entries" => Enum.map(entries, &StatusLineWire.history_entry/1)}

    if fits?.("agents:lobby", reply),
      do: {:ok, reply},
      else: {:error, :status_line_history_too_large}
  end
end
