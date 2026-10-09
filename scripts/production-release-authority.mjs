import { execChildSync } from "./child-process-environment.mjs";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  readPrivateBytes,
  requirePrivateFile,
  releaseBytesDigest,
} from "./production-release-files.mjs";
import { RELEASE_DIGEST } from "./production-release-state.mjs";

const common = [
  "schema",
  "install_root",
  "transport",
  "recording_hostname",
  "root",
  "tool_sha256",
  "exporter_path",
];
const remote = [
  "ssh_target",
  "ssh_hostname",
  "ssh_user",
  "ssh_port",
  "identity_file",
  "known_hosts_file",
  "remote_node",
  "remote_node_major",
];
const exact = (object, keys) =>
  object &&
  typeof object === "object" &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join() === [...keys].sort().join();
const must = (value, message) => {
  if (!value) throw new Error(`release authority refused: ${message}`);
};
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);

export function validateAuthorityPath(value) {
  must(
    typeof value === "string" &&
      value.length <= 1024 &&
      value.startsWith("/") &&
      /^[A-Za-z0-9._/-]+$/.test(value) &&
      value
        .split("/")
        .slice(1)
        .every((part) => part && part !== "." && part !== ".."),
    "absolute allow-listed physical path required",
  );
  return value;
}

export function authorityDescriptorPath(installRoot, role) {
  const root = realpathSync(installRoot);
  return join(
    root,
    role === "server"
      ? ".kaoiro-release-authority.json"
      : "release-authority.json",
  );
}

export function readReleaseAuthority(
  installRoot,
  { role = "runner", assertionPath, expectedDigest } = {},
) {
  const physicalRoot = realpathSync(installRoot);
  const path = authorityDescriptorPath(physicalRoot, role);
  if (assertionPath)
    must(
      resolve(assertionPath) === path,
      "--release-authority cannot select a different descriptor",
    );
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    must(!expectedDigest, "expected production authority descriptor is absent");
    return { status: "generic", path, root: physicalRoot };
  }
  must(
    stat.isFile() && !stat.isSymbolicLink(),
    "descriptor must be a regular private file",
  );
  const raw = readPrivateBytes(path, {
    maxBytes: 16_384,
    privateParent: false,
  });
  const digest = releaseBytesDigest(raw);
  if (expectedDigest)
    must(
      RELEASE_DIGEST.test(expectedDigest) && digest === expectedDigest,
      "captured authority digest differs",
    );
  const descriptor = JSON.parse(raw);
  must(
    descriptor.schema === 1 &&
      ["local", "ssh"].includes(descriptor.transport) &&
      exact(descriptor, [
        ...common,
        ...(descriptor.transport === "ssh"
          ? remote
          : ["node_major", "node_path"]),
      ]),
    "strict descriptor schema/fields",
  );
  must(
    descriptor.install_root === physicalRoot,
    "descriptor belongs to a different physical installation",
  );
  validateAuthorityPath(descriptor.root);
  validateAuthorityPath(descriptor.exporter_path);
  must(
    token(descriptor.recording_hostname) &&
      RELEASE_DIGEST.test(descriptor.tool_sha256 ?? ""),
    "authority role/digest fields",
  );
  if (descriptor.transport === "local") {
    must(
      hostname() === descriptor.recording_hostname,
      "kernel recording-host role mismatch",
    );
    must(
      [22, 24].includes(descriptor.node_major),
      "supported local Node major required",
    );
    validateAuthorityPath(descriptor.node_path);
  } else {
    must(
      token(descriptor.ssh_target) &&
        token(descriptor.ssh_user) &&
        typeof descriptor.ssh_hostname === "string" &&
        /^[A-Za-z0-9._:-]{1,255}$/.test(descriptor.ssh_hostname) &&
        !descriptor.ssh_hostname.startsWith("-"),
      "SSH target/user/hostname token grammar",
    );
    must(
      Number.isInteger(descriptor.ssh_port) &&
        descriptor.ssh_port >= 1 &&
        descriptor.ssh_port <= 65535 &&
        [22, 24].includes(descriptor.remote_node_major),
      "SSH port/Node major",
    );
    for (const name of [
      "identity_file",
      "known_hosts_file",
      "remote_node",
      "exporter_path",
    ])
      validateAuthorityPath(descriptor[name]);
    for (const name of ["identity_file", "known_hosts_file"])
      requirePrivateFile(descriptor[name], { privateParent: false });
  }
  return {
    status: "enrolled",
    path,
    root: physicalRoot,
    sha256: digest,
    descriptor,
  };
}

const shellPath = (value) => `'${validateAuthorityPath(value)}'`;
export function releaseSshArguments(descriptor, operation) {
  must(
    ["export", "import"].includes(operation),
    "fixed SSH operation required",
  );
  const command =
    `/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C ${shellPath(descriptor.remote_node)} ` +
    `${shellPath(descriptor.exporter_path)} ${operation} ${descriptor.tool_sha256} ${shellPath(descriptor.root)}`;
  return [
    "-F",
    "none",
    "-T",
    "-l",
    descriptor.ssh_user,
    "-p",
    String(descriptor.ssh_port),
    "-o",
    `HostName=${descriptor.ssh_hostname}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "CanonicalizeHostname=no",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=1",
    "-o",
    `UserKnownHostsFile=${descriptor.known_hosts_file}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-i",
    descriptor.identity_file,
    "--",
    descriptor.ssh_target,
    command,
  ];
}

export function releaseAuthorityRequest(
  authority,
  request,
  { operation = "export", fact, timeoutMs = 20_000 } = {},
) {
  must(
    authority.status === "enrolled",
    "generic installation is not an authority source",
  );
  const d = authority.descriptor;
  const header = `${JSON.stringify(request)}\n`;
  must(Buffer.byteLength(header) <= 4096, "authority request exceeds 4 KiB");
  const payload = fact === undefined ? "" : `${JSON.stringify(fact)}\n`;
  must(Buffer.byteLength(payload) <= 524_288, "private import payload bound");
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: homedir(),
    LANG: "C",
    LC_ALL: "C",
  };
  const options = {
    input: header + payload,
    encoding: "utf8",
    maxBuffer: operation === "export" ? 32 * 1024 * 1024 : 65_536,
    timeout: Math.min(timeoutMs, 20_000),
    stdio: ["pipe", "pipe", "pipe"],
    env: environment,
  };
  let raw;
  try {
    raw =
      d.transport === "ssh"
        ? execChildSync("authority",
            "/usr/bin/ssh",
            releaseSshArguments(d, operation),
            options,
          )
        : execChildSync("authority",
            d.node_path,
            [d.exporter_path, operation, d.tool_sha256, d.root],
            options,
          );
  } catch (error) {
    if (
      error.status === 78 &&
      String(error.stderr).trim() === "snapshot_changed"
    )
      throw new Error("snapshot_changed");
    throw error;
  }
  const response = JSON.parse(raw);
  must(
    response.schema === 1 &&
      response.nonce === request.nonce &&
      response.root === d.root &&
      response.recording_hostname === d.recording_hostname &&
      response.tool_sha256 === d.tool_sha256 &&
      response.node_major ===
        (d.transport === "ssh" ? d.remote_node_major : d.node_major),
    "authority response binding differs",
  );
  return response;
}
