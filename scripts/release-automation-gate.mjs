export function validateAutomationGate(env, actualHead, kind) {
  const prefix = kind === "landing" ? "KAOIRO_LANDING" : "KAOIRO_RELEASE";
  if (env[`${prefix}_ENABLED`] !== "true" || env.KAOIRO_IDENTITY_V9 !== "true" || env.KAOIRO_IDENTITY_V10 !== "true" ||
      typeof actualHead !== "string" || actualHead.length !== 40 || !/^[0-9a-f]{40}$/.test(actualHead) ||
      env[`${prefix}_CONTROL_SHA`] !== actualHead || env.KAOIRO_IDENTITY_GATES_SHA !== actualHead) {
    throw new Error("release automation requires exact-control-commit V9/V10 activation approval");
  }
}
