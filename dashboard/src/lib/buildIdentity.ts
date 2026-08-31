export type BuildChannel = "dev" | "release";

export interface DisplayBuildIdentity {
  version: string;
  channel: BuildChannel;
  revision: string;
}

const clientBuildIdentity: DisplayBuildIdentity = {
  version: import.meta.env.VITE_KAOIRO_BUILD_VERSION || "unknown",
  channel:
    import.meta.env.VITE_KAOIRO_BUILD_CHANNEL === "release" ? "release" : "dev",
  revision: import.meta.env.VITE_KAOIRO_BUILD_REVISION || "unknown",
};

export { clientBuildIdentity };

export function formatBuildIdentity(
  component: "server" | "client" | "runner" | "wrapper",
  identity: DisplayBuildIdentity,
): string {
  const shortHash =
    identity.revision === "unknown" ? "unknown" : identity.revision.slice(0, 7);
  return `kaoiro ${identity.channel} ${component} v${identity.version} / ${shortHash}`;
}

export function formatRunnerHostLabel(host: {
  host_id: string;
  build_version?: string;
  build_channel?: BuildChannel;
  build_revision?: string;
}): string {
  if (
    host.build_version === undefined ||
    host.build_channel === undefined ||
    host.build_revision === undefined
  ) {
    return host.host_id;
  }
  return `${host.host_id} — ${formatBuildIdentity("runner", {
    version: host.build_version,
    channel: host.build_channel,
    revision: host.build_revision,
  })}`;
}
