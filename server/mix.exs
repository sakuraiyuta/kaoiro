defmodule KaoiroServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :kaoiro_server,
      version: "0.1.0",
      elixir: "~> 1.15",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps(),
      listeners: [Phoenix.CodeReloader]
    ]
  end

  # Configuration for the OTP application.
  #
  # Type `mix help compile.app` for more information.
  def application do
    [
      mod: {KaoiroServer.Application, []},
      extra_applications: [:logger, :runtime_tools]
    ]
  end

  def cli do
    [
      preferred_envs: [precommit: :test]
    ]
  end

  # Specifies which paths to compile per environment.
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Specifies your project dependencies.
  #
  # Type `mix help deps` for examples and options.
  defp deps do
    [
      {:phoenix, "~> 1.8.7"},
      {:telemetry_metrics, "~> 1.0"},
      {:telemetry_poller, "~> 1.0"},
      {:jason, "~> 1.2"},
      {:dns_cluster, "~> 0.2.0"},
      {:bandit, "~> 1.5"},
      {:file_system, "~> 1.1"},
      # OAuth login for the dashboard (ADR-0042). Assent is a plain
      # function library (no plug coupling), and Req is the HTTP client it
      # picks up automatically — `Assent.HTTPAdapter.Req` is the default
      # when :req is available, so no :http_adapter config is needed.
      {:assent, "~> 0.3.1"},
      {:req, "~> 0.5"}
    ]
  end

  # Aliases are shortcuts or tasks specific to the current project.
  # For example, to install project dependencies and perform other setup tasks, run:
  #
  #     $ mix setup
  #
  # See the documentation for `Mix` for more info on aliases.
  defp aliases do
    [
      # The dashboard lives outside server/ (../dashboard, issue #44) and is
      # NOT part of `setup`: a Node/pnpm failure must not break the server
      # build. Release bundling happens in the Dockerfile's node stage; run
      # these two by hand for a local non-Vite (priv/static) dashboard.
      setup: ["deps.get"],
      "dashboard.setup": ["cmd --cd ../dashboard pnpm install"],
      "dashboard.build": ["cmd --cd ../dashboard pnpm build"],
      precommit: ["compile --warnings-as-errors", "deps.unlock --unused", "format", "test"]
    ]
  end
end
