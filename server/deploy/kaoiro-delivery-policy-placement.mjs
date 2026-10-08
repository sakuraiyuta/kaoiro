import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { writeFileDurably } from "./kaoiro-deploy-atomic-write.mjs";
import { runDocker } from "./kaoiro-deploy-docker.mjs";

export const POLICY_ENV = "KAOIRO_DELIVERY_POLICIES_PATH";
export const STATE_TARGET = "/var/lib/kaoiro";
export const PLACEMENT_FILE = "policy-store-placement.json";
const SHA = /^[0-9a-f]{64}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const under = (path, parent) => path === parent || path.startsWith(parent === "/" ? "/" : `${parent}/`);

export class PolicyPlacementError extends Error {}
const refuse = reason => { throw new PolicyPlacementError(`delivery policy placement refused: ${reason}`); };
function json(raw, label) {
  try { return JSON.parse(raw); } catch { refuse(`${label} is not valid JSON`); }
}
function path(value, label) {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") ||
      value !== posix.normalize(value) || /[,\x00-\x1f\x7f]/.test(value) || value.split("/").some(p => p === "." || p === "..")) {
    refuse(`${label} is not a canonical absolute path`);
  }
  return value;
}
function source(value) {
  if (typeof value !== "string" || value === "" || /[,\x00-\x1f\x7f]/.test(value)) refuse("invalid mount source");
  return value;
}

export function declaredPolicyMounts(compose, imageVolumes) {
  const service = compose?.services?.kaoiro;
  if (!plain(service) || !Array.isArray(service.volumes)) refuse("incomplete compose mount declaration");
  if (imageVolumes !== null && !plain(imageVolumes)) refuse("invalid image VOLUME declaration");
  const images = Object.keys(imageVolumes ?? {}).map(target => ({ type: "volume", target: path(target, "image VOLUME"), source: `image:${target}`, image: true }));
  // Override precedence under the state mount has not been measured for every syntax.
  if (images.some(mount => under(mount.target, STATE_TARGET))) refuse("image VOLUME at or below the state target");
  const explicit = service.volumes.map(mount => {
    if (!plain(mount) || !["volume", "bind", "tmpfs"].includes(mount.type)) refuse("unsupported compose mount type");
    if (mount.read_only !== undefined && typeof mount.read_only !== "boolean") refuse("invalid mount writability");
    const target = path(mount.target, "mount target");
    if (mount.type === "tmpfs") return { type: "tmpfs", target, source: null, writable: mount.read_only !== true };
    const declared = source(mount.source);
    const resolved = mount.type === "volume" ? source(compose.volumes?.[declared]?.name) : path(declared, "bind source");
    return { type: mount.type, target, source: resolved, writable: mount.read_only !== true };
  });
  if (service.tmpfs !== undefined && !Array.isArray(service.tmpfs)) refuse("invalid service tmpfs declaration");
  for (const value of service.tmpfs ?? []) {
    if (typeof value !== "string") refuse("invalid service tmpfs entry");
    const parts = value.split(":");
    if (parts.length > 2) refuse("ambiguous service tmpfs entry");
    const [target, options = ""] = parts;
    explicit.push({ type: "tmpfs", target: path(target, "tmpfs target"), source: null, writable: !options.split(",").includes("ro"), tmpfs: options });
  }
  if (new Set(explicit.map(m => m.target)).size !== explicit.length) refuse("ambiguous duplicate mount targets");
  return [...explicit, ...images.filter(image => !explicit.some(m => m.target === image.target))];
}

export function selectPolicyMount(effectivePath, mounts, expectedSource) {
  path(effectivePath, "policy path");
  if (!under(effectivePath, STATE_TARGET) || effectivePath === STATE_TARGET) refuse("policy path is outside the state volume");
  const containing = mounts.filter(m => under(effectivePath, m.target)).sort((a, b) => b.target.length - a.target.length);
  const selected = containing[0];
  if (!selected || selected.type !== "volume" || selected.target !== STATE_TARGET ||
      selected.source !== expectedSource || selected.image || selected.writable !== true) {
    refuse("the longest containing mount is not the writable named state volume");
  }
  return selected;
}

