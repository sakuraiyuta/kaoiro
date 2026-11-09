---
title: Dashboard UI language — typed in-repo string tables, switch without reload
status: accepted
date: 2026-11-10
opened: 2026-11-10
supersedes: []
superseded_by: null
related_specs: [i18n]
related_adrs: [6, 20]
---

# ADR-0071 — Dashboard UI language

## Context

The bundled dashboard wrote its UI text in Japanese inside components and
helpers, and [ADR-0006](0006-doc-language-i18n.md) deferred the choice of a
primary language to a pre-beta internationalization pass
([plan 5-2](../plans/phase-5-i18n.md)).
[issue #269](https://github.com/sakuraiyuta/kaoiro/issues/269) asks for an
English UI while Japanese stays selectable.

## Decision

1. **Typed in-repo tables, no library.** Each language is a TypeScript object
   split by area (`dashboard/src/lib/i18n/{ja,en}/<area>.ts`). A value is a
   string or a one-argument function, so word order and English plurals live
   in the table. The ja tables are the source of the type; each en area is
   written with `satisfies Messages["<area>"]` so that its real shape is kept,
   and the aggregation checks both directions, so `pnpm check` rejects a
   missing key, an extra key and an argument mismatch. No dependency or lockfile change.
2. **A switch without reload.** Text is looked up at the point it is drawn
   (`msg()` reads a reactive setting), so a choice repaints the page and keeps
   drafts and open views. A string looked up once into a constant would not
   follow; the contract in
   [i18n](../reference/ui/i18n.md) says where `msg()` may be called.
3. **Default follows the browser, a choice wins.** The setting is `auto`
   (default), `ja` or `en`, kept in the existing `kaoiro:settings:v1`
   localStorage entry. `auto` takes the first supported language of
   `navigator.languages` and falls back to en. It is changed from the login
   screen and the settings drawer. Operator decision 2026-11-10.
4. **Scope.** Text that the dashboard itself writes is translated. Server
   messages, persona names, agent text and values the operator named are not.
   Four `ja-JP`-pinned date formats follow the UI language; five that follow
   the browser stay as they are.
5. **Tests stay in ja.** A shared setup pins the language through the product's
   own `setLocale`, so existing expectations are unchanged; English is checked
   by tests that switch to it. The only permanent check on the tables is that
   no en file contains Japanese.
6. **Mixed state during the migration.** The switch ships before every screen
   is migrated; an English UI shows the untranslated screens in Japanese until
   the last unit lands.

## Alternatives not taken

- **`svelte-i18n`, `@inlang/paraglide-js`, `typesafe-i18n`, `i18next`.** They
  add dependencies, a generation step or string keys that are checked only at
  run time. The need is two languages, arguments and English plurals.
- **Save and reload on change.** It loses drafts and the open view.
- **A permanent checker for hard-coded text.** It cannot see English literals
  or the lifetime of a looked-up value, so it would guard half of the rule;
  migration is measured once per unit instead.

## Consequences

- New UI text goes into the tables
  ([contributing](../contributing/dashboard-strings.md)); a hard-coded string
  is a review finding.
- Text built at event time and kept in state (for example a login error) keeps
  the language it was built in until it is built again.
