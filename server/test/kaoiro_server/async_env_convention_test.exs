defmodule KaoiroServer.AsyncEnvConventionTest do
  @moduledoc """
  Forbids an `async: true` test module from writing the process-global
  environment (issue #417).

  ExUnit runs async modules concurrently and starts the sync ones only after
  every async module has finished (ExUnit 1.20.1, `ExUnit.Runner`). A write
  to the Application or OS environment from an async module is therefore
  visible to every other async module running at that moment:
  `ConversationStatesTest` left `inter_agent: [tombstone_ttl_ms: 1]` in place
  while `QuagmireSettingsTest` validated against it. A module that has to
  write the global environment is declared `async: false`.

  ## What is recognised

  The scan reads every `test/**/*_test.exs`, one `defmodule` at a time (a
  nested module is judged on its own). An env write is matched on the
  function NAME (`put_env`, `put_all_env`, `delete_env`, `set_env`,
  `unset_env`, `putenv`, `unsetenv`), whatever qualifies the call, so an
  alias or the `:os` / `:application` spelling does not walk past. A module
  is async when a `use ..., async: true` option says so, whichever case
  template it uses. An `async:` value that is not a literal boolean cannot
  be decided and is treated as async.

  ## Not covered

    * Calls built at run time (`apply/3`), `use` options passed as a
      variable, and a case template that forces `async` itself.
    * Other process-global state: `:persistent_term` (three production
      modules write it), `Logger.configure/1`, global Phoenix.PubSub topics.
    * Writes made through a helper under `test/support`, such as
      `OAuthAllowlistFixture.put_allowlist/1`. No async module calls one.
  """
  use ExUnit.Case, async: true

  @env_writers [:put_env, :put_all_env, :delete_env, :set_env, :unset_env, :putenv, :unsetenv]

  @roots ["test"]

  describe "the scan" do
    # Pinned on INLINE sources, never by planting a violating file under
    # test/: a real violation would leave the suite permanently red.
    test "reports Application.put_env in an async module" do
      source = """
      defmodule T do
        use ExUnit.Case, async: true

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert [{"inline", "T", 5, :put_env, :async}] = violations_in_source(source)
    end

    for {call, name} <- [
          {"Application.put_all_env([kaoiro_server: [k: 1]])", :put_all_env},
          {"Application.delete_env(:kaoiro_server, :k)", :delete_env},
          {"System.put_env(\"K\", \"1\")", :put_env},
          {"System.delete_env(\"K\")", :delete_env},
          {":application.set_env(:kaoiro_server, :k, 1)", :set_env},
          {":application.unset_env(:kaoiro_server, :k)", :unset_env},
          {":os.putenv(~c\"K\", ~c\"1\")", :putenv},
          {":os.unsetenv(~c\"K\")", :unsetenv}
        ] do
      test "reports #{call}" do
        source = """
        defmodule T do
          use ExUnit.Case, async: true

          test "x" do
            #{unquote(call)}
          end
        end
        """

        name = unquote(name)
        assert [{"inline", "T", 5, ^name, :async}] = violations_in_source(source)
      end
    end

    test "an aliased qualifier does not walk past it" do
      source = """
      defmodule T do
        use ExUnit.Case, async: true
        alias Application, as: App

        test "x" do
          App.put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert [{_, "T", 6, :put_env, :async}] = violations_in_source(source)
    end

    test "a bare imported call is reported" do
      source = """
      defmodule T do
        use ExUnit.Case, async: true
        import Application, only: [put_env: 3]

        test "x" do
          put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert [{_, "T", 6, :put_env, :async}] = violations_in_source(source)
    end

    test "a function capture is reported" do
      source = """
      defmodule T do
        use ExUnit.Case, async: true

        test "x" do
          Enum.each([1], &Application.put_env(:kaoiro_server, :k, &1))
          writer = &Application.put_env/3
          writer.(:kaoiro_server, :k, 1)
        end
      end
      """

      assert [{_, "T", 5, :put_env, :async}, {_, "T", 6, :put_env, :async}] =
               violations_in_source(source)
    end

    test "a sync module may write the environment" do
      source = """
      defmodule T do
        use ExUnit.Case, async: false

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end

      defmodule U do
        use ExUnit.Case

        test "x" do
          System.put_env("K", "1")
        end
      end
      """

      assert violations_in_source(source) == []
    end

    test "an async module that only mentions an env write is clean" do
      source = """
      defmodule T do
        @moduledoc "Application.put_env(:kaoiro_server, :k, 1) is out of bounds."
        use ExUnit.Case, async: true

        # Application.delete_env(:kaoiro_server, :k) is not called here either.
        test "x" do
          assert Application.get_env(:kaoiro_server, :k) == nil
          assert System.get_env("K") == nil
        end
      end
      """

      assert violations_in_source(source) == []
    end

    test "a case template's async option counts" do
      source = """
      defmodule T do
        use KaoiroServerWeb.ConnCase, async: true

        test "x", %{conn: _conn} do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert [{_, "T", 5, :put_env, :async}] = violations_in_source(source)
    end

    test "async next to other options still counts" do
      source = """
      defmodule T do
        use ExUnit.Case, async: true, group: :x

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end

      defmodule U do
        use ExUnit.Case, [group: :x, async: true]

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert [{_, "T", 5, :put_env, :async}, {_, "U", 13, :put_env, :async}] =
               violations_in_source(source)
    end

    test "an async value that cannot be read is reported as undecided" do
      source = """
      defmodule T do
        use ExUnit.Case, async: @flag

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert [{_, "T", 5, :put_env, :unknown}] = violations_in_source(source)
    end

    test "an undecided async module that writes nothing is clean" do
      source = """
      defmodule T do
        use ExUnit.Case, async: @flag

        test "x", do: assert(true)
      end
      """

      assert violations_in_source(source) == []
    end

    test "a literal async: false next to other options is sync" do
      source = """
      defmodule T do
        use ExUnit.Case, async: false, group: :x

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert violations_in_source(source) == []
    end

    test "each module of a file is judged on its own" do
      sync_writer_then_async_reader = """
      defmodule Writer do
        use ExUnit.Case, async: false

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end

      defmodule Reader do
        use ExUnit.Case, async: true

        test "x" do
          assert Application.get_env(:kaoiro_server, :k) == nil
        end
      end
      """

      async_writer_then_sync_reader = """
      defmodule Reader do
        use ExUnit.Case, async: false

        test "x" do
          assert Application.get_env(:kaoiro_server, :k) == nil
        end
      end

      defmodule Writer do
        use ExUnit.Case, async: true

        test "x" do
          Application.put_env(:kaoiro_server, :k, 1)
        end
      end
      """

      assert violations_in_source(sync_writer_then_async_reader) == []

      assert [{_, "Writer", 13, :put_env, :async}] =
               violations_in_source(async_writer_then_sync_reader)
    end

    test "a nested module does not lend its flag or its writes to the outer one" do
      source = """
      defmodule Outer do
        use ExUnit.Case, async: true

        defmodule Inner do
          use ExUnit.Case, async: false

          test "x" do
            Application.put_env(:kaoiro_server, :k, 1)
          end
        end

        test "x", do: assert(true)
      end
      """

      assert violations_in_source(source) == []
    end
  end

  describe "the real tree" do
    test "no async test module writes the global environment" do
      files = test_files()

      # Anti-vacuity: each of these goes quiet if a part of the scan silently
      # stops seeing the tree, which would otherwise read as a clean one.
      assert length(files) >= 50

      modules = Enum.flat_map(files, &modules_in_file/1)

      assert Enum.count(modules, &(&1.async == :async)) >= 20,
             "the scan recognised almost no async module"

      assert Enum.count(modules, &(&1.writes != [])) >= 20,
             "the scan recognised almost no env write"

      violations = Enum.flat_map(modules, &violations_of/1)

      assert violations == [],
             "async test modules write the global environment; declare them " <>
               "`async: false`:\n" <>
               Enum.map_join(violations, "\n", fn {file, module, line, name, async} ->
                 "  #{file}:#{line} #{module} (#{async}) calls #{name}"
               end)
    end
  end

  defp test_files do
    Enum.flat_map(@roots, fn root -> Path.wildcard(Path.join(root, "**/*_test.exs")) end)
  end

  defp modules_in_file(file) do
    file |> File.read!() |> modules_in_source() |> Enum.map(&Map.put(&1, :file, file))
  end

  defp violations_in_source(source) do
    source
    |> modules_in_source()
    |> Enum.flat_map(fn module -> module |> Map.put(:file, "inline") |> violations_of() end)
  end

  defp violations_of(%{async: :sync}), do: []

  defp violations_of(%{file: file, module: module, async: async, writes: writes}) do
    for {line, name} <- writes, do: {file, module, line, name, async}
  end

  defp modules_in_source(source) do
    {_ast, found} =
      source
      |> Code.string_to_quoted!()
      |> Macro.prewalk([], fn
        {:defmodule, _, [name, [do: body]]} = node, acc ->
          nodes = own_nodes(body)

          info = %{
            module: Macro.to_string(name),
            async: async_of(nodes),
            writes: Enum.flat_map(nodes, &env_write/1)
          }

          {node, [info | acc]}

        node, acc ->
          {node, acc}
      end)

    Enum.reverse(found)
  end

  # The nodes of a module body without those of the modules nested in it:
  # replacing a nested `defmodule` makes the walk skip its children.
  defp own_nodes(body) do
    {_body, nodes} =
      Macro.prewalk(body, [], fn
        {:defmodule, _, _}, acc -> {nil, acc}
        node, acc -> {node, [node | acc]}
      end)

    Enum.reverse(nodes)
  end

  defp async_of(nodes) do
    values =
      for {:use, _, [_template, options | _]} <- nodes,
          is_list(options),
          {:async, value} <- options,
          do: value

    cond do
      Enum.any?(values, &(&1 == true)) -> :async
      Enum.any?(values, &(&1 != false)) -> :unknown
      true -> :sync
    end
  end

  defp env_write({{:., _, [_module, name]}, meta, args})
       when name in @env_writers and is_list(args),
       do: [{Keyword.get(meta, :line), name}]

  defp env_write({name, meta, args}) when name in @env_writers and is_list(args),
    do: [{Keyword.get(meta, :line), name}]

  defp env_write(_node), do: []
end
