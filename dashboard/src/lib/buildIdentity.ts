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
