import { registerSelfEntry } from "@kaoiro/wrapper-core";

registerSelfEntry(new URL("../../../runner/dist/kaoiro.js", import.meta.url).href);

const CODEX_PACKAGE_URL = new URL(
  "../node_modules/@openai/codex/package.json",
  import.meta.url,
).href;

(globalThis as typeof globalThis & {
  __kaoiroTestImportMetaResolve?: (specifier: string) => string | undefined;
}).__kaoiroTestImportMetaResolve = (specifier) =>
  specifier === "@openai/codex/package.json" ? CODEX_PACKAGE_URL : undefined;
