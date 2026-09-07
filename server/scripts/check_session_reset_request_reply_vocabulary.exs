wrapper_reasons =
  System.fetch_env!("KAOIRO_SESSION_RESET_REQUEST_REPLY_REASONS")
  |> Jason.decode!()
  |> MapSet.new()

server_reasons =
  KaoiroServer.SessionResetRequestReplyReasons.values()
  |> MapSet.new()

wrapper_only = MapSet.difference(wrapper_reasons, server_reasons) |> MapSet.to_list() |> Enum.sort()
server_only = MapSet.difference(server_reasons, wrapper_reasons) |> MapSet.to_list() |> Enum.sort()

IO.puts("wrapper reasons: #{inspect(wrapper_reasons |> MapSet.to_list() |> Enum.sort())}")
IO.puts("server reasons: #{inspect(server_reasons |> MapSet.to_list() |> Enum.sort())}")
IO.puts("wrapper-only reasons: #{inspect(wrapper_only)}")
IO.puts("server-only reasons: #{inspect(server_only)}")

if wrapper_only != [] or server_only != [] do
  raise "session_reset_request reply vocabulary drift"
end
