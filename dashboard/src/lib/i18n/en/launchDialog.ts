import type { Messages } from "../ja";

export const launchDialog = {
  runnerNoRevision:
    "This host does not report build revision information (old runner).",
  runnerRevisionUnknown:
    "The build revision of this host is unknown (built without git information, or without going through pnpm build).",
  serverRevisionUnavailable:
    "Cannot get the build revision of the server (old server, or /api/health failed).",
  serverRevisionUnknown: "The build revision of the server itself is unknown.",
  revisionMismatch: ({ runner, server }) =>
    `The build revision of this host (${runner}…) does not match the server (${server}…).`,
  dirtyBoth: ({ runner }) =>
    `The build of this host (${runner}…) contains uncommitted changes in both the runner and the server (dirty).`,
  dirtyRunner: ({ runner }) =>
    `The build of this host (${runner}…) contains uncommitted changes on the runner side (dirty).`,
  dirtyServer: ({ runner }) =>
    `The build of this host (${runner}…) contains uncommitted changes on the server side (dirty).`,
  launchFailed: "Could not launch.",
  dialogTitle: "Launch an agent",
  heading: "Launch an agent",
  tabNew: "New",
  tabResume: "Resume",
  noHosts: "No host can launch agents (no runner connected).",
  deliveryLabel: "Interrupt delivery while running",
  hintApiUnconfirmed: "The operation API of this server is not confirmed",
  hintMethodUnconfirmed: "The delivery method at launch is not confirmed",
  hintHostDefaultUnknown: "The default setting of the host is not confirmed",
  hintHostCeilingOff: "Disabled by the host's upper limit setting",
  hintEngineUnsupported:
    "Unsupported by this engine. Messages go into the queue",
  hintManual: "Using the manually chosen setting",
  hintFallbackOn: "The host has no default, so on is used",
  hintHostDefault: "Using the default setting of the host",
  deliveryDescription:
    "Input from you or from agents is delivered by the matching method; anything else goes into the normal queue.",
  host: "Host",
  packDiagnosticsUnknown:
    "Pack diagnostics are unsupported or not confirmed.",
  ingestWarnings: ({ warnings }) =>
    `${warnings}. Fix the configuration, restart the server, then reload the page.`,
  persona: "Persona",
  cwd: "Working directory",
  engine: "Engine",
  model: "Model",
  defaultOption: "Default",
  resolvedModelBefore: "Resolved when fetched:",
  resolvedModelAfter: "(may change at launch)",
  refreshCatalog: "Refresh the model list",
  refreshCatalogTitle:
    "Refresh the model list (live probe, ignoring the runner cache)",
  refreshing: "Refreshing…",
  permissionMode: "permission mode (work intent)",
  permissionKeep: "Keep the previous value (server-stored)",
  permissionModeTitle: ({ sandbox, approval }) =>
    `Write: ${sandbox} / Approval: ${approval}`,
  permissionModeOption: ({ mode, sandbox, approval }) =>
    `${mode} (write ${sandbox} / approval ${approval})`,
  sandboxLabel: "sandbox (write scope)",
  sandboxReadOnly: "read-only — read only",
  sandboxWorkspace: "workspace-write — writes only inside the working directory",
  sandboxFull: "danger-full-access — unrestricted (dangerous)",
  networkAccess: "Allow network access inside the sandbox",
  approvalLabel: "Approval",
  approvalUntrusted: "untrusted — always confirm",
  approvalOnRequest: "on-request — confirm only when needed",
  approvalLocal: "local — reads and observational git run automatically",
  approvalNever: "never — never confirm",
  approvalNote:
    "The sandbox axis is advisory for this engine (the wrapper only inspects arguments; it is not enforced by the OS). local conservatively classifies read-only coreutils and observational git inside the working tree. Writes to .git and commit / merge need confirmation, and helpers named by existing repo / global config are within the operator's trust.",
  approvalFixedNever:
    "Approval is fixed to never — Codex does not support approval requests while running.",
  agentName: "Agent name (optional)",
  agentNamePlaceholder: "Persona name if left empty",
  initialPrompt: "Initial prompt (optional)",
  initialPromptPlaceholder: "First instruction (the agent waits idle if empty)",
  session: "Session",
  noSessions: "No session can be resumed in this cwd.",
  cancel: "Cancel",
  launching: "Launching…",
  launch: "Launch",
} satisfies Messages["launchDialog"];
