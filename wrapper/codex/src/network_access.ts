// Sandbox-aware network-access normalization (phase-22 dogfood audit — 藤
// — ADR-0033 F3 追補). Contract is a semantic-mismatch fix, not a proven
// true→false restore-relay regression: no direct evidence exists that the
// last restart lost a previously-true value. `config.network_access` on
// the wire is a raw
// toggle meaningful only for the `workspace-write` sandbox — the Codex SDK
// only gates network behind `networkAccessEnabled` in that mode (see
// `#threadOptions` in host.ts). `danger-full-access` always carries network
// (it is included in full access) and `read-only` never does, regardless of
// the toggle's value. Reporting the raw toggle verbatim for those two
// sandboxes mis-labels the actually-enforced network state in
// ext.effective / whoami / the persisted resume snapshot. This pure helper
// is the single source of truth both CodexHost's effective-status snapshot
// and the CLI's startup resolved-config log project through, so the two
// never diverge.
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
