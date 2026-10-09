import { execFileSync } from "node:child_process";

const must = (condition, message) => {
  if (!condition) throw new Error(`release unit refused: ${message}`);
};
const unitName = (name) => {
  must(
    typeof name === "string" &&
      /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,255}$/.test(name),
    "invalid fixed unit name",
  );
  return name;
};
const read = (bin, args) =>
  execFileSync(bin, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65_536,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });

export function unitSnapshot(unit, bin = "systemctl") {
  unitName(unit);
  const properties =
    "LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,InvocationID,MainPID,ExecStartEx";
  const raw = read(bin, [
    "--user",
    "show",
    `--property=${properties}`,
    "--",
    unit,
  ]);
  return Object.fromEntries(
    raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        must(separator > 0, "malformed unit observation");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function unitCommandSnapshot(unit, bin = "busctl") {
  const name = unitName(unit).endsWith(".service") ? unit : `${unit}.service`;
  const escaped = [...name]
    .map((character) =>
      /[A-Za-z0-9]/.test(character)
        ? character
        : `_${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    )
    .join("");
  return JSON.parse(
    read(bin, [
      "--user",
      "--json=short",
      "get-property",
      "org.freedesktop.systemd1",
      `/org/freedesktop/systemd1/unit/${escaped}`,
      "org.freedesktop.systemd1.Service",
      "ExecStartEx",
    ]),
  );
}

export function verifyRetainedUnitCommand(observation, executable, argv) {
  must(
    observation?.type === "a(sasasttttuii)" &&
      Array.isArray(observation.data) &&
      observation.data.length === 1,
    "missing or ambiguous typed ExecStartEx",
  );
  const command = observation.data[0];
  must(
    Array.isArray(command) &&
      command.length === 10 &&
      command[0] === executable &&
      Array.isArray(command[1]) &&
      JSON.stringify(command[1]) === JSON.stringify(argv),
    "ExecStartEx executable or complete argv differs from the captured command",
  );
  must(
    Array.isArray(command[2]) && command[2].includes("no-env-expand"),
    "ExecStartEx does not attest no-env-expand",
  );
  return true;
}
