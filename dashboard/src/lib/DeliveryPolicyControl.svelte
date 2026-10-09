<script lang="ts">
  import { deliveryPolicyLabel, hasDeliveryMechanism, unknownDeliveryPolicy,
    type DeliveryPolicy, type DeliveryPolicyView } from "./deliveryPolicy";
  let { agentId, view = unknownDeliveryPolicy(), connected, available = false, saving = false,
    reading = false, notice = "", generation = 0, onChange, onRefresh }: {
    agentId: string; view?: DeliveryPolicyView | undefined; connected: boolean; available?: boolean;
    saving?: boolean | undefined; reading?: boolean | undefined; notice?: string | undefined; generation?: number;
    onChange?: ((policy: DeliveryPolicy) => void) | undefined; onRefresh?: (() => void) | undefined;
  } = $props();
  const writable = $derived(available && connected && view.policy !== "unknown" &&
    view.revision !== undefined && view.wrapper_support && hasDeliveryMechanism(view.mechanisms) && !saving);
  let checked = $state(false);
  $effect(() => { if (!saving) checked = view.policy === "on"; });
  let attempted = "";
  $effect(() => {
    const key = `${generation}:${agentId}`;
    if (available && onRefresh && view.policy === "unknown" && attempted !== key) {
      attempted = key;
      onRefresh();
    }
  });
</script>

<section class="delivery-policy" aria-label="実行中の割込配送">
  <strong>実行中の割込配送</strong>
  <p>保存設定: {view.policy}</p>
  <p role="status" aria-live="polite">{saving ? "保存中" : notice || deliveryPolicyLabel(view, connected)}</p>
  {#if !available}<p>この server の操作 API は未確認</p>{/if}
  {#if view.mechanisms}
    <p>あなたから: {view.mechanisms.operator_early} / エージェント間: {view.mechanisms.inter_agent_early}</p>
    <p>エージェント間の停止: {view.mechanisms.inter_agent_yield === "none" ? "非対応" : "ツール境界"}
      {#if view.mechanisms.inter_agent_early === "steer" && view.mechanisms.inter_agent_yield === "none"}（early のみ）{/if}</p>
  {/if}
  {#if view.policy === "off"}<p>すでに受け付けた処理は完了する場合があります。</p>{/if}
  {#if onChange}
    <label><input type="checkbox" bind:checked disabled={!writable}
      onchange={(event) => { if (writable) onChange?.(event.currentTarget.checked ? "on" : "off"); }} />
      割込配送を許可する</label>
  {/if}
  {#if onRefresh && available}<button type="button" disabled={reading} onclick={onRefresh}>配送状態を再取得</button>{/if}
  <p class="help">対応する配送方法での受け付けを許可します。配送の成功を保証する設定ではありません。</p>
</section>

<style>
  .delivery-policy { border-top: 1px solid var(--border, #555); padding: .75rem 0; font-size: .8rem; overflow-wrap: anywhere; }
  p { margin: .35rem 0; }
  label { display: flex; align-items: center; gap: .4rem; min-height: 2.75rem; }
  button { margin: .35rem 0; min-height: 2.75rem; }
  .help { opacity: .75; }
</style>
