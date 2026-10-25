# Run against a built release, without Mix or an injected settings service in the child.
[release] = System.argv()
release = Path.expand(release)

root =
  Path.join(
    System.tmp_dir!(),
    "kogane-work-capacity-release-#{System.unique_integer([:positive])}"
  )

File.mkdir_p!(root)

probe = ~S"""
{:ok, _} = Application.ensure_all_started(:kaoiro_server)
alias KaoiroServer.{WorkStore, WorkSettings}
actor = %{"kind" => "user", "id" => "release-probe"}
{:ok, settings} = WorkStore.get_settings(fn -> {:ok, actor} end)
config = Application.fetch_env!(:kaoiro_server, :work_store)
true = config[:work_max_records] == 4096
true = config[:work_receipts_per_work_principal] == 64
true = config[:work_receipts_per_principal] == 1024
id = fn -> "op_#{System.system_time(:millisecond)}_#{Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)}" end
for {key, mode} <- [{"work_nominated_per_principal", :nomination}, {"work_active_per_assignee", :active}] do
  maximum = settings.effective[key]
  for index <- 1..17 do
    principal = if mode == :active, do: actor, else: %{"kind" => "agent", "id" => "director"}
    operation = %{"op" => "assign", "title" => "Release admission", "operation_id" => id.(), "assignee" => "active-target", "director" => actor}
    context = if mode == :active, do: %{operator: true}, else: %{recipient: "nominee", conversation_id: id.(), turn_number: 1}
    result = WorkStore.apply(principal, operation, context)
    if maximum == 0 or index <= maximum do
      {:ok, _} = result
    else
      {:error, {:work_capacity, %{limit: ^key, maximum: ^maximum}}} = result
    end
  end
end
IO.puts("WORK_CAPACITY_RELEASE_OK " <> Jason.encode!(%{effective: settings.effective, source: settings.sources, rows: map_size(WorkStore.all())}))
"""

quote_env = fn value -> "'" <> String.replace(value, "'", "'\\''") <> "'" end

run = fn values, index ->
  dir = Path.join(root, Integer.to_string(index))
  File.mkdir_p!(dir)
  envfile = Path.join(dir, "runtime.env")

  File.write!(
    envfile,
    Enum.map_join(values, "\n", fn {key, value} -> "#{key}=#{quote_env.(value)}" end)
  )

  try do
    System.cmd(
      "bash",
      ["-c", ~S(set -a; . "$1"; exec "$2" eval "$3"), "release-probe", envfile, release, probe],
      env: [
        {"TMPDIR", dir},
        {"PHX_SERVER", nil},
        {"KAOIRO_WORK_NOMINATED_PER_PRINCIPAL", nil},
        {"KAOIRO_WORK_ACTIVE_PER_ASSIGNEE", nil}
      ],
      stderr_to_stdout: true
    )
  after
    File.rm_rf!(dir)
  end
end

try do
  vars = ~w(KAOIRO_WORK_NOMINATED_PER_PRINCIPAL KAOIRO_WORK_ACTIVE_PER_ASSIGNEE)

  cases = [
    [],
    Enum.map(vars, &{&1, "0"}),
    Enum.map(vars, &{&1, "1"}),
    Enum.map(vars, &{&1, "2147483647"})
  ]

  for {values, index} <- Enum.with_index(cases) do
    {output, status} = run.(values, index)

    if status != 0 or not String.contains?(output, "WORK_CAPACITY_RELEASE_OK "),
      do: raise("release admission failed: #{inspect(values)} exit=#{status}\n#{output}")

    output
    |> String.split("\n")
    |> Enum.filter(&String.starts_with?(&1, "WORK_CAPACITY_RELEASE_OK "))
    |> Enum.each(&IO.puts/1)
  end

  invalid =
    for variable <- vars,
        value <- ["", "-1", "1.5", "true", "+1", " 1", "1 ", "1x", "2147483648"],
        do: {variable, value}

  for {{variable, value}, index} <- Enum.with_index(invalid, 4) do
    {output, status} = run.([{variable, value}], index)

    if status == 0 or
         not String.contains?(output, "#{variable} must be an integer from 0 to 2147483647"),
       do:
         raise(
           "invalid env assertion failed: #{variable}=#{inspect(value)} exit=#{status}\n#{output}"
         )

    IO.puts("WORK_CAPACITY_RELEASE_INVALID #{variable}=#{inspect(value)} rejected")
  end

  IO.puts(
    "WORK_CAPACITY_RELEASE_PASS #{length(cases)} admission processes; #{length(invalid)} invalid startup processes"
  )
after
  File.rm_rf!(root)
end
