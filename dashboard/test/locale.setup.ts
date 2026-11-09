// Every test runs in the ja UI unless it asks otherwise (docs/contributing/
// dashboard-strings.md). Going through the product's own setLocale() is what
// reaches both jsdom and node-environment files before they import a
// component, and survives vi.resetModules() in jsdom through localStorage.
import { beforeEach } from "vitest";
import { setLocale } from "../src/lib/i18n/index.svelte";

setLocale("ja");
beforeEach(() => setLocale("ja"));
