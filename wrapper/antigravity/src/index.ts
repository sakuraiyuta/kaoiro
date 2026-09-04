// @kaoiro/antigravity — Antigravity (agy CLI) engine adapter skeleton
// (ADR-0057, phase-34 Stage A A2). The adapter body (host.ts / adapter.ts /
// catalog.ts / toolhost.ts / bridge.ts / history.ts) lands in a later task;
// this package currently exports only the engine identity constant so the
// wiring across protocol / runner / server can reference it.

export const ANTIGRAVITY_ENGINE = { id: "antigravity" as const };
