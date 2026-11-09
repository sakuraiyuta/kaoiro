<script lang="ts">
  // The approval view of the device authorization grant (issue 801, design
  // §4.3): entry -> confirm -> done, with error in between. `needs_login` is
  // not here: before login there is no dashboard, so App.svelte shows it as a
  // line on the login card.
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import {
    decideDeviceCode,
    formatRemaining,
    lookupDeviceCode,
    writeDeviceEntry,
    type DeviceDecision,
    type DeviceError,
    type DeviceLookup,
  } from "./deviceApproval";
  import { intlTag, msg } from "./i18n/index.svelte";
  import { formatRelative } from "./relativeTime";

  let {
    initialCode,
    available,
    providers,
    onClose,
  }: {
    /** What the verification URI or the tab's stored state carried. */
    initialCode: string | null;
    /** False when `auth-methods` said the server does not offer device approval. */
    available: boolean;
    /** OAuth providers to log in with again, for a 401 or a shared-token 403. */
    providers: { id: string; label: string }[];
    onClose: () => void;
  } = $props();

  type View =
    | { kind: "entry" }
    | { kind: "confirm"; info: DeviceLookup }
    | { kind: "done"; decision: DeviceDecision }
    | { kind: "error"; error: DeviceError };

  let view = $state<View>(
    untrack(() => (available ? { kind: "entry" } : { kind: "error", error: { kind: "unavailable" } })),
  );
  let code = $state(untrack(() => initialCode ?? ""));
  let busy = $state(false);

  function close(): void {
    // A decision in flight cannot be taken back, so the dialog stays until its
    // answer is shown.
    if (!busy) onClose();
  }

  async function submitCode(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const typed = code.trim();
    if (typed === "" || busy) return;
    busy = true;
    const result = await lookupDeviceCode(typed);
    busy = false;
    view = result.ok ? { kind: "confirm", info: result.value } : { kind: "error", error: result.error };
  }

  async function decide(info: DeviceLookup, decision: DeviceDecision): Promise<void> {
    busy = true;
    const result = await decideDeviceCode(info.userCode, decision);
    busy = false;
    view = result.ok ? { kind: "done", decision } : { kind: "error", error: result.error };
  }

  // Going out to log in again keeps the tab's "started" state (design §4.3),
  // written before the browser leaves the page.
  function rememberForLogin(): void {
    const typed = code.trim();
    writeDeviceEntry(sessionStorage, { started: true, code: typed === "" ? null : typed });
  }

  function issuedAtText(issuedAt: string): string | null {
    const parsed = Date.parse(issuedAt);
    if (Number.isNaN(parsed)) return null;
    const absolute = new Date(parsed).toLocaleString(intlTag(), { hour12: false });
    return `${absolute} (${formatRelative(issuedAt, Date.now())})`;
  }

  function errorText(error: DeviceError): string {
    const t = msg().deviceApproval;
    switch (error.kind) {
      case "unknown_code":
        return t.unknownCode;
      case "expired":
        return t.expired;
      case "rate_limited":
        return t.rateLimited({ seconds: error.retryAfter ?? 0 });
      case "already_decided":
        return t.alreadyDecided;
      case "unauthorized":
        return t.unauthorized;
      case "oauth_session_required":
        return t.oauthSessionRequired;
      case "unavailable":
        return t.unavailable;
      case "generic":
        return t.generic;
    }
  }

  const needsLogin = (error: DeviceError): boolean =>
    error.kind === "unauthorized" || error.kind === "oauth_session_required";
</script>

<Modal ariaLabel={msg().deviceApproval.title} onClose={close} contentClass="device-approval">
  <header class="head">
    <h2>{msg().deviceApproval.title}</h2>
    <button type="button" class="close" onclick={close} disabled={busy} aria-label={msg().common.close}>✕</button>
  </header>

  {#if view.kind === "entry"}
    <form onsubmit={submitCode}>
      <label for="device-user-code">{msg().deviceApproval.enterCode}</label>
      <input
        id="device-user-code"
        type="text"
        bind:value={code}
        placeholder="XXX-XXX-XXX"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        disabled={busy}
      />
      <button type="submit" disabled={busy || code.trim() === ""}>
        {busy ? msg().deviceApproval.checking : msg().deviceApproval.check}
      </button>
    </form>
  {:else if view.kind === "confirm"}
    {@const info = view.info}
    {@const issued = issuedAtText(info.issuedAt)}
    <dl class="info">
      <dt>code</dt>
      <dd class="code">{info.userCode}</dd>
      <dt>client</dt>
      <dd>{info.clientId} <span class="note">{msg().deviceApproval.selfReported}</span></dd>
      {#if issued !== null}
        <dt>{msg().deviceApproval.issued}</dt>
        <dd>{issued}</dd>
      {/if}
      <dt>{msg().deviceApproval.remaining}</dt>
      <dd>{formatRemaining(info.expiresIn)}</dd>
      <dt>{msg().deviceApproval.identityToApprove}</dt>
      <dd>{info.identity.provider} / {info.identity.uid}</dd>
      <dt>role</dt>
      <dd>{info.role}</dd>
    </dl>
    <p class="note">{msg().deviceApproval.connectsAs}</p>
    <p class="warn">
      {msg().deviceApproval.verifyWarning}
    </p>
    <div class="actions">
      <button type="button" disabled={busy} onclick={() => void decide(info, "approve")}>{msg().deviceApproval.approve}</button>
      <button type="button" disabled={busy} onclick={() => void decide(info, "deny")}>{msg().deviceApproval.deny}</button>
    </div>
  {:else if view.kind === "done"}
    {#if view.decision === "approve"}
      <p role="status">{msg().deviceApproval.approved}</p>
    {:else}
      <p role="status">{msg().deviceApproval.denied}</p>
    {/if}
    <div class="actions">
      <button type="button" onclick={close}>{msg().common.close}</button>
    </div>
  {:else}
    {@const error = view.error}
    <p role="alert">{errorText(error)}</p>
    <div class="actions">
      {#if needsLogin(error)}
        {#each providers as provider (provider.id)}
          <a class="button" href={`/auth/${provider.id}`} onclick={rememberForLogin}>
            {msg().deviceApproval.loginWith({ provider: provider.label })}
          </a>
        {/each}
      {:else if error.kind !== "unavailable"}
        <button type="button" onclick={() => (view = { kind: "entry" })}>{msg().deviceApproval.enterAgain}</button>
      {/if}
      <button type="button" onclick={close}>{msg().common.close}</button>
    </div>
  {/if}
</Modal>

<style>
  :global(.modal-content.device-approval) {
    width: min(30rem, 92vw);
    max-height: 80vh;
    overflow-y: auto;
    padding: 1rem 1.2rem;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-body);
  }

  .close {
    border-radius: 0;
    padding: 1px 6px;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  form label { font-size: var(--fs-body-sm); }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.8rem;
  }

  p {
    margin: 0.6rem 0;
    overflow-wrap: anywhere;
  }

  .note {
    font-size: var(--fs-body-sm);
    color: var(--fg-dim);
  }

  .warn {
    font-size: var(--fs-body-sm);
  }

  .info {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3rem 0.8rem;
    margin: 0.8rem 0 0;
  }

  .info dt {
    color: var(--fg-dim);
    font-size: var(--fs-body-sm);
  }

  .info dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .code {
    font-family: monospace;
    font-size: var(--fs-body);
    letter-spacing: 0.05em;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-top: 0.8rem;
  }

  .button {
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: inherit;
    text-decoration: none;
  }
</style>
