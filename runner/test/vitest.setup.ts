import { registerSelfEntry } from "@kaoiro/wrapper-core";

// A test process is not started through the kaoiro entry, so point the
// self-start command at the built one, as `kaoiro runner` would.
registerSelfEntry(new URL("../dist/kaoiro.js", import.meta.url).href);

const CODEX_PACKAGE_URL = new URL(
  "../../wrapper/codex/node_modules/@openai/codex/package.json",
  import.meta.url,
).href;

(globalThis as typeof globalThis & {
  __kaoiroTestImportMetaResolve?: (specifier: string) => string | undefined;
}).__kaoiroTestImportMetaResolve = (specifier) =>
  specifier === "@openai/codex/package.json" ? CODEX_PACKAGE_URL : undefined;
