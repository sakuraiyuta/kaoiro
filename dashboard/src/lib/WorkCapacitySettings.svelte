<script lang="ts">
  import { untrack } from "svelte";
  import type { WorkCapacityKey, WorkCapacityPatch, WorkSettingsSnapshot } from "@kaoiro/protocol";
  import { WORK_CAPACITY_KEYS, isWorkCapacityValue } from "./workSettings";
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
  const labels: Record<WorkCapacityKey, string> = {
    work_nominated_per_principal: "指名待ちの上限（依頼者・担当者ごと）",
    work_active_per_assignee: "実行中の上限（担当者ごと）",
  };
  const sourceLabels = { dashboard: "ダッシュボード", config: "サーバー設定", default: "既定値" };
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
      error = reason === "revision_conflict" ? "別の変更が保存されました。最新の値を確認して、もう一度入力してください。" : reason;
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
  <h3>作業の受け入れ上限</h3>
  <p>0 は無制限です。保存した値は再起動後も残ります。上限を下げても既存の作業は取り消されません。</p>
  <a href="https://github.com/sakuraiyuta/kaoiro/blob/develop/docs/reference/configuration/server.md#work-admission-settings" target="_blank" rel="noreferrer">設定の説明</a>
  {#if snapshot?.state === "unavailable"}
    <p role="alert">{snapshot.reason === "work_settings_corrupt" ? "Invalid saved work settings" : "保存状態を確認できません"}</p>
    <p>{snapshot.message}</p>
    <a href="https://github.com/sakuraiyuta/kaoiro/blob/develop/docs/reference/configuration/server.md#repair-invalid-work-capacity-settings" target="_blank" rel="noreferrer">復旧手順</a>
  {:else if snapshot === null}
    <p>設定未取得、未接続、またはサーバーがこの設定に対応していません。</p>
  {/if}
  {#each WORK_CAPACITY_KEYS as key}
    <label>{labels[key]}<input aria-label={labels[key]} inputmode="numeric" type="text" bind:value={drafts[key]} oninput={() => { dirty = true; touched[key] = true; }} disabled={!enabled} /></label>
    {#if snapshot?.state === "ready"}
      <p>適用値: {snapshot.effective[key] === 0 ? "無制限 (0)" : snapshot.effective[key]} / 設定元: {sourceLabels[snapshot.sources[key]]} / サーバー設定: {snapshot.fallbacks[key]}</p>
    {/if}
    <button onclick={() => save(key)} disabled={!enabled}>サーバー設定に戻す: {labels[key]}</button>
  {/each}
  <button onclick={() => save()} disabled={!enabled || !valid || !anyTouched}>保存</button>
  <button onclick={refresh} disabled={!connection || pending}>設定・変更履歴を読み直す</button>
  {#if newerSettings}<p role="status">サーバーの設定が更新されました。入力は保持しています。適用値を確認してから保存してください。</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if uncertain}<p role="alert">結果が不明です。保存を繰り返さず、設定を読み直してください。</p>{/if}
  {#if snapshot?.state === "ready" && snapshot.last_change}
    <p>最終変更: {snapshot.last_change.at} / {snapshot.last_change.actor.id} / revision {snapshot.revision}</p>
    {#if snapshot.changes}
      <details><summary>最近の変更（最大100件）</summary><ul>
        {#each snapshot.changes as change (change.revision)}
          <li>{change.at} / {change.actor.id} / revision {change.revision}: {JSON.stringify(change.new_overrides)}</li>
        {/each}
      </ul></details>
    {/if}
  {/if}
</section>