export function observedPolicyMounts(inspect, declarations) {
  if (!Array.isArray(inspect) || inspect.length !== 1 || !plain(inspect[0]) ||
      !Array.isArray(inspect[0].Mounts) || !plain(inspect[0].HostConfig)) refuse("incomplete container inspection");
  const container = inspect[0], active = [];
  for (const mount of container.Mounts) {
    if (!plain(mount) || !["volume", "bind", "tmpfs"].includes(mount.Type) || typeof mount.RW !== "boolean") refuse("invalid inspected mount");
    const target = path(mount.Destination, "inspected mount target");
    const declared = declarations.find(m => m.target === target);
    if (!declared || declared.type !== mount.Type) refuse("unaccounted inspected mount");
    if (mount.Type === "volume" && !declared.image && mount.Name !== declared.source) refuse("inspected named volume differs from compose");
    if (mount.Type === "bind" && mount.Source !== declared.source) refuse("inspected bind source differs from compose");
    active.push({ ...declared, probe_writable: mount.RW });
  }
  const tmpfs = container.HostConfig.Tmpfs ?? {};
  if (!plain(tmpfs)) refuse("invalid HostConfig.Tmpfs");
  for (const [target, options] of Object.entries(tmpfs)) {
    path(target, "inspected tmpfs target");
    if (typeof options !== "string") refuse("invalid inspected tmpfs options");
    const declared = declarations.find(m => m.target === target);
    if (!declared || declared.type !== "tmpfs") refuse("unaccounted HostConfig.Tmpfs mount");
    if (!active.some(m => m.target === target)) active.push({ ...declared, probe_writable: !options.split(",").includes("ro") });
  }
  if (active.length !== declarations.length || new Set(active.map(m => m.target)).size !== active.length) refuse("mount observation does not cover all declarations");
  // Read-only/nocopy overrides protect existing data; original writability stays in the declaration.
  if (active.some(m => m.type !== "tmpfs" && !m.image && m.probe_writable)) refuse("inspection mounted persistent data writable");
  return active.sort((a, b) => a.target.localeCompare(b.target));
}

export function validatePolicyComponents(effectivePath, components) {
  const prefixes = ["/", ...effectivePath.slice(1).split("/").map((_, i, parts) => "/" + parts.slice(0, i + 1).join("/"))];
  if (!Array.isArray(components) || components.length !== prefixes.length) refuse("incomplete namespace path observation");
  let missing = false;
  for (let i = 0; i < prefixes.length; i++) {
    const component = components[i];
    if (!plain(component) || component.path !== prefixes[i]) refuse("namespace path observation does not match policy path");
    if (component.kind === "missing") { if (i === 0) refuse("missing root namespace"); missing = true; }
    else if ((component.kind !== "directory" && !(i === prefixes.length - 1 && component.kind === "regular")) || missing) {
      refuse("policy path has a symlink, unreadable or invalid component");
    }
  }
}

export const POLICY_RUNTIME_EVAL = `
p = KaoiroServer.DeliveryPolicies.resolved_path()
parts = Path.split(p)
prefixes = Enum.scan(parts, fn part, prior -> Path.join(prior, part) end)
components = Enum.map(prefixes, fn prefix ->
  kind = case File.lstat(prefix) do
    {:ok, %{type: type}} -> Atom.to_string(type)
    {:error, :enoent} -> "missing"
    {:error, _} -> "error"
  end
  %{path: prefix, kind: kind}
end)
IO.puts(Jason.encode!(%{path: p, components: components}))
`;

