import { runDocker } from "./kaoiro-deploy-docker.mjs";

export const FLEET_RPC = "IO.puts(KaoiroServer.ReleaseFleet.snapshot_json())";
export const FLEET_RPC_TIMEOUT_MS = 5_000;
const LEGACY = "legacy-calver";
const LANDING = "landing-calver-v1";
const SHA = /^[0-9a-f]{40}$/;

export class BuildCompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 78;
  }
}

function refuse(message) {
  throw new BuildCompatibilityError(`build identity compatibility refused: ${message}`);
}

function versionFormat(version) {
  if (typeof version !== "string") return null;
  const legacy = /^\d{4}\.(?:[1-9]|1[0-2])\.\d{1,6}$/.exec(version);
  if (legacy && legacy[0] === version) return LEGACY;
  const match = /^(2[0-9]{3}|[3-9][0-9]{3})\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.([1-9][0-9]{0,5})$/.exec(version);
  if (version === "untagged") return LANDING;
  if (!match || match[0] !== version) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === `${match[1]}-${match[2]}-${match[3]}` ? LANDING : null;
}

export function targetFormats(info, expectedRevision) {
  if (!info || typeof info !== "object" || (typeof expectedRevision !== "string" || expectedRevision.length !== 40 || !SHA.test(expectedRevision)) || info.revision !== expectedRevision) {
    refuse("pinned target image does not attest its full revision");
  }
  const formats = info.build_identity_formats ?? [LEGACY];
  if (!Array.isArray(formats) || formats.length === 0 || formats.length > 2 ||
      new Set(formats).size !== formats.length || formats.some(value => ![LEGACY, LANDING].includes(value))) {
    refuse("target image has malformed build_identity_formats");
  }
  return formats;
}

export function validateFleet(snapshot, formats) {
  if (!snapshot || snapshot.schema !== 1 || !Array.isArray(snapshot.hosts) ||
      !Array.isArray(snapshot.wrappers) || snapshot.hosts.length > 1_000 || snapshot.wrappers.length > 1_000) {
    refuse("live node did not return a bounded fleet snapshot");
  }
  for (const group of [snapshot.hosts, snapshot.wrappers]) {
    const ids = new Set();
    for (const info of group) {
      if (!info || typeof info.id !== "string" || info.id.length === 0 ||
          Buffer.byteLength(info.id) > 256 || ids.has(info.id)) refuse("malformed or duplicate fleet identity");
      ids.add(info.id);
      const format = versionFormat(info.build_version);
      if (format === null || !formats.includes(format)) {
        refuse(`target does not support the registered identity of ${JSON.stringify(info.id)}`);
      }
    }
  }
  return snapshot;
}

export function requireFleetCompatibility({ bin, targetImageId, targetRevision, containerId, fleetStopped = false }) {
  let info;
  try {
    info = JSON.parse(runDocker(bin, ["run", "--rm", "--network", "none", "--entrypoint", "cat", targetImageId, "/app/build-info.json"],
      { timeout: FLEET_RPC_TIMEOUT_MS, maxBuffer: 65_536 }));
  } catch (error) {
    refuse(`cannot read pinned target image: ${error.message}`);
  }
  const formats = targetFormats(info, targetRevision);
  const observation = { target_image_id: targetImageId, target_revision: targetRevision, formats,
    observed_at: new Date().toISOString(), fleet_stopped: fleetStopped === true };
  if (fleetStopped === true) return observation;
  if (typeof containerId !== "string" || containerId.length === 0) refuse("no live node; explicit --fleet-stopped is required");
  let snapshot;
  try {
    const raw = runDocker(bin, ["exec", containerId, "/app/bin/kaoiro_server", "rpc", FLEET_RPC],
      { timeout: FLEET_RPC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 524_288 });
    snapshot = JSON.parse(raw);
  } catch (error) {
    refuse(`live release RPC failed or timed out: ${error.message}; use --fleet-stopped only after stopping the fleet`);
  }
  observation.fleet = validateFleet(snapshot, formats);
  return observation;
}
