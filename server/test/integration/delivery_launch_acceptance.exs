defmodule KaoiroServerWeb.DeliveryLaunchAcceptance do
  use KaoiroServerWeb.ChannelCase, async: false

  # This explicit acceptance gate needs freshly built runner and wrapper artifacts.
  # Invoke this file after the workspace build; ordinary server tests remain standalone.
  setup_all do
    root = Path.expand("../../..", __DIR__)

    {output, 0} =
      System.cmd(System.find_executable("node"), [
        Path.join(root, "runner/test/fixtures/delivery-registers.mjs")
      ])

    %{fixtures: Jason.decode!(output)}
  end

  setup do
    prior = Application.get_env(:kaoiro_server, :client_tokens)
    Application.put_env(:kaoiro_server, :client_tokens, "c3-operator:operator")

    on_exit(fn ->
      if prior,
        do: Application.put_env(:kaoiro_server, :client_tokens, prior),
        else: Application.delete_env(:kaoiro_server, :client_tokens)
    end)

    id = "c3-#{System.unique_integer([:positive])}"

    {:ok, _, runner} =
      KaoiroServerWeb.RunnerSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.RunnerChannel, "runner:" <> id)

    fingerprint = KaoiroServer.Auth.socket_id("c3-operator")

    {:ok, _, client} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, %{
        role: :operator,
        credential: {:token_fingerprint, fingerprint},
        socket_id: fingerprint
      })
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    %{id: id, runner: runner, client: client}
  end

  test "producer register traverses the real handler and serialized operator hosts", %{
    fixtures: f,
    id: id,
    runner: runner
  } do
    forwarded =
      for key <- ["actual", "disabled", "oversized"], into: %{} do
        payload = f[key]
        assert_reply push(runner, "register", payload), :ok
        assert_push "hosts", %{"hosts" => %{^id => host}}
        wire = Jason.decode!(Jason.encode!(host))
        assert wire["engines"] == payload["engines"]

        assert wire["in_flight_defaults"] == %{
                 "claude-code" => true,
                 "codex" => false,
                 "antigravity" => false
               }

        {key, %{"host_id" => id, "host" => wire}}
      end

    if path = System.get_env("KAOIRO_DELIVERY_V7_OUTPUT") do
      File.write!(path, Jason.encode!(forwarded))
    end

    IO.puts("C3 producer/register/serialized-hosts: 3 cases")
  end

  test "producer defaults seed only new rows and explicit launch choice wins", %{
    fixtures: f,
    id: id,
    runner: runner,
    client: client
  } do
    assert_reply push(runner, "register", f["actual"]), :ok

    payload = %{
      "version" => "0",
      "host_id" => id,
      "persona" => "ao",
      "cwd" => "/tmp",
      "engine" => "codex"
    }

    assert_reply push(client, "spawn", payload), :ok, %{"agent_id" => seeded}
    assert {:ok, %{policy: :off, revision: 1}} = KaoiroServer.DeliveryPolicies.get(seeded)

    assert_reply push(client, "spawn", Map.put(payload, "delivery_policy", "on")), :ok, %{
      "agent_id" => explicit
    }

    assert {:ok, %{policy: :on, revision: 1}} = KaoiroServer.DeliveryPolicies.get(explicit)
    updated = put_in(f["actual"], ["in_flight_defaults", "codex"], true)
    assert_reply push(runner, "register", updated), :ok
    assert {:ok, %{policy: :off, revision: 1}} = KaoiroServer.DeliveryPolicies.get(seeded)
    assert_reply push(client, "spawn", payload), :ok, %{"agent_id" => next}
    assert {:ok, %{policy: :on, revision: 1}} = KaoiroServer.DeliveryPolicies.get(next)
  end

  test "independent object bounds and measured register preflight controls", %{
    fixtures: f,
    runner: runner
  } do
    assert Enum.all?(f["rawMaximum"]["engines"], fn entry ->
             byte_size(Jason.encode!(entry["launch_delivery_policy"])) == 8192 and
               map_size(entry["launch_delivery_policy"]["persona_overrides"]) == 64
           end)

    assert Enum.all?(f["ordinarySent"]["engines"], &Map.has_key?(&1, "launch_delivery_policy"))

    assert Enum.all?(
             f["ordinarySent"]["engines"],
             &(length(&1["models"]) == 32 and
                 map_size(&1["launch_delivery_policy"]["persona_overrides"]) == 8)
           )

    assert f["measurements"]["ordinary"]["json_bytes"] * f["ratio"] * 10 + 4096 > 65536

    for key <- ["actual", "rawMaximum", "ordinarySent", "maximumSent", "nearSent", "short"] do
      payload = f[key]
      json = byte_size(Jason.encode!(payload))
      external = :erlang.external_size(payload)
      assert_reply push(runner, "register", payload), :ok
      assert external <= 65536
      assert external / json <= f["ratio"]
      assert json * f["ratio"] * f["multiplier"] + 4096 >= 2 * external + 4096
      IO.puts("C3 size #{key}: json=#{json} external=#{external} ratio=#{external / json}")
    end

    assert Enum.all?(
             f["maximumSent"]["engines"],
             &(not Map.has_key?(&1, "launch_delivery_policy"))
           )

    assert Enum.all?(f["nearSent"]["engines"], &(not Map.has_key?(&1, "launch_delivery_policy")))
    assert :erlang.external_size(f["near"]) > 65536
    assert_reply push(runner, "register", f["near"]), :error
  end
end
