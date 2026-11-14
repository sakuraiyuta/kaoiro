defmodule KaoiroServerWeb.PersonaDeliveryTest do
  use KaoiroServerWeb.ConnCase, async: false
  alias KaoiroServer.{AgentStates, PersonaAssets, PersonaPackFixture}
  alias KaoiroServerWeb.PersonaDelivery

  @long_lived "private, max-age=31536000, immutable"

  setup do
    saved =
      Map.new(
        [
          :client_tokens,
          :persona_dir,
          :persona_cache_dir,
          :oauth_allowlist_path,
          :serve_dashboard
        ],
        &{&1, Application.get_env(:kaoiro_server, &1)}
      )

    directory =
      Path.join(
        System.tmp_dir!(),
        "kogane289-test-#{System.pid()}-#{System.unique_integer([:positive])}"
      )

    ingest = Path.join(directory, "ingest")
    File.mkdir_p!(ingest)
    Application.put_env(:kaoiro_server, :client_tokens, "v:viewer,o:operator,a:admin")
    Application.put_env(:kaoiro_server, :persona_dir, ingest)
    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(directory, "cache"))
    one = PersonaPackFixture.write!(ingest, "a.zip", "visible-a", "shared", optional: true)

    other =
      PersonaPackFixture.write!(ingest, "b.zip", "hidden-b", "shared", source: "fuji-1.0.2.zip")

    unique = PersonaPackFixture.write!(ingest, "u.zip", "unique", "unique")
    :ok = PersonaAssets.rebuild()

    ids =
      for suffix <- ~w(a b u extra),
          do: "persona-auth-#{System.unique_integer([:positive])}-#{suffix}"

    on_exit(fn ->
      for id <- ids do
        AgentStates.put(%{"agent_id" => id, "type" => "state_change", "state" => "disconnected"})
        AgentStates.delete(id)
      end

      for {key, value} <- saved do
        if value == nil,
          do: Application.delete_env(:kaoiro_server, key),
          else: Application.put_env(:kaoiro_server, key, value)
      end

      PersonaAssets.rebuild()
      File.rm_rf!(directory)
    end)

    {:ok, ingest: ingest, one: one, other: other, unique: unique, ids: ids}
  end

  defp cookie(token) do
    conn =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> post("/session/new", Jason.encode!(%{"token" => token}))

    assert conn.status == 204
    recycle(conn)
  end

  defp state(id, persona, set, value \\ "idle", type \\ "state_change") do
    AgentStates.put(%{
      "agent_id" => id,
      "type" => type,
      "state" => value,
      "persona" => %{"id" => persona, "name" => persona, "sprite_set" => set},
      "payload" => %{}
    })
  end

  defp body(session), do: session |> get("/api/personas") |> json_response(200)

  defp denied_images(session, set) do
    for file <- ~w(idle.png fatigued.png missing.png),
        query <- ["", "?v=old-public", "?v=old-public&auth=1"] ++ current_query(set, file),
        method <- [:get, :head],
        headers <- [
          [],
          [{"if-none-match", "*"}],
          [{"if-none-match", "\"old-file-hash\""}],
          [{"if-modified-since", "Wed, 21 Oct 2099 07:28:00 GMT"}]
        ] do
      conn =
        Enum.reduce(headers, session, fn {key, value}, conn ->
          put_req_header(conn, key, value)
        end)

      conn = dispatch(conn, @endpoint, method, "/personas/#{set}/#{file}#{query}", nil)
      assert conn.status == 404
      assert get_resp_header(conn, "cache-control") == ["private, no-store"]
      assert get_resp_header(conn, "etag") == []
      assert get_resp_header(conn, "last-modified") == []
      assert conn.resp_body == if(method == :head, do: "", else: ~s({"error":"not_found"}))
    end
  end

  # The query a manifest would emit for the current bytes, so a denial is
  # also checked where a long-lived cache could otherwise apply.
  defp current_query(set, file) do
    case PersonaAssets.fetch_file(set, file) do
      {:ok, %{hash: hash}} -> ["?v=#{PersonaAssets.version_param(hash)}&auth=1"]
      :error -> []
    end
  end

  defp current_url(set, file \\ "idle.png") do
    [query] = current_query(set, file)
    "/personas/#{set}/#{file}" <> query
  end

  defp synthetic_scope(id, set) do
    assets = PersonaAssets.delivery_snapshot()
    entry = assets.manifest["personas"]["shared"]
    file = assets.files[{"shared", "idle.png"}]
    assets = put_in(assets.personas_by_id[id], %{"id" => id, "sprite_set" => set})
    assets = put_in(assets.manifest["personas"][set], entry)
    assets = put_in(assets.files[{set, "idle.png"}], file)
    assets = put_in(assets.files[{set, "fatigued.png"}], file)
    %{assets: assets, allowed: PersonaDelivery.allowed_sets(assets, AgentStates.snapshot())}
  end

  # Ingest now selects one claimant, so the ambiguous generation is supplied at the decision seam.
  test "collision denies both claimant orientations at the decision and HTTP mapping", ctx do
    [a, b, u, _] = ctx.ids
    session = cookie("v")
    denied_images(session, "unique")
    state(u, "unique", "unique")

    for {a_state, b_state} <- [
          {"idle", "disconnected"},
          {"disconnected", "idle"},
          {"idle", "idle"},
          {"disconnected", "disconnected"}
        ] do
      state(a, "visible-a", "shared", a_state)
      state(b, "hidden-b", "shared", b_state)
      scope = synthetic_scope("visible-a", "shared")
      manifest = PersonaDelivery.manifest(scope)
      assert Map.keys(manifest["personas"]) == ["unique"]
      refute Jason.encode!(manifest) =~ "hidden-b"
      refute Jason.encode!(manifest) =~ "visible-a"

      for file <- ~w(idle.png fatigued.png) do
        assert {:ok, _} = PersonaDelivery.fetch_file(%{scope | allowed: :all}, "shared", file)
        assert PersonaDelivery.fetch_file(scope, "shared", file) == :error
      end

      assert PersonaDelivery.fetch_file(scope, "shared", "missing.png") == :error

      assert response(get(session, "/personas/unique/idle.png"), 200) == ctx.unique.idle
    end

    denied_images(session, "absent")

    for token <- ["o", "a"] do
      operator = cookie(token)
      assert body(operator)["personas"]["shared"]["name"] == "hidden-b"
      assert response(get(operator, "/personas/shared/idle.png"), 200) == ctx.other.idle
      assert get(operator, "/personas/shared/fatigued.png").status == 404
    end
  end

  # Ingest excludes one claimant; synthetic generations retain the viewer ambiguity check.
  test "collider edits stay hidden and removal restores access", ctx do
    [a, b, u, _] = ctx.ids
    state(u, "unique", "unique")
    state(a, "visible-a", "shared")
    before = synthetic_scope("visible-a", "shared") |> PersonaDelivery.manifest()

    PersonaPackFixture.write!(ctx.ingest, "b.zip", "hidden-b", "shared",
      name: "changed-hidden",
      version: "2.0.0"
    )

    :ok = PersonaAssets.rebuild()
    assert synthetic_scope("visible-a", "shared") |> PersonaDelivery.manifest() == before
    state(a, "visible-a", "shared", "disconnected")
    state(b, "hidden-b", "shared")
    assert synthetic_scope("visible-a", "shared") |> PersonaDelivery.manifest() == before

    PersonaPackFixture.write!(ctx.ingest, "a.zip", "visible-a", "shared",
      optional: true,
      source: "fuji-1.0.2.zip",
      name: "changed-a"
    )

    :ok = PersonaAssets.rebuild()
    assert synthetic_scope("visible-a", "shared") |> PersonaDelivery.manifest() == before
    state(b, "hidden-b", "shared", "disconnected")
    state(a, "visible-a", "shared")
    File.rm!(Path.join(ctx.ingest, "b.zip"))
    :ok = PersonaAssets.rebuild()
    restored = body(cookie("v"))
    assert restored["personas"]["shared"]["name"] == "changed-a"
    assert restored["version"] != before["version"]
    assert get(cookie("v"), "/personas/shared/fatigued.png").status == 200
    PersonaPackFixture.write!(ctx.ingest, "b.zip", "hidden-b", "shared")
    :ok = PersonaAssets.rebuild()
    assert synthetic_scope("visible-a", "shared") |> PersonaDelivery.manifest() == before
  end

  test "canonical identity, viewer projection, membership and empty manifests", ctx do
    [_, _, u, extra] = ctx.ids
    session = cookie("v")
    empty = body(session)
    assert empty["personas"] == %{}
    state(u, "wrong-id", "unique")
    assert body(session) == empty
    state(u, "unique", "wrong-set")
    assert body(session) == empty
    state(u, "unique", "unique", "idle", "inter_agent_message")
    assert body(session) == empty

    for type <- ~w(state_change permission_request question_request session_boundary) do
      for value <- ~w(idle waiting_input error done) do
        state(u, "unique", "unique", value, type)
        assert Map.has_key?(body(session)["personas"], "unique")
      end
    end

    state(extra, "unique", "unique")
    state(u, "unique", "unique", "disconnected")
    assert Map.has_key?(body(session)["personas"], "unique")
    state(extra, "unique", "unique", "disconnected")
    assert body(session) == empty
    denied_images(session, "unique")
  end

  # Ingest rejects the reserved set, so a synthetic generation exercises the viewer guard.
  test "viewer rejects the reserved set at the decision and HTTP mapping", ctx do
    [a, _, _, _] = ctx.ids
    session = cookie("v")
    before = body(session)
    assert before["personas"] == %{}

    for {id, value} <- [
          {"custom-default-set", "idle"},
          {"custom-default-set", "disconnected"},
          {"default", "idle"}
        ] do
      state(a, id, "default", value)
      scope = synthetic_scope("custom-default-set", "default")
      assert PersonaDelivery.manifest(scope) == before

      assert {:ok, _} =
               PersonaDelivery.fetch_file(%{scope | allowed: :all}, "default", "idle.png")

      assert PersonaDelivery.fetch_file(scope, "default", "idle.png") == :error
    end

    assert get(build_conn(), "/personas/default/idle.png").status == 401
  end

  test "cookie login, denial order, live revocation, no-store and unchanged detail authorization",
       ctx do
    [_, _, u, _] = ctx.ids
    state(u, "unique", "unique")

    for path <- [
          "/api/personas",
          "/personas/unique/idle.png",
          current_url("unique"),
          "/personas/absent/no.png?v=old"
        ] do
      for method <- [:get, :head] do
        conn =
          build_conn()
          |> put_req_header("accept", "image/png")
          |> dispatch(@endpoint, method, path, nil)

        assert conn.status == 401
        assert get_resp_header(conn, "cache-control") == ["private, no-store"]
      end
    end

    assert get(build_conn(), "/api/health").status == 200
    session = cookie("v")
    manifest = body(session)
    url = manifest["personas"]["unique"]["states"]["idle"]["url"]
    assert url =~ "&auth=1"
    assert url == current_url("unique")
    assert get_resp_header(get(session, url), "cache-control") == [@long_lived]

    for path <- [
          "/api/personas",
          "/personas/unique/idle.png",
          "/personas/unique/missing.png"
        ] do
      assert get_resp_header(get(session, path), "cache-control") == ["private, no-store"]
    end

    assert get(session, "/api/personas/unique").status == 403
    assert get(session, "/api/personas/absent").status == 403
    Application.put_env(:kaoiro_server, :client_tokens, "o:operator")
    assert get(session, "/api/personas").status == 401
    revoked = get(session, url)
    assert revoked.status == 401
    assert get_resp_header(revoked, "cache-control") == ["private, no-store"]
    Application.put_env(:kaoiro_server, :client_tokens, "")
    assert get(build_conn(), "/api/personas").status == 401
  end

  test "one asset generation remains authoritative after a rebuild", ctx do
    [_, _, u, _] = ctx.ids
    state(u, "unique", "unique")
    {:ok, old} = PersonaDelivery.scope(:viewer)
    state(u, "unique", "unique", "disconnected")
    {:ok, new} = PersonaDelivery.scope(:viewer)
    assert {:ok, _} = PersonaDelivery.fetch_file(old, "unique", "idle.png")
    assert :error = PersonaDelivery.fetch_file(new, "unique", "idle.png")
    PersonaPackFixture.write!(ctx.ingest, "u2.zip", "new-owner", "unique")
    :ok = PersonaAssets.rebuild()
    state(u, "unique", "unique")
    {:ok, collision} = PersonaDelivery.scope(:viewer)
    assert :error = PersonaDelivery.fetch_file(collision, "unique", "idle.png")
    assert {:ok, _} = PersonaDelivery.fetch_file(old, "unique", "idle.png")
    assert Map.has_key?(PersonaDelivery.manifest(old)["personas"], "unique")
  end

  test "version marker is independent of emitted URL identity" do
    entries = %{"same" => %{"states" => %{}}}

    refute PersonaDelivery.version(entries, "auth=1") ==
             PersonaDelivery.version(entries, "public")
  end

  # Ingest now selects and reclaims displaced packs before a pending request resumes.
  test "reclaimed selected file never falls through to a newer colliding generation", ctx do
    [_, _, u, _] = ctx.ids
    state(u, "unique", "unique")
    session = cookie("v")
    {:ok, %{path: old_path}} = PersonaAssets.fetch_file("unique", "idle.png")
    pid = Process.whereis(AgentStates)
    :sys.suspend(pid)
    task = Task.async(fn -> get(session, "/personas/unique/idle.png") end)

    try do
      wait_for_snapshot(pid, task.pid, 100)

      PersonaPackFixture.write!(ctx.ingest, "u2.zip", "new-owner", "unique",
        source: "fuji-1.0.2.zip"
      )

      :ok = PersonaAssets.rebuild()
      {:ok, %{path: new_path}} = PersonaAssets.fetch_file("unique", "idle.png")
      refute old_path == new_path
      # Rebuild now reclaims the displaced pack before the paused request resumes.
      refute File.exists?(old_path)
    after
      :sys.resume(pid)
    end

    conn = Task.await(task)
    assert json_response(conn, 404) == %{"error" => "not_found"}
    assert get_resp_header(conn, "cache-control") == ["private, no-store"]
  end

  defp wait_for_snapshot(_pid, _caller, 0),
    do: flunk("request never reached the real state authority")

  defp wait_for_snapshot(pid, caller, retries) do
    {:messages, messages} = Process.info(pid, :messages)

    if Enum.any?(messages, fn
         {:"$gen_call", {^caller, _}, :snapshot} -> true
         _ -> false
       end) do
      :ok
    else
      Process.sleep(5)
      wait_for_snapshot(pid, caller, retries - 1)
    end
  end

  test "unavailable state authority fails closed at both endpoints; operators still work", ctx do
    [_, _, u, _] = ctx.ids
    state(u, "unique", "unique")
    viewer = cookie("v")
    operator = cookie("o")
    pid = Process.whereis(AgentStates)
    Process.unregister(AgentStates)

    try do
      for path <- ["/api/personas", "/personas/unique/idle.png"] do
        conn = get(viewer, path)
        assert json_response(conn, 503) == %{"error" => "unavailable"}
        assert get_resp_header(conn, "cache-control") == ["private, no-store"]
        assert get(operator, path).status == 200
      end
    after
      Process.register(pid, AgentStates)
    end
  end

  test "inactive custom pack content cannot affect version, while visible edits do", ctx do
    [_, _, u, _] = ctx.ids
    session = cookie("v")
    hidden = body(session)
    PersonaPackFixture.write!(ctx.ingest, "u.zip", "unique", "unique", name: "private-change")
    :ok = PersonaAssets.rebuild()
    assert body(session) == hidden
    denied_images(session, "unique")
    state(u, "unique", "unique")
    visible = body(session)
    PersonaPackFixture.write!(ctx.ingest, "u.zip", "unique", "unique", name: "visible-change")
    :ok = PersonaAssets.rebuild()
    refute body(session)["version"] == visible["version"]
  end

  test "a pack update moves the long-lived cache to the new URL only", ctx do
    session = cookie("o")
    old_url = current_url("unique")
    assert get_resp_header(get(session, old_url), "cache-control") == [@long_lived]

    PersonaPackFixture.write!(ctx.ingest, "u.zip", "unique", "unique", source: "fuji-1.0.2.zip")
    :ok = PersonaAssets.rebuild()
    new_url = body(session)["personas"]["unique"]["states"]["idle"]["url"]
    refute new_url == old_url
    {:ok, %{path: path}} = PersonaAssets.fetch_file("unique", "idle.png")

    fresh = get(session, new_url)
    assert fresh.resp_body == File.read!(path)
    assert get_resp_header(fresh, "cache-control") == [@long_lived]

    stale = get(session, old_url)
    assert stale.status == 200
    assert stale.resp_body == File.read!(path)
    assert get_resp_header(stale, "cache-control") == ["private, no-store"]
  end

  # The setup's private cache dir keeps the altered slot away from other tests.
  test "bytes that no longer match the published hash are not pinned" do
    session = cookie("o")
    url = current_url("unique")
    {:ok, %{path: path}} = PersonaAssets.fetch_file("unique", "idle.png")
    altered = File.read!(path) <> "altered"
    File.write!(path, altered)

    sent = get(session, url)
    assert sent.status == 200
    assert sent.resp_body == altered
    assert get_resp_header(sent, "cache-control") == ["private, no-store"]

    v = :crypto.hash(:sha256, altered) |> Base.encode16(case: :lower)
    matching = get(session, "/personas/unique/idle.png?v=#{PersonaAssets.version_param(v)}")
    assert get_resp_header(matching, "cache-control") == [@long_lived]
  end

  for method <- [:get, :head],
      conditional <- [false, true],
      file <- ["idle.png", "fatigued.png"] do
    test "image authorization covers #{method}, conditional=#{conditional}, #{file}", ctx do
      [a, _, u, _] = ctx.ids
      state(a, "visible-a", "shared")
      state(u, "unique", "unique")
      conn = cookie("v")
      {:ok, %{hash: hash}} = PersonaAssets.fetch_file("shared", "idle.png")

      conn =
        if unquote(conditional),
          do: put_req_header(conn, "if-none-match", "\"#{hash}\""),
          else: conn

      denied =
        dispatch(
          conn,
          @endpoint,
          unquote(method),
          "/personas/shared/#{unquote(file)}?v=old&auth=1",
          nil
        )

      assert denied.status == 404
      refute denied.resp_body =~ <<137, 80, 78, 71>>

      assert dispatch(conn, @endpoint, unquote(method), "/personas/unique/idle.png", nil).status ==
               200
    end
  end

  # Ingest selects by ID, so a synthetic generation exercises both ambiguous claimants.
  test "renaming a zip does not select a different claimant", ctx do
    [a, b, _, _] = ctx.ids
    File.rename!(Path.join(ctx.ingest, "a.zip"), Path.join(ctx.ingest, "z.zip"))
    :ok = PersonaAssets.rebuild()
    assert PersonaAssets.manifest()["personas"]["shared"]["name"] == "hidden-b"

    for {left, right} <- [{"idle", "disconnected"}, {"disconnected", "idle"}] do
      state(a, "visible-a", "shared", left)
      state(b, "hidden-b", "shared", right)
      scope = synthetic_scope("visible-a", "shared")
      assert PersonaDelivery.manifest(scope)["personas"] == %{}
      assert PersonaDelivery.fetch_file(scope, "shared", "idle.png") == :error
    end
  end

  test "OAuth identities are revalidated on each persona request", ctx do
    [_, _, u, _] = ctx.ids
    state(u, "unique", "unique")
    path = KaoiroServer.OAuthAllowlistFixture.put_allowlist("nextcloud:persona-viewer:viewer")

    conn =
      init_test_session(build_conn(), %{
        "oauth_identity" => %{provider: "nextcloud", uid: "persona-viewer"}
      })

    assert body(conn)["personas"]["unique"]
    assert get(conn, "/personas/unique/idle.png").status == 200
    File.write!(path, "")

    for url <- [
          "/api/personas",
          "/personas/unique/idle.png",
          current_url("unique"),
          "/personas/absent/idle.png"
        ] do
      denied = get(conn, url)
      assert denied.status == 401
      assert get_resp_header(denied, "cache-control") == ["private, no-store"]
    end
  end

  test "corrupt/unknown credentials and disabled dashboard cannot bypass authentication" do
    Application.put_env(:kaoiro_server, :serve_dashboard, false)

    for path <- [
          "/api/personas",
          "/personas/shared/idle.png",
          current_url("shared"),
          "/personas/absent/idle.png"
        ],
        conn <- [
          put_req_cookie(build_conn(), "_kaoiro_server_key", "corrupt"),
          init_test_session(build_conn(), %{"client_token" => "unknown"}),
          init_test_session(build_conn(), %{"client_token" => %{}})
        ] do
      denied = get(conn, path)
      assert response(denied, 401)
      assert get_resp_header(denied, "cache-control") == ["private, no-store"]
    end

    assert get(cookie("o"), "/api/personas").status == 200
  end

  test "directory-only and malformed persona references grant no pack", ctx do
    [_, _, u, _] = ctx.ids
    KaoiroServer.AgentDirectory.record(u, "unique", "unique")
    on_exit(fn -> KaoiroServer.AgentDirectory.delete(u) end)
    conn = cookie("v")
    assert body(conn)["personas"] == %{}
    assert get(conn, "/personas/unique/idle.png").status == 404

    for persona <- [
          nil,
          %{},
          %{"id" => 1, "sprite_set" => "unique"},
          %{"id" => "default", "sprite_set" => "unique"}
        ] do
      AgentStates.put(%{
        "agent_id" => u,
        "type" => "state_change",
        "state" => "idle",
        "persona" => persona
      })

      assert body(conn)["personas"] == %{}
      assert get(conn, "/personas/unique/idle.png").status == 404
    end
  end

  @tag :authority_timeout
  test "state snapshot timeout fails closed without using an earlier grant", ctx do
    [_, _, u, _] = ctx.ids
    state(u, "unique", "unique")
    conn = cookie("v")
    assert body(conn)["personas"]["unique"]
    pid = Process.whereis(AgentStates)
    :sys.suspend(pid)

    try do
      tasks =
        for path <- ["/api/personas", "/personas/unique/idle.png"],
            do: Task.async(fn -> get(conn, path) end)

      for task <- tasks do
        denied = Task.await(task, 7000)
        assert json_response(denied, 503) == %{"error" => "unavailable"}
        assert get_resp_header(denied, "cache-control") == ["private, no-store"]
      end
    after
      :sys.resume(pid)
    end
  end
end
