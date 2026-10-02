defmodule KaoiroServer.PersonaPackFixture do
  @moduledoc false
  @required ~w(idle thinking tool_running waiting_input waiting_permission done error)

  def write!(directory, filename, id, set, opts \\ []) do
    bundled = Keyword.get(opts, :source, "ao-1.0.2.zip")
    source = Application.app_dir(:kaoiro_server, "priv/persona-packs/#{bundled}")
    {:ok, entries} = :zip.extract(String.to_charlist(source), [:memory])
    entries = Map.new(entries, fn {name, data} -> {List.to_string(name), data} end)

    states =
      if Keyword.get(opts, :optional, false), do: @required ++ ["fatigued"], else: @required

    manifest =
      entries["manifest.json"]
      |> Jason.decode!()
      |> Map.merge(%{
        "id" => id,
        "sprite_set" => set,
        "name" => Keyword.get(opts, :name, id),
        "description" => "private description #{Keyword.get(opts, :name, id)}",
        "version" => Keyword.get(opts, :version, "1.0.0"),
        "states" => states
      })

    files = [
      {~c"manifest.json", Jason.encode!(manifest)},
      {~c"personality.md", "Private fixture instructions for #{id}"}
      | Enum.map(states, fn state ->
          name = "sprites/#{state}.png"
          {String.to_charlist(name), Map.fetch!(entries, name)}
        end)
    ]

    path = Path.join(directory, filename)
    {:ok, _} = :zip.create(String.to_charlist(path), files)
    %{path: path, idle: entries["sprites/idle.png"], optional: entries["sprites/fatigued.png"]}
  end
end
