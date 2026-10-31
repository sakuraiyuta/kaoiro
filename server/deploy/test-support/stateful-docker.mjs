#!/usr/bin/env node
// Stateful fake `docker` for the recovery property test (issue #695).
// Unlike deploy.test.mjs's scenario switch, every command reads and
// mutates one JSON model, so a recovery run sees what the failed run left.
// Faults are declared in the model: `fail` exits non-zero without effect,
// `kill-before` / `kill-after` SIGKILL the calling CLI before or after the
// effect, `partial` applies a defined partial effect and then kills, and
// `corrupt` writes a damaged archive and returns success.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const statePath = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const joined = args.join(" ");
const operation = joined.replace(/^compose(?: (?:-f|--project-directory) \S+)+ /, "compose ");
(state.argv ??= []).push(args);
const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const out = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const die = (message, code = 1) => { save(); process.stderr.write(`${message}\n`); process.exit(code); };

state.calls.push(operation);
let afterEffect = null;
for (const [index, fault] of state.faults.entries()) {
  if (!new RegExp(fault.match).test(operation)) continue;
  state.counters[index] = (state.counters[index] ?? 0) + 1;
  if (state.counters[index] !== (fault.nth ?? 1)) continue;
  if (fault.kind === "fail") die(`injected failure: ${joined}`);
  if (fault.kind === "kill-before") { save(); process.kill(process.ppid, "SIGKILL"); process.exit(1); }
  afterEffect = fault.kind;
}

function newId() {
  state.nextId += 1;
  return state.nextId.toString(16).padStart(64, "0");
}
const service = () => state.containers.filter((c) => c.service === "kaoiro");
const findContainer = (ref) => state.containers.find((c) => c.id === ref || c.name === ref);
const resolveImage = (ref) => (state.images[ref] ? ref : state.tags[ref]);

function volumeDigestLines(dir) {
  return readdirSync(dir).sort().map((name) => {
    const st = statSync(join(dir, name));
    return `/data/${name} ${st.uid}:${st.gid} ${(st.mode & 0o7777).toString(8).padStart(4, "0")}`;
  });
}

function finish() {
  save();
  if (afterEffect === "kill-after" || afterEffect === "partial") process.kill(process.ppid, "SIGKILL");
  process.exit(0);
}

