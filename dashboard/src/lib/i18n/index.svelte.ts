// UI strings (issue #269). `msg()` returns the table of the current locale;
// read it where the text is drawn (template, function body, `$derived`), never
// into a module- or script-level constant, so a language switch repaints
// without a reload. Contract: docs/reference/ui/i18n.md.

import { settings, updateSettings } from "../settings.svelte";
import { en } from "./en";
import { ja, type Messages } from "./ja";

export type { Messages };

export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export type LocaleSetting = "auto" | Locale;

/** Names a language in its own language. Shown the same under every locale, so
 *  it is not a translated string. */
export const LOCALE_NAMES: Record<Locale, string> = {
  ja: "日本語",
  en: "English",
};

/** `ja*` tags map to ja and `en*` tags to en. For "auto", the first supported
 *  language in the browser's list wins; with none, en. */
export function resolveLocale(
  setting: LocaleSetting,
  languages: readonly string[],
): Locale {
  if (setting !== "auto") return setting;
  for (const tag of languages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "ja") return "ja";
    if (primary === "en") return "en";
  }
  return "en";
}

// Detected once at load; later changes of the browser's language are not
// followed.
const detected: Locale = resolveLocale(
  "auto",
  typeof navigator !== "undefined" && Array.isArray(navigator.languages)
    ? navigator.languages
    : [],
);

export function currentLocale(): Locale {
  return settings.locale === "auto" ? detected : settings.locale;
}

export function msg(): Messages {
  return currentLocale() === "ja" ? ja : en;
}

export function setLocale(next: LocaleSetting): void {
  updateSettings({ locale: next });
}

/** The BCP 47 tag handed to Intl-based date formatting. */
export function intlTag(): string {
  return currentLocale() === "ja" ? "ja-JP" : "en-US";
}
