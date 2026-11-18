import { registerSelfEntry } from "@kaoiro/wrapper-core";

// A test process is not started through the kaoiro entry, so point the
// self-start command at the built one, as `kaoiro wrapper antigravity` would.
registerSelfEntry(new URL("../../../runner/dist/kaoiro.js", import.meta.url).href);
