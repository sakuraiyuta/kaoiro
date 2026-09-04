import type { WrapperConfig } from "@kaoiro/agent-common";

export function effectiveNetworkAccess(
  sandbox: NonNullable<WrapperConfig["sandbox"]>,
  configuredNetworkAccess: boolean,
): boolean {
  switch (sandbox) {
    case "danger-full-access":
      return true;
    case "read-only":
      return false;
    case "workspace-write":
      return configuredNetworkAccess;
  }
}
