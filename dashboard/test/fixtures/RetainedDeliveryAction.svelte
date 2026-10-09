<script lang="ts">
  import { onMount } from "svelte";
  let { onDeliveryPolicyChange }: {
    onDeliveryPolicyChange?: (id: string, policy: "on" | "off") => void;
  } = $props();
  let retained: typeof onDeliveryPolicyChange;
  onMount(() => { retained = onDeliveryPolicyChange; });
</script>
<!-- Retain a previously rendered callback to isolate App's action guard from render/store guards. -->
<button type="button" data-retained-delivery onclick={() => retained?.("host-a.p", "off")}>Retained action</button>
