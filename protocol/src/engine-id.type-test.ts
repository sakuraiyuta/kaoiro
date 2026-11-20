import type { EngineCatalogEntry, EngineKind, RunnerRegister } from "./index.js";

const external = {
  id: "sample-engine",
  models: [],
  operations: { version: 1, spawn: true },
} satisfies EngineCatalogEntry;

const register: RunnerRegister = {
  version: "0",
  host_id: "test",
  cwd_allowlist: [],
  capabilities: [external.id],
  engines: [external],
  in_flight_defaults: { [external.id]: false },
};

// @ts-expect-error The bundled producer only indexes known implementations.
const bundled: EngineCatalogEntry<EngineKind> = external;
void [register, bundled];
