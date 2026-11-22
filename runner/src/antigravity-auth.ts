import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

export type AntigravityAuth =
  | "google-cloud-adc" | "google-cloud-sign-in" | "invalid";

export function parseAntigravityAuth(value: unknown): AntigravityAuth {
  if (value === "google-cloud-adc" || value === "google-cloud-sign-in") return value;
  return "invalid";
}

/** Checks only the markers visible to the child. Never opens credentials. */
export function antigravityAuthProblem(
  auth: AntigravityAuth | undefined,
  cwd: string,
  env = process.env,
): string | null {
  if (auth === undefined) return "set antigravity.auth in the runner configuration";
  if (auth !== "google-cloud-adc" && auth !== "google-cloud-sign-in") {
    return "unsupported antigravity.auth declaration";
  }
  if (env.GEMINI_API_KEY) return "unset GEMINI_API_KEY";
  if (!env.HOME) return "HOME is missing";
  if (auth === "google-cloud-sign-in") return null;
  if (env.AGY_ADC_AUTH !== "true") return "AGY_ADC_AUTH must be true";
  const source = env.GOOGLE_APPLICATION_CREDENTIALS;
  const problem = source === undefined
    ? "the default ADC credentials file must be a readable regular file"
    : "GOOGLE_APPLICATION_CREDENTIALS must name a readable regular file";
  if (source === "") return problem;
  const file = source ??
    `${env.HOME}/.config/gcloud/application_default_credentials.json`;
  // Preserve symlink/.. components for the same kernel lookup as the child.
  const path = isAbsolute(file) ? file : `${cwd}${sep}${file}`;
  try {
    if (!statSync(path).isFile()) return problem;
    accessSync(path, constants.R_OK);
    return null;
  } catch {
    return problem;
  }
}