export function isPlacementReference(value) {
  return plain(value) && typeof value.path === "string" && value.path !== "" && SHA.test(value.sha256 ?? "");
}
export function isPolicyRegistrationObservation(value) {
  return plain(value) && IMAGE.test(value.image_id ?? "") && typeof value.registered === "boolean";
}
export function isPlacementRecord(value) {
  const shape = plain(value) && value.schema_version === 1 && value.verdict === "accepted" &&
    typeof value.transaction_id === "string" && value.transaction_id !== "" && IMAGE.test(value.image_id ?? "") &&
    SHA.test(value.compose_sha256 ?? "") && SHA.test(value.env_sha256 ?? "") &&
    typeof value.effective_path === "string" && Array.isArray(value.mounts) && plain(value.selected_mount) &&
    plain(value.docker) && typeof value.docker.version === "string" && typeof value.docker.api === "string" &&
    value.docker.version !== "" && value.docker.api !== "" &&
    typeof value.compose_version === "string" && value.compose_version !== "";
  if (!shape || value.mounts.length === 0 || new Set(value.mounts.map(m => m?.target)).size !== value.mounts.length) return false;
  try {
    for (const mount of value.mounts) {
      if (!plain(mount) || !["volume", "bind", "tmpfs"].includes(mount.type) ||
          (!mount.image && typeof mount.writable !== "boolean") || typeof mount.probe_writable !== "boolean") return false;
      path(mount.target, "recorded mount target");
      if (mount.type === "tmpfs" ? mount.source !== null : typeof mount.source !== "string" || mount.source === "") return false;
    }
    const selected = selectPolicyMount(value.effective_path, value.mounts, value.selected_mount.source);
    return JSON.stringify(canonical(selected)) === JSON.stringify(canonical(value.selected_mount));
  } catch { return false; }
}
export function readPlacementReference(dir, reference, binding = {}) {
  if (!isPlacementReference(reference) || reference.path !== join(resolve(dir), PLACEMENT_FILE)) refuse("invalid placement artifact reference");
  let bytes;
  try { bytes = readFileSync(reference.path); } catch { refuse("placement artifact is missing or unreadable"); }
  if (hash(bytes) !== reference.sha256) refuse("placement artifact hash differs from its reference");
  const record = json(bytes.toString(), "placement artifact");
  if (!isPlacementRecord(record)) refuse("invalid placement artifact shape");
  for (const [key, expected] of Object.entries(binding)) if (record[key] !== expected) refuse(`placement artifact ${key} binding changed`);
  return record;
}

