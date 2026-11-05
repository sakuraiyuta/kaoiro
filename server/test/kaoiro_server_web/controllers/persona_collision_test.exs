defmodule KaoiroServerWeb.PersonaCollisionTest do
  use KaoiroServerWeb.ConnCase, async: false
  alias KaoiroServer.{PersonaAssets, PersonaPackFixture}
  @tag :tmp_dir
  test "operator receives one coherent pack regardless of filename and recovers", %{
    conn: conn,
    tmp_dir: tmp
  } do
    dir = Path.join(tmp, "ingest")
    File.mkdir_p!(dir)

    previous =
      for key <- [:persona_dir, :persona_cache_dir, :client_tokens],
          into: %{},
          do: {key, Application.get_env(:kaoiro_server, key)}

    on_exit(fn ->
      Enum.each(previous, fn {key, value} ->
        if value,
          do: Application.put_env(:kaoiro_server, key, value),
          else: Application.delete_env(:kaoiro_server, key)
      end)

      PersonaAssets.rebuild()
    end)

    Application.put_env(:kaoiro_server, :persona_dir, dir)
    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(tmp, "cache"))
    Application.put_env(:kaoiro_server, :client_tokens, "test:operator")
    conn = init_test_session(conn, %{"client_token" => "test"})

    b =
      PersonaPackFixture.write!(dir, "b.zip", "b", "shared",
        name: "B",
        source: "fuji-1.0.2.zip",
        optional: true
      )

    assert :ok = PersonaAssets.rebuild()
    assert PersonaAssets.known_persona?("b")
    a = PersonaPackFixture.write!(dir, "a.zip", "a", "shared", name: "A")
    PersonaPackFixture.write!(dir, "zz.zip", "a", "zz-duplicate-id", name: "duplicate")
    PersonaPackFixture.write!(dir, "c.zip", "c", "shared", name: "C", source: "fuji-1.0.2.zip")
    PersonaPackFixture.write!(dir, "bad.zip", "bad", "default")
    PersonaPackFixture.write!(dir, "other.zip", "other", "other")
    assert :ok = PersonaAssets.rebuild()

    check = fn ->
      manifest = get(conn, "/api/personas") |> json_response(200)
      idle = get(conn, "/personas/shared/idle.png")
      optional = get(conn, "/personas/shared/fatigued.png")

      assert {manifest["personas"]["shared"]["name"], idle.resp_body == a.idle, optional.status} ==
               {"A", true, 404}

      refute Map.has_key?(manifest["personas"], "default")
      refute Map.has_key?(manifest["personas"], "zz-duplicate-id")
      assert PersonaAssets.known_persona?("a")
      refute PersonaAssets.known_persona?("b")
      refute PersonaAssets.known_persona?("c")
      refute PersonaAssets.known_persona?("bad")
      assert PersonaAssets.known_persona?("other")
      assert PersonaAssets.prompt("a") =~ "fixture instructions for a"
      assert PersonaAssets.prompt("b") == nil
      assert PersonaAssets.get_pack_detail("a")["name"] == "A"
      assert PersonaAssets.get_pack_detail("b") == nil
      assert Enum.any?(PersonaAssets.ingest_warnings(), &String.contains?(&1, "keep a ("))
      assert Enum.any?(PersonaAssets.ingest_warnings(), &String.contains?(&1, "bad.zip"))
    end

    check.()
    File.rename!(a.path, Path.join(dir, "z.zip"))
    assert :ok = PersonaAssets.rebuild()
    check.()
    File.rm!(Path.join(dir, "z.zip"))
    File.rm!(Path.join(dir, "c.zip"))
    File.rm!(Path.join(dir, "zz.zip"))
    assert :ok = PersonaAssets.rebuild()

    assert get(conn, "/api/personas")
           |> json_response(200)
           |> get_in(["personas", "shared", "name"]) == "B"

    assert get(conn, "/personas/shared/idle.png").resp_body == b.idle
    assert PersonaAssets.known_persona?("b")
  end

  @tag :tmp_dir
  test "duplicate IDs and sprite sets do not depend on ZIP names", %{tmp_dir: tmp} do
    old_dir = Application.get_env(:kaoiro_server, :persona_dir)
    old_cache = Application.get_env(:kaoiro_server, :persona_cache_dir)

    on_exit(fn ->
      if old_dir,
        do: Application.put_env(:kaoiro_server, :persona_dir, old_dir),
        else: Application.delete_env(:kaoiro_server, :persona_dir)

      if old_cache,
        do: Application.put_env(:kaoiro_server, :persona_cache_dir, old_cache),
        else: Application.delete_env(:kaoiro_server, :persona_cache_dir)

      PersonaAssets.rebuild()
    end)

    Application.put_env(:kaoiro_server, :persona_dir, tmp)
    Application.put_env(:kaoiro_server, :persona_cache_dir, Path.join(tmp, "cache"))
    PersonaPackFixture.write!(tmp, "a.zip", "a", "s")
    PersonaPackFixture.write!(tmp, "x.zip", "b", "s")
    PersonaPackFixture.write!(tmp, "y.zip", "b", "t")
    assert :ok = PersonaAssets.rebuild()
    refute PersonaAssets.known_persona?("b")
    File.rename!(Path.join(tmp, "x.zip"), Path.join(tmp, "zz.zip"))
    assert :ok = PersonaAssets.rebuild()
    refute PersonaAssets.known_persona?("b")
    assert PersonaAssets.known_persona?("a")
  end
end
