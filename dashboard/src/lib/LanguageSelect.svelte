<script lang="ts">
  // The one language switch, shown on the login screen and in the settings
  // drawer. A choice repaints the page at once and is kept in localStorage
  // (docs/reference/ui/i18n.md).
  import { settings } from "./settings.svelte";
  import {
    LOCALES,
    LOCALE_NAMES,
    msg,
    setLocale,
    type LocaleSetting,
  } from "./i18n/index.svelte";

  function toSetting(value: string): LocaleSetting {
    return LOCALES.find((locale) => locale === value) ?? "auto";
  }
</script>

<label class="language">
  {msg().language.label}
  <select
    value={settings.locale}
    onchange={(e) => setLocale(toSetting(e.currentTarget.value))}
  >
    <option value="auto">{msg().language.auto}</option>
    {#each LOCALES as locale (locale)}
      <option value={locale}>{LOCALE_NAMES[locale]}</option>
    {/each}
  </select>
</label>

<style>
  .language {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .language select {
    width: 100%;
    min-width: 0;
  }
</style>
