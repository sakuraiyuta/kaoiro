<script lang="ts">
  import { untrack } from "svelte";
  import type { WorkCapacityKey, WorkCapacityPatch, WorkSettingsSnapshot } from "@kaoiro/protocol";
  import { WORK_CAPACITY_KEYS, isWorkCapacityValue } from "./workSettings";
  import { msg } from "./i18n/index.svelte";
  import type { KaoiroConnection } from "./protocol";

  let { connection, generation, snapshot, onSnapshot }: {
    connection?: KaoiroConnection | undefined;
    generation: number;
    snapshot: WorkSettingsSnapshot | null;
    onSnapshot: (value: WorkSettingsSnapshot) => void;
  } = $props();
  let drafts = $state<Record<WorkCapacityKey, string>>({ work_nominated_per_principal: "", work_active_per_assignee: "" });
  let pending = $state(false);
  let dirty = $state(false);
  let touched = $state<Record<WorkCapacityKey, boolean>>({ work_nominated_per_principal: false, work_active_per_assignee: false });
  let newerSettings = $state(false);
  let uncertain = $state(false);
  let error = $state<string | null>(null);
  function labelOf(key: WorkCapacityKey): string {
    return key === "work_nominated_per_principal"
      ? msg().workCapacitySettings.nominatedLimit
      : msg().workCapacitySettings.activeLimit;
  }
  function sourceLabelOf(source: "dashboard" | "config" | "default"): string {
    const t = msg().workCapacitySettings;
    return source === "dashboard" ? t.sourceDashboard : source === "config" ? t.sourceConfig : t.sourceDefault;
  }
  $effect(() => {
    if (snapshot?.state === "ready") {
      if (untrack(() => dirty)) newerSettings = true;
      else drafts = { work_nominated_per_principal: String(snapshot.effective.work_nominated_per_principal), work_active_per_assignee: String(snapshot.effective.work_active_per_assignee) };
      uncertain = false;
    } else {
      clearEdits();
      newerSettings = false;
      drafts = { work_nominated_per_principal: "", work_active_per_assignee: "" };
    }
  });
  $effect(() => {
    void generation;
    void connection;
    clearEdits();
    newerSettings = false;
    pending = false;
    uncertain = false;
    error = null;
  });
  const enabled = $derived(!!connection && snapshot?.state === "ready" && !pending && !uncertain);
  const anyTouched = $derived(WORK_CAPACITY_KEYS.some(key => touched[key]));
  function clearEdits(): void {
    dirty = false;
    touched = { work_nominated_per_principal: false, work_active_per_assignee: false };
  }
  function parse(raw: string): number | null {
    if (!/^[0-9]+$/.test(raw)) return null;
    const value = Number(raw);
    return isWorkCapacityValue(value) ? value : null;
  }
  const valid = $derived(WORK_CAPACITY_KEYS.every(key => parse(drafts[key]) !== null));
  async function refresh(): Promise<void> {
    if (!connection || pending) return;
    const requestConnection = connection;
    const requestGeneration = generation;
    const current = () => requestConnection === connection && requestGeneration === generation;
    pending = true;
    try {
      const value = await requestConnection.getWorkSettings();
      if (current()) { onSnapshot(value); uncertain = false; }
    }
    catch (cause) { if (current()) error = cause instanceof Error ? cause.message : "error"; }
    finally { if (current()) pending = false; }
  }
  async function save(reset?: WorkCapacityKey): Promise<void> {
    if (!enabled || !connection || snapshot?.state !== "ready") return;
    const changes: WorkCapacityPatch = reset ? { [reset]: null } : {};
    if (!reset) for (const key of WORK_CAPACITY_KEYS) {
      if (!touched[key]) continue;
      const value = parse(drafts[key]);
      if (value === null) return;
      changes[key] = value;
    }
    const revision = snapshot.revision;
    const latestSnapshot = (): WorkSettingsSnapshot | null => snapshot;
    const requestConnection = connection;
    const requestGeneration = generation;
    const current = () => requestConnection === connection && requestGeneration === generation;
    pending = true;
    error = null;
    try {
      const value = await requestConnection.setWorkSettings(revision, changes);
      if (current() && !(latestSnapshot()?.state === "unavailable" && value.state === "ready")) {
        clearEdits();
        newerSettings = false;
        onSnapshot(value);
      }
    }
    catch (cause) {
      if (!current()) return;
      const reason = cause instanceof Error ? cause.message : "error";
      error = reason === "revision_conflict" ? msg().workCapacitySettings.revisionConflict : reason;
      uncertain = true;
      try {
        const value = await requestConnection.getWorkSettings();
        if (current()) { onSnapshot(value); uncertain = false; }
      }
      catch { /* Keep edits disabled until an authoritative read succeeds. */ }
    } finally { if (current()) pending = false; }
  }
