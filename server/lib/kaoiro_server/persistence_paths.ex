defmodule KaoiroServer.PersistencePaths do
  @moduledoc """
  Canonical list of the restart-surviving DETS stores and the environment
  variables that place them (docs/specs/deployment.md 1.2).

  One list, four consumers: `config/runtime.exs` walks it to apply the env
  overrides, `mix kaoiro.env` emits the sample `.env` lines from it, the
  test suite derives its cross-store assertions from it, and the deploy CLI
  reads `manifest/0` out of a built image to compare compose's declaration
  against the running container's effective path (issue #310, absorbing
  #220). A store that reaches one surface but not the others silently
  escapes backup: `KAOIRO_USERS_PATH` did exactly that, and the user ledger
  was lost when the container was recreated (issue #217).

  `KAOIRO_OAUTH_ALLOWLIST_PATH` is deliberately absent. It is an operator
  edited text file under `/etc/kaoiro`, not a DETS ledger in the state
  volume, so compose does not declare it and the deploy CLI would refuse
  every update if it appeared here.
  """

  # Where the bundled docker-compose.yaml mounts the `kaoiro-state` named
  # volume. Deployment-side location; unrelated to `default_path/0`, which is
  # the fallback used when the env var is unset.
  @volume_dir "/var/lib/kaoiro"

  # Order matches server/.env.example and `mix kaoiro.env`'s output.
  @stores [
    # ADR-0014 F1 / issue #49. Point at a persistent volume in production;
    # the fallback survives a process restart but not a fresh container. The
    # file is created owner-only (chmod 600) since records carry cwd
    # (sensitive, issue #46). A lost pointer only drops the default resume
    # target — the runner re-enumerates (ADR-0014 F2).
    %{
      store: "session_pointers",
      config_key: :session_pointers_path,
      env: "KAOIRO_SESSION_POINTERS_PATH",
      default_file: "session_pointers.dets"
    },
    # Agent identity ledger (ADR-0030). Owner-only like the pointers above; a
    # lost entry drops the ability to restore that agent until it is spawned
    # fresh.
    %{
      store: "agent_directory",
      config_key: :agent_directory_path,
      env: "KAOIRO_AGENT_DIRECTORY_PATH",
      default_file: "agent_directory.dets"
    },
    # Per-agent permission-mode ledger. Without a persistent volume the mode
    # is destroyed together with the container on `docker compose down`.
    %{
      store: "permission_modes",
      config_key: :permission_modes_path,
      env: "KAOIRO_PERMISSION_MODES_PATH",
      default_file: "permission_modes.dets"
    },
    # Codex sandbox/network_access request store (issue #305). Same rationale
    # as permission_modes.
    %{
      store: "permission_settings",
      config_key: :permission_settings_path,
      env: "KAOIRO_PERMISSION_SETTINGS_PATH",
      default_file: "permission_settings.dets"
    },
    # issue #109 visibility data must survive a full container recreation:
    # the cutoff it records is compared against ingress stamps the wrapper
    # hosts replay back after a restart (ADR-0051 D3-4). fsync-gated before
    # the clear ack.
    %{
      store: "clear_watermarks",
      config_key: :clear_watermarks_path,
      env: "KAOIRO_CLEAR_WATERMARKS_PATH",
      default_file: "clear_watermarks.dets"
    },
    %{
      store: "session_starts",
      config_key: :session_starts_path,
      env: "KAOIRO_SESSION_STARTS_PATH",
      default_file: "session_starts.dets"
    },
    %{
      store: "ingress_order",
      config_key: :ingress_order_path,
      env: "KAOIRO_INGRESS_ORDER_PATH",
      default_file: "ingress_order.dets"
    },
    # issue #247's ledger holds recipient-local dispatch watermarks (no
    # messages), but it must survive a server restart or a real pending gap
    # is silently forgotten.
    %{
      store: "delivery_states",
      config_key: :delivery_states_path,
      env: "KAOIRO_DELIVERY_STATES_PATH",
      default_file: "delivery_states.dets"
    },
    # Authoritative store of revoked agent_ids for fail-closed auth (ふじ
    # issue #120 must-fix 1, 2026-07-25): a lost entry silently re-grants a
    # revoked identity.
    %{
      store: "token_denylist",
      config_key: :token_denylist_path,
      env: "KAOIRO_TOKEN_DENYLIST_PATH",
      default_file: "token_denylist.dets"
    },
    # User identity ledger (issue #197, ADR-0050 D1). A lost entry re-issues
    # a new user_id and resets display_name on that source's next login, so
    # the acceptance criterion "変更が再起動を跨いで保持される" depends on
    # this pointing at a persistent volume in production.
    %{
      store: "users",
      config_key: :users_path,
      env: "KAOIRO_USERS_PATH",
      default_file: "users.dets"
    },
    # ADR-0055 phase-33 Stage B. SESSION_LIFECYCLE_MAX_EVENTS_PER_AGENT caps
    # how much of this timeline is retained per agent.
    %{
      store: "session_lifecycle_events",
      config_key: :session_lifecycle_events_path,
      env: "KAOIRO_SESSION_LIFECYCLE_EVENTS_PATH",
      default_file: "session_lifecycle_events.dets"
    },
    # Operator-picked rally threshold (issue #307). A threshold tuned
    # mid-session would not survive a container recreation;
    # KAOIRO_QUAGMIRE_RALLY_TURNS remains the boot default for a deployment
    # that has never stored a pick.
    %{
      store: "quagmire_settings",
      config_key: :quagmire_settings_path,
      env: "KAOIRO_QUAGMIRE_SETTINGS_PATH",
      default_file: "quagmire_settings.dets"
    }
  ]

  @doc """
  Every canonical store, in the order the sample `.env` documents them.

  Carries `:config_key` — the `:kaoiro_server` application key the env var
  overrides — which `manifest/0` deliberately omits.
  """
  def stores, do: @stores

  @doc """
  The store list as the deploy CLI reads it out of a built image.

  Each element carries EXACTLY `store`, `env`, `default_file` and
  `default_path` (docs/specs/deployment.md, "The contract #310 must
  satisfy"). `default_path` is the absolute path the store's own fallback
  resolves to when `env` is unset, which is what lets the CLI tell "this
  container never had the var set but reads where compose now declares"
  apart from "compose just moved this store". Adding a key breaks the
  contract.
  """
  def manifest do
    Enum.map(@stores, fn store ->
      %{
        store: store.store,
        env: store.env,
        default_file: store.default_file,
        default_path: KaoiroServer.DetsStorePath.default_path(store.default_file)
      }
    end)
  end

  @doc """
  Where the bundled `docker-compose.yaml` places a store: under the
  `kaoiro-state` named volume.
  """
  def volume_path(%{default_file: file}), do: Path.join(@volume_dir, file)
end
