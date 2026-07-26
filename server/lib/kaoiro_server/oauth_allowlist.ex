defmodule KaoiroServer.OAuthAllowlist do
  @moduledoc """
  Authorization allow-list for the dashboard's OAuth logins (ADR-0042).

  A plain text file whose path comes from `KAOIRO_OAUTH_ALLOWLIST_PATH`
  (`:oauth_allowlist_path`). One entry per line:

      provider:identifier[:role]

  - `provider` — `google` | `github` | `nextcloud`
  - `identifier` — google: e-mail (compared lower-cased), github: login,
    nextcloud: user id (both compared verbatim)
  - `role` — `viewer` | `operator`, optional, defaults to `viewer`
    (the safe side)

  Blank lines and lines whose first non-blank character is `#` are
  ignored. There is no trailing-comment syntax: a `#` anywhere else is
  part of the entry, and the resulting entry is almost certainly
  malformed — which is reported rather than silently dropped.

  The file is re-read on every lookup, with no caching. That mirrors the
  env token lists (`KaoiroServer.Auth`): removing a line takes effect at
  the target's next `connect` / `refresh` instead of needing a restart.

  Fail-closed at every step — an unset path, an unreadable file, or an
  identity with no matching entry all resolve to `nil` (no role, so no
  access). Malformed lines are skipped with a warning (fail-visible)
  rather than aborting the whole file, so one bad line cannot lock every
  other operator out.
  """

  require Logger

  alias KaoiroServer.OAuth

  @roles %{"viewer" => :viewer, "operator" => :operator}

  @doc """
  Resolves an OAuth identity to its role, or `nil` when it is not on the
  allow-list (which is also what an unset/unreadable allow-list yields).
  """
  @spec role_for(binary(), binary()) :: :viewer | :operator | nil
  def role_for(provider, identifier)
      when is_binary(provider) and is_binary(identifier) and identifier != "" do
    Map.get(entries(), {provider, normalize(provider, identifier)})
  end

  def role_for(_provider, _identifier), do: nil

  @doc """
  Whether an allow-list path is configured at all. Used for the startup
  warning — a configured OAuth provider without an allow-list can
  authenticate nobody.
  """
  @spec configured? :: boolean()
  def configured? do
    case path() do
      p when is_binary(p) and p != "" -> true
      _ -> false
    end
  end

  # Google e-mails are case-insensitive in practice, so both sides are
  # lower-cased. The other two identifiers are compared verbatim: a case
  # mismatch there denies access (fail-closed and visible to the
  # operator) instead of widening the match.
  defp normalize("google", identifier), do: String.downcase(identifier)
  defp normalize(_provider, identifier), do: identifier

  defp path, do: Application.get_env(:kaoiro_server, :oauth_allowlist_path)

  defp entries do
    case path() do
      p when is_binary(p) and p != "" -> read(p)
      _ -> %{}
    end
  end

  defp read(path) do
    case File.read(path) do
      {:ok, contents} ->
        parse(contents)

      {:error, reason} ->
        Logger.warning(
          "OAuth allow-list unreadable (#{inspect(reason)}): every OAuth " <>
            "login is rejected. Check KAOIRO_OAUTH_ALLOWLIST_PATH."
        )

        %{}
    end
  end

  defp parse(contents) do
    contents
    |> String.split(["\r\n", "\n"])
    |> Enum.with_index(1)
    |> Enum.reduce(%{}, fn {line, lineno}, acc -> put_line(acc, line, lineno) end)
  end

  defp put_line(acc, line, lineno) do
    case String.trim(line) do
      "" -> acc
      "#" <> _comment -> acc
      entry -> put_entry(acc, fields(entry), lineno)
    end
  end

  # Each field is trimmed, not just the line: `github: ao` must resolve to
  # the identifier "ao". Storing the padded form instead would build an
  # entry that `role_for/2` can never match while logging nothing —
  # the silent dead entry this module exists to make visible. Mirrors
  # `Auth.parse_pairs/1`, which trims each side of its token pairs too.
  defp fields(entry), do: entry |> String.split(":") |> Enum.map(&String.trim/1)

  defp put_entry(acc, [provider, identifier], lineno),
    do: put_entry(acc, [provider, identifier, "viewer"], lineno)

  defp put_entry(acc, [provider, identifier, role], lineno) do
    with true <- provider in OAuth.provider_names(),
         true <- identifier != "",
         {:ok, role} <- Map.fetch(@roles, role) do
      Map.put(acc, {provider, normalize(provider, identifier)}, role)
    else
      _ -> skip(acc, lineno)
    end
  end

  defp put_entry(acc, _fields, lineno), do: skip(acc, lineno)

  # The entry itself is kept out of the log: it carries the operator's
  # e-mail / account name, and the line number is enough to fix it.
  defp skip(acc, lineno) do
    Logger.warning("ignoring malformed OAuth allow-list entry on line #{lineno}")
    acc
  end
end