</script>

<section aria-label="Work admission settings">
  <h3>{msg().workCapacitySettings.title}</h3>
  <p>{msg().workCapacitySettings.intro}</p>
  <a href="https://github.com/sakuraiyuta/kaoiro/blob/develop/docs/reference/configuration/server.md#work-admission-settings" target="_blank" rel="noreferrer">{msg().workCapacitySettings.docsLink}</a>
  {#if snapshot?.state === "unavailable"}
    <p role="alert">{snapshot.reason === "work_settings_corrupt" ? "Invalid saved work settings" : msg().workCapacitySettings.stateUnknown}</p>
    <p>{snapshot.message}</p>
    <a href="https://github.com/sakuraiyuta/kaoiro/blob/develop/docs/reference/configuration/server.md#repair-invalid-work-capacity-settings" target="_blank" rel="noreferrer">{msg().workCapacitySettings.repairLink}</a>
  {:else if snapshot === null}
    <p>{msg().workCapacitySettings.unavailable}</p>
  {/if}
  {#each WORK_CAPACITY_KEYS as key}
    <label>{labelOf(key)}<input aria-label={labelOf(key)} inputmode="numeric" type="text" bind:value={drafts[key]} oninput={() => { dirty = true; touched[key] = true; }} disabled={!enabled} /></label>
    {#if snapshot?.state === "ready"}
      <p>{msg().workCapacitySettings.effective({ value: snapshot.effective[key] === 0 ? msg().workCapacitySettings.unlimited : String(snapshot.effective[key]), source: sourceLabelOf(snapshot.sources[key]), fallback: snapshot.fallbacks[key] })}</p>
    {/if}
    <button onclick={() => save(key)} disabled={!enabled}>{msg().workCapacitySettings.resetToServer({ label: labelOf(key) })}</button>
  {/each}
  <button onclick={() => save()} disabled={!enabled || !valid || !anyTouched}>{msg().workCapacitySettings.save}</button>
  <button onclick={refresh} disabled={!connection || pending}>{msg().workCapacitySettings.reload}</button>
  {#if newerSettings}<p role="status">{msg().workCapacitySettings.newerSettings}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if uncertain}<p role="alert">{msg().workCapacitySettings.uncertain}</p>{/if}
  {#if snapshot?.state === "ready" && snapshot.last_change}
    <p>{msg().workCapacitySettings.lastChange({ at: snapshot.last_change.at, actor: snapshot.last_change.actor.id, revision: snapshot.revision })}</p>
    {#if snapshot.changes}
      <details><summary>{msg().workCapacitySettings.recentChanges}</summary><ul>
        {#each snapshot.changes as change (change.revision)}
          <li>{change.at} / {change.actor.id} / revision {change.revision}: {JSON.stringify(change.new_overrides)}</li>
        {/each}
      </ul></details>
    {/if}
  {/if}
</section>

<style>
  section { padding: 0.75rem 0; font-size: var(--fs-body-sm); }
  h3, p, a { font-size: var(--fs-body-sm); }
  h3, p { color: var(--fg-dim); }
  p[role="alert"] { color: var(--c-error); }
  p[role="status"] { color: var(--fg); }
  h3 { font-weight: 600; }
  p { margin: 0.35rem 0; overflow-wrap: anywhere; }
  li { overflow-wrap: anywhere; }
  label { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.75rem; font-size: var(--fs-body-sm); color: var(--fg-dim); }
  input { width: 100%; min-width: 0; }
  button { margin: 0.35rem 0.25rem 0 0; white-space: normal; overflow-wrap: anywhere; }
</style>
