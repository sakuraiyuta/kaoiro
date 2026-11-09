---
title: Dashboard strings — adding UI text
description: Where dashboard UI text lives, the key rules, and how tests handle the two languages.
status: accepted
last_updated: 2026-11-10
related: [documentation]
---

# Dashboard strings

Contract: [Dashboard i18n](../reference/ui/i18n.md). Decision:
[ADR-0071](../adr/0071-dashboard-i18n.md).

## Layout

```text
dashboard/src/lib/i18n/
  index.svelte.ts   msg(), setLocale(), resolveLocale()
  ja/<area>.ts      Japanese tables (they define the type)
  ja/index.ts       collects the areas
  en/<area>.ts      English tables
  en/index.ts       collects the areas and checks both directions
```

Japanese in `dashboard/src/lib/i18n/ja/` is the specification of the Japanese
UI, an exception to the English rule in `CLAUDE.md`. The en files contain no
Japanese (a test fails otherwise).

## Adding text

1. Put the text in `ja/<area>.ts`, then in `en/<area>.ts` under the same key.
   Forgetting either side fails `pnpm check`.
2. Read it with `msg()`: `{msg().agentCard.terminate}` or
   `aria-label={msg().agentCard.openDetail({ name })}`.
3. A new area is a pair of files registered in both `index.ts`. Write the en
   object as `export const <area> = { ... } satisfies Messages["<area>"];`.
   `satisfies` keeps the real shape of the object, which `en/index.ts` checks
   in both directions. Do not annotate the object (`: Messages[...]`) or cast
   it (`as`): that replaces the shape with the ja type, and an extra key in an
   area whose ja table is empty then passes `pnpm check`.
4. An extra key in an area whose ja table is empty is reported only as TS1360
   at `ja satisfies typeof table` in `en/index.ts`, without the key name.

## Rules

- No UI text in components or helpers, in either language.
- Keys are English lowerCamelCase, `<area>.<name>`; the area is the component
  file or feature. A table looked up by a code may have a third level.
- A key names a role, not its wording (`terminate`, `terminateConfirm`);
  `Aria`, `Title` and `Placeholder` suffixes tell the attribute.
- One sentence is one key. Variable parts are arguments, never concatenated
  fragments. When an element sits inside a sentence, use two keys
  (`xBefore`, `xAfter`).
- An en function declares the same parameter as the ja one, even when it does
  not use it (`(_p) => "..."`); leaving it out fails `pnpm check`.
- A count is an argument; the en table writes singular and plural
  (`plural(n, "agent", "agents")` from `en/plural.ts`).
- `common` holds only text with the same role everywhere (close, cancel).
- Names, ids, engine and model names, wire values and server codes are not
  translated: pass them in as arguments. For a server code, keep a message per
  known code in the table and print an unknown code as it is.
- Terms follow the [glossary](../reference/glossary.md).
- Call `msg()` only inside a function, a template or a `$derived`. Never store
  its result, or the result of a function that calls it, in a module or
  script-level constant: the value would stay in the language of that moment.
  Use a function that returns the text, or look a code up at the point of use.

## Tests

Tests run in ja: `dashboard/test/locale.setup.ts` calls `setLocale("ja")` before
every test file and test, in jsdom and in the node environment. Expectations
are Japanese literals. A test of the English UI calls `setLocale("en")` itself;
the next test starts in ja again. A test that resets the settings to the defaults
keeps the pin: `updateSettings({ ...DEFAULT_SETTINGS, locale: "ja" })`, because the
default `auto` reads en in jsdom. Add one switch test (mount in ja, then
`setLocale("en")`, then read named elements) for each new screen.

Playwright pins `locale: "ja-JP"` in its three configs; an English spec uses
`test.use({ locale: "en-US" })`. `e2e/i18nOverflow.spec.ts` opens each screen
in both languages and fails when English text overflows a box that Japanese
text fits; add a new screen to it.
