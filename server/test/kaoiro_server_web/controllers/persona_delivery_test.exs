defmodule KaoiroServerWeb.PersonaDeliveryTest do
  use KaoiroServerWeb.ConnCase, async: false
  alias KaoiroServer.{AgentStates, PersonaAssets, PersonaPackFixture}
  alias KaoiroServerWeb.PersonaDelivery

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
        query <- ["", "?v=old-public", "?v=old-public&auth=1"],
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

  test "real ingest collision denies both claimant orientations and all image request forms",
       ctx do
    [a, b, u, _] = ctx.ids
    canonical = PersonaAssets.delivery_snapshot().personas_by_id
    assert canonical["visible-a"]["sprite_set"] == "shared"
    assert canonical["hidden-b"]["sprite_set"] == "shared"
    assert PersonaAssets.manifest()["personas"]["shared"]["name"] == "hidden-b"
    {:ok, %{path: common}} = PersonaAssets.fetch_file("shared", "idle.png")
    {:ok, %{path: leftover}} = PersonaAssets.fetch_file("shared", "fatigued.png")
    assert File.read!(common) == ctx.other.idle
    assert File.read!(leftover) == ctx.one.optional
    refute ctx.one.idle == ctx.other.idle
    session = cookie("v")
    state(u, "unique", "unique")

    for {a_state, b_state} <- [
          {"idle", "disconnected"},
          {"disconnected", "idle"},
          {"idle", "idle"},
          {"disconnected", "disconnected"}
        ] do
      state(a, "visible-a", "shared", a_state)
      state(b, "hidden-b", "shared", b_state)
      manifest = body(session)
      assert Map.keys(manifest["personas"]) == ["unique"]
      refute Jason.encode!(manifest) =~ "hidden-b"
      refute Jason.encode!(manifest) =~ "visible-a"

      assert response(get(session, manifest["personas"]["unique"]["states"]["idle"]["url"]), 200) ==
               ctx.unique.idle

      denied_images(session, "shared")
    end

    denied_images(session, "absent")

    for token <- ["o", "a"] do
      operator = cookie(token)
      assert body(operator)["personas"]["shared"]["name"] == "hidden-b"
      assert response(get(operator, "/personas/shared/idle.png"), 200) == ctx.other.idle
      assert response(get(operator, "/personas/shared/fatigued.png"), 200) == ctx.one.optional
    end
  end

  test "hidden collider edits do not alter filtered body/version; collision removal restores access",
       ctx do
    [a, b, u, _] = ctx.ids
    state(u, "unique", "unique")
    session = cookie("v")
    state(a, "visible-a", "shared")
    before = body(session)
    old_b = File.read!(ctx.other.path)

    PersonaPackFixture.write!(ctx.ingest, "b.zip", "hidden-b", "shared",
      name: "changed-hidden",
      version: "2.0.0"
    )

    refute File.read!(ctx.other.path) == old_b
    :ok = PersonaAssets.rebuild()
    {:ok, %{path: changed_common}} = PersonaAssets.fetch_file("shared", "idle.png")
    refute File.read!(changed_common) == ctx.other.idle
    assert body(session) == before
    state(a, "visible-a", "shared", "disconnected")
    state(b, "hidden-b", "shared")

    PersonaPackFixture.write!(ctx.ingest, "a.zip", "visible-a", "shared",
      optional: true,
      source: "fuji-1.0.2.zip",
      name: "changed-a"
    )

    :ok = PersonaAssets.rebuild()
    {:ok, %{path: changed_unique}} = PersonaAssets.fetch_file("shared", "fatigued.png")
    refute File.read!(changed_unique) == ctx.one.optional
    assert body(session) == before

    state(b, "hidden-b", "shared", "disconnected")
    state(a, "visible-a", "shared")
    File.rm!(Path.join(ctx.ingest, "b.zip"))
    :ok = PersonaAssets.rebuild()
    restored = body(session)
    assert restored["personas"]["shared"]["name"] == "changed-a"
    assert restored["version"] != before["version"]
    assert get(session, "/personas/shared/fatigued.png").status == 200
    PersonaPackFixture.write!(ctx.ingest, "b.zip", "hidden-b", "shared")
    :ok = PersonaAssets.rebuild()
    assert body(session) == before
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

  test "viewer rejects the reserved sprite set even when ingest accepts a custom claimant",
       ctx do
    [a, _, _, _] = ctx.ids

    pack =
      PersonaPackFixture.write!(ctx.ingest, "default-set.zip", "custom-default-set", "default")

    :ok = PersonaAssets.rebuild()
    canonical = PersonaAssets.delivery_snapshot().personas_by_id["custom-default-set"]
    assert canonical["id"] == "custom-default-set"
    assert canonical["sprite_set"] == "default"
    viewer = cookie("v")
    before = body(viewer)
    assert before["personas"] == %{}

    for {id, value} <- [
          {canonical["id"], "idle"},
          {canonical["id"], "disconnected"},
          {"default", "idle"}
        ] do
      state(a, id, canonical["sprite_set"], value)
      assert body(viewer) == before
      denied_images(viewer, "default")
    end

    state(a, canonical["id"], canonical["sprite_set"])
    url = body(cookie("o"))["personas"]["default"]["states"]["idle"]["url"]
    assert url =~ "&auth=1"

    for session <- [cookie("o"), cookie("a")],
        path <- [url, "/personas/default/idle.png"],
        method <- [:get, :head] do
      conn =
        session |> put_req_header("if-none-match", "*") |> dispatch(@endpoint, method, path, nil)

      assert conn.status == 200
      assert conn.resp_body == if(method == :head, do: "", else: pack.idle)
      assert get_resp_header(conn, "cache-control") == ["private, no-store"]
    end

    assert get(build_conn(), url).status == 401
  end

  test "cookie login, denial order, live revocation, no-store and unchanged detail authorization",
       ctx do
    [_, _, u, _] = ctx.ids
    state(u, "unique", "unique")

    for path <- ["/api/personas", "/personas/unique/idle.png", "/personas/absent/no.png?v=old"] do
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

    for path <- [
          "/api/personas",
          url,
          "/personas/unique/idle.png",
          "/personas/unique/missing.png"
        ] do
      assert get_resp_header(get(session, path), "cache-control") == ["private, no-store"]
    end

    assert get(session, "/api/personas/unique").status == 403
    assert get(session, "/api/personas/absent").status == 403
    Application.put_env(:kaoiro_server, :client_tokens, "o:operator")
    assert get(session, "/api/personas").status == 401
    assert get(session, url).status == 401
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
      File.rm!(old_path)
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

  test "reversed ingest order still denies both metadata winners and unique files", ctx do
    [a, b, _, _] = ctx.ids
    File.rename!(Path.join(ctx.ingest, "a.zip"), Path.join(ctx.ingest, "z.zip"))
    :ok = PersonaAssets.rebuild()
    assert PersonaAssets.manifest()["personas"]["shared"]["name"] == "visible-a"
    session = cookie("v")

    for {left, right} <- [{"idle", "disconnected"}, {"disconnected", "idle"}] do
      state(a, "visible-a", "shared", left)
      state(b, "hidden-b", "shared", right)
      assert body(session)["personas"] == %{}
      denied_images(session, "shared")
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

    for url <- ["/api/personas", "/personas/unique/idle.png", "/personas/absent/idle.png"] do
      assert get(conn, url).status == 401
    end
  end

  test "corrupt/unknown credentials and disabled dashboard cannot bypass authentication" do
    Application.put_env(:kaoiro_server, :serve_dashboard, false)

    for path <- ["/api/personas", "/personas/shared/idle.png", "/personas/absent/idle.png"] do
      assert build_conn()
             |> put_req_cookie("_kaoiro_server_key", "corrupt")
             |> get(path)
             |> response(401)

      assert build_conn()
             |> init_test_session(%{"client_token" => "unknown"})
             |> get(path)
             |> response(401)

      assert build_conn()
             |> init_test_session(%{"client_token" => %{}})
             |> get(path)
             |> response(401)
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