export function preparePolicyPlacement({ bin, serverDir, imageId, transactionId, dir, targetPlan, queryPaths, expectedStateSource, previous, knownRegistration }) {
  const rawPresence = runDocker(bin, ["run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", imageId, "-c",
    "ls /app/lib/kaoiro_server-*/ebin/Elixir.KaoiroServer.DeliveryPolicies.beam >/dev/null 2>&1 && echo present || echo absent"]);
  if (!["present", "absent"].includes(rawPresence)) refuse("unknown DeliveryPolicies module observation");
  if (knownRegistration !== undefined && (!isPolicyRegistrationObservation(knownRegistration) || knownRegistration.image_id !== imageId)) {
    refuse("policy registration observation is not bound to the target image");
  }
  // Immutable image IDs allow legacy resume to reuse the earlier manifest observation.
  // A policy-bearing target still queries its canonical registry before every gate.
  if (rawPresence === "absent" && knownRegistration !== undefined) {
    if (knownRegistration.registered || previous) refuse("policy module and canonical registration disagree");
    return undefined;
  }
  const manifest = queryPaths();
  const registrations = manifest.skipped ? [] : manifest.paths.filter(p => p.store === "delivery_policies" || p.env === POLICY_ENV);
  if (rawPresence === "absent" && registrations.length === 0) {
    if (previous) refuse("the previously observed policy store disappeared");
    return undefined;
  }
  if (rawPresence !== "present" || manifest.skipped || registrations.length !== 1 ||
      registrations[0].store !== "delivery_policies" || registrations[0].env !== POLICY_ENV ||
      registrations[0].default_file !== "delivery_policies.dets") refuse("policy module and canonical registration disagree");
  const binding = { transaction_id: transactionId, image_id: imageId, compose_sha256: targetPlan.compose_sha256, env_sha256: targetPlan.env_sha256 };
  const prior = previous ? readPlacementReference(dir, previous, binding) : undefined;
  const compose = json(runDocker(bin, ["compose", "config", "--format", "json"], { cwd: serverDir }), "effective compose");
  if (hash(JSON.stringify(canonical(compose))) !== targetPlan.compose_sha256) refuse("compose plan changed during placement observation");
  const service = compose.services?.kaoiro;
  if (!plain(service?.environment)) refuse("policy environment is not an effective compose map");
  const configured = path(service.environment[POLICY_ENV], "configured policy path");
  const imageVolumes = json(runDocker(bin, ["image", "inspect", imageId, "--format", "{{json .Config.Volumes}}"]), "image volumes");
  const declarations = declaredPolicyMounts(compose, imageVolumes);
  const parent = declarations.find(m => m.target === STATE_TARGET);
  if (!parent || parent.type !== "volume" || parent.image) refuse("state target is not an explicit named volume");
  const expectedSource = source(expectedStateSource());
  selectPolicyMount(configured, declarations, expectedSource);
  const engine = json(runDocker(bin, ["version", "--format", "{{json .Server}}"]), "Docker version");
  const composeVersion = runDocker(bin, ["compose", "version", "--short"]);
  if (!plain(engine) || typeof engine.Version !== "string" || typeof engine.ApiVersion !== "string" || !composeVersion) refuse("unknown Docker or Compose version");
  const probe = `kaoiro-policy-${randomUUID()}`;
  const args = ["create", "--name", probe, "--network", "none", "-e", `${POLICY_ENV}=${configured}`];
  for (const mount of declarations.filter(m => !m.image)) {
    if (mount.type === "tmpfs") args.push("--tmpfs", `${mount.target}:${mount.tmpfs ?? "rw"}`);
    else {
      if (mount.type === "volume") {
        const observedName = runDocker(bin, ["volume", "inspect", mount.source, "--format", "{{.Name}}"]);
        if (observedName !== mount.source) refuse("declared volume does not already exist");
      }
      args.push("--mount", `type=${mount.type},source=${mount.source},destination=${mount.target},readonly${mount.type === "volume" ? ",volume-nocopy" : ""}`);
    }
  }
  args.push("--entrypoint", "/app/bin/kaoiro_server", imageId, "eval", POLICY_RUNTIME_EVAL);
  let created = false;
  let runtime, mounts, selected;
  try {
    runDocker(bin, args); created = true;
    const inspection = json(runDocker(bin, ["inspect", probe]), "probe inspection");
    mounts = observedPolicyMounts(inspection, declarations);
    runtime = json(runDocker(bin, ["start", "-a", probe]), "target release policy resolver");
    const completed = json(runDocker(bin, ["inspect", probe]), "completed probe inspection");
    if (completed?.[0]?.State?.Status !== "exited" || completed[0].State.ExitCode !== 0) refuse("target resolver did not exit successfully");
    if (JSON.stringify(observedPolicyMounts(completed, declarations)) !== JSON.stringify(mounts)) refuse("probe mounts changed during eval");
    if (!plain(runtime) || runtime.path !== configured) refuse("target constructor resolves a different policy path");
    validatePolicyComponents(runtime.path, runtime.components);
    selected = selectPolicyMount(runtime.path, mounts, expectedSource);
  } finally {
    if (created) runDocker(bin, ["rm", "-v", probe]);
  }
  const record = { schema_version: 1, ...binding, verdict: "accepted", effective_path: runtime.path,
    mounts, selected_mount: selected, docker: { version: engine.Version, api: engine.ApiVersion }, compose_version: composeVersion };
  if (prior && JSON.stringify(canonical(prior)) !== JSON.stringify(canonical(record))) refuse("placement observations changed since prepare");
  const artifact = join(resolve(dir), PLACEMENT_FILE);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  writeFileDurably(artifact, bytes);
  return { path: artifact, sha256: hash(bytes) };
}