function compose(rest) {
  const files = [];
  while (rest[0] === "-f" || rest[0] === "--project-directory") {
    if (rest[0] === "-f") files.push(rest[1]);
    rest = rest.slice(2);
  }
  if (files.length === 0) {
    files.push(join(process.cwd(), "docker-compose.yaml"));
    for (const name of ["docker-compose.override.yml", "docker-compose.override.yaml"]) {
      try { readFileSync(join(process.cwd(), name)); files.push(join(process.cwd(), name)); break; }
      catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  }
  const [sub, ...tail] = rest;
  if (sub === "ps") {
    const all = tail.includes("-a");
    const list = service().filter((c) => all || c.status === "running");
    if (tail.includes("--format")) out(list.map((c) => c.name).join("\n"));
    else out(list.map((c) => c.id).join("\n"));
    return finish();
  }
  if (sub === "config") {
    const volumes = [{ type: "volume", source: "kaoiro-state", target: "/var/lib/kaoiro", volume: {} }];
    for (const file of files.slice(1)) {
      const override = JSON.parse(readFileSync(file, "utf8"));
      volumes.push(...(override.services.kaoiro.volumes ?? []));
    }
    out({ name: "kaoiro", services: { kaoiro: { environment: { KAOIRO_USERS_PATH: "/var/lib/kaoiro/users.dets" }, volumes } }, volumes: { "kaoiro-state": { name: state.volume.name } } });
    return finish();
  }
  if (sub === "build") {
    const id = `sha256:${newId()}`;
    state.images[id] = { revision: process.env.KAOIRO_BUILD_REVISION, formats: ["legacy-calver", "landing-calver-v1"] };
    state.tags["kaoiro-server:latest"] = id;
    return finish();
  }
  if (sub === "stop") {
    for (const c of service()) {
      if (c.status !== "running") continue;
      c.status = "exited";
      c.exitCode = state.stopExitCode ?? 0;
    }
    return finish();
  }
  if (sub === "up") {
    const image = state.tags["kaoiro-server:latest"];
    const force = tail.includes("--force-recreate");
    const current = service();
    if (current.length === 0 || force || current.some((c) => c.image !== image)) {
      state.containers = state.containers.filter((c) => c.service !== "kaoiro");
      state.containers.push({ id: newId(), name: "kaoiro-c1", image, status: "running", exitCode: 0, restartCount: 0,
        startedAt: new Date().toISOString(), service: "kaoiro" });
    } else {
      for (const c of current) c.status = "running";
    }
    // The model of "the new code opened state": a target image writes a file.
    if (state.images[image]?.revision === state.targetRevision) {
      writeFileSync(join(state.volume.dir, "written-by-target.txt"), "new\n");
    }
    return finish();
  }
  if (sub === "port") { out("127.0.0.1:4000"); return finish(); }
  if (sub === "version") { out("2.0.0"); return finish(); }
  return die(`unmodelled compose command: ${joined}`, 2);
}

function inspect(target, format) {
  const container = findContainer(target);
  if (container) {
    const value = {
      "{{.Id}}": container.id,
      "{{.Image}}": container.image,
      "{{.State.Status}}": container.status,
      "{{.State.Running}}": String(container.status === "running"),
      "{{.State.ExitCode}}": String(container.exitCode ?? 0),
      "{{.State.OOMKilled}}": "false",
      "{{.State.StartedAt}}": container.startedAt ?? "2026-10-20T00:00:00Z",
      "{{json .Config.Labels}}": JSON.stringify({ "com.docker.compose.project": "kaoiro", "com.docker.compose.service": "kaoiro" }),
      "{{json .Mounts}}": JSON.stringify([{ Type: "volume", Name: state.volume.name, Destination: "/var/lib/kaoiro" }]),
      "{{json .Config.Env}}": JSON.stringify(["KAOIRO_USERS_PATH=/var/lib/kaoiro/users.dets"]),
      '{{range .Mounts}}{{if eq .Destination "/var/lib/kaoiro"}}{{.Name}}{{end}}{{end}}': state.volume.name,
    }[format];
    if (format === "{{.RestartCount}}") {
      out(String(container.restartCount ?? 0));
      if (state.restartBump && state.images[container.image]?.revision === state.targetRevision) container.restartCount = (container.restartCount ?? 0) + 1;
      return finish();
    }
    if (value === undefined) return die(`unmodelled container inspect format: ${format}`, 2);
    out(value);
    return finish();
  }
  const image = resolveImage(target) ?? (target === "alpine:3" ? "sha256:alpine" : undefined);
  if (image !== undefined && format === "{{.Id}}") { out(image); return finish(); }
  return die(`Error: No such object: ${target}`);
}

function run(rest) {
  const volumes = [];
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) {
    if (rest[i] === "--rm") { i += 1; continue; }
    if (rest[i] === "-v") { volumes.push(rest[i + 1]); i += 2; continue; }
    i += 2;
  }
  const image = rest[i];
  const tail = rest.slice(i + 1);
  const hostFor = (suffix) => volumes.find((v) => v.endsWith(suffix))?.split(":")[0];
  if (tail[0] === "/app/build-info.json") {
    const info = state.images[image];
    if (!info) return die(`no such image ${image}`, 125);
    out({ revision: info.revision, build_identity_formats: info.formats });
    return finish();
  }
  if (tail[0] === "-c" && /PersistencePaths\.beam/.test(tail[1])) { out("present"); return finish(); }
  if (tail[0] === "-c" && /\.beam/.test(tail[1])) { out("absent"); return finish(); }
  if (tail.some(arg => arg.includes("PersistencePaths.manifest()"))) {
    out([{ store: "users", env: "KAOIRO_USERS_PATH", default_file: "users.dets", default_path: "/tmp/kaoiro-dets/users.dets" }]);
    return finish();
  }
  if (tail[0] === "sh" && tail[1] === "-c" && tail[2].startsWith("find /data -mindepth 1 -maxdepth 1 -exec stat")) {
    out(volumeDigestLines(state.volume.dir).join("\n"));
    return finish();
  }
  if (tail[0] === "tar" && tail[1] === "czf") {
    const host = hostFor(":/backup");
    const file = join(host, tail[2].replace(/^\/backup\//, ""));
    if (afterEffect === "partial" || afterEffect === "corrupt") { writeFileSync(file, "truncated"); return finish(); }
    execFileSync("tar", ["czf", file, "-C", state.volume.dir, "."]);
    return finish();
  }
  if (tail[0] === "sh" && tail[1] === "-c" && tail[2].startsWith("find /data -mindepth 1 -maxdepth 1 -exec rm")) {
    const host = hostFor(":/backup:ro");
    const name = /tar xzf \/backup\/(\S+) -C \/data/.exec(tail[2])[1];
    for (const entry of readdirSync(state.volume.dir)) rmSync(join(state.volume.dir, entry), { recursive: true, force: true });
    if (afterEffect === "partial") return finish();
    execFileSync("tar", ["xzf", join(host, name), "-C", state.volume.dir]);
    return finish();
  }
  return die(`unmodelled run: ${joined}`, 2);
}

const [command, ...rest] = args;
switch (command) {
  case "compose":
    compose(rest);
    break;
  case "version":
    out(rest.includes("{{json .Server}}") ? { Version: "29.0.0", ApiVersion: "1.50" } : "29.0.0");
    finish();
    break;
  case "volume":
    if (rest[1] !== state.volume.name) die(`Error: no such volume: ${rest[1]}`);
    out(state.volume.name);
    finish();
    break;
  case "system":
    out([{ Name: state.volume.name, Size: "2kB" }]);
    finish();
    break;
  case "tag": {
    const image = resolveImage(rest[0]);
    if (image === undefined) die(`Error: No such image: ${rest[0]}`);
    state.tags[rest[1]] = image;
    finish();
    break;
  }
  case "rmi":
    delete state.tags[rest[0]];
    finish();
    break;
  case "pull":
    finish();
    break;
  case "image":
    out("null");
    finish();
    break;
  case "inspect":
    inspect(rest[0], rest[2]);
    break;
  case "ps":
    out(state.containers.map((c) => c.id).join("\n"));
    finish();
    break;
  case "start": {
    const c = findContainer(rest[0]);
    if (!c) die(`Error: No such container: ${rest[0]}`);
    c.status = "running";
    finish();
    break;
  }
  case "stop": {
    const c = findContainer(rest[2]);
    if (!c) die(`Error: No such container: ${rest[2]}`);
    c.status = "exited";
    finish();
    break;
  }
  case "exec": {
    const c = findContainer(rest[0]);
    if (!c || c.status !== "running") die(`Error: container ${rest[0]} is not running`);
    if (rest[2] === "rpc") {
      if (state.fleet === null) die("UndefinedFunctionError: KaoiroServer.ReleaseFleet.snapshot_json/0 is undefined");
      out(state.fleet);
      finish();
    }
    die(`unmodelled exec: ${joined}`, 2);
    break;
  }
  case "run":
    run(rest);
    break;
  default:
    die(`unmodelled docker command: ${joined}`, 2);
}

