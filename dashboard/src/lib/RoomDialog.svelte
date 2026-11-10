<script lang="ts">
  import { untrack } from "svelte";
  import { msg } from "./i18n/index.svelte";
  import Modal from "./Modal.svelte";
  import type { KaoiroConnection } from "./protocol";
  import { LOBBY_ID, isUnconfirmed, roomErrorText, roomName, type Room, type RoomRequest } from "./rooms";

  // Create, rename, move and delete share one dialog. A move and a delete
  // first ask the server how many conversations they would close and show the
  // count; cancelling sends nothing. The count is advisory (the real request
  // decides again), and the confirm button waits for it.
  let { request, rooms, api, onClose, onDone, onReload }: {
    request: RoomRequest;
    rooms: Room[];
    api: Pick<
      KaoiroConnection,
      "createRoom" | "renameRoom" | "deleteRoom" | "moveAgent" | "previewRoomMove" | "previewRoomDelete"
    >;
    onClose: () => void;
    /** The request succeeded: close the dialog and show `notice` if any. */
    onDone: (notice: string | null) => void;
    /** The operator asked to read the rooms again (a rejoin). */
    onReload: () => void;
  } = $props();

  type Preview =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; closing: number; members: number }
    | { kind: "error"; code: string };

  const destinations = $derived(
    request.mode === "move" ? rooms.filter((room) => room.id !== request.currentRoomId) : [],
  );
  const lobbyName = $derived(roomName(rooms.find((room) => room.id === LOBBY_ID) ?? { id: LOBBY_ID, name: null }));

  let name = $state(untrack(() => (request.mode === "rename" ? roomName(request.room) : "")));
  let destination = $state(untrack(() => destinations[0]?.id ?? ""));
  let preview = $state<Preview>({ kind: "idle" });
  let busy = $state(false);
  let error = $state<string | null>(null);
  let previewSeq = 0;

  function codeOf(failure: unknown): string {
    return failure instanceof Error ? failure.message : "error";
  }

  $effect(() => {
    const target = destination;
    const seq = ++previewSeq;
    const current = () => seq === previewSeq;
    untrack(() => {
      let call: ReturnType<typeof api.previewRoomMove> | null = null;
      if (request.mode === "delete") call = api.previewRoomDelete(request.room.id);
      else if (request.mode === "move" && target !== "") call = api.previewRoomMove(request.agentId, target);
      if (call === null) {
        preview = { kind: "idle" };
        return;
      }
      preview = { kind: "loading" };
      call.then(
        (reply) => { if (current()) preview = { kind: "ok", closing: reply.closingCount, members: reply.memberCount }; },
        (failure: unknown) => { if (current()) preview = { kind: "error", code: codeOf(failure) }; },
      );
    });
  });

  const title = $derived.by(() => {
    switch (request.mode) {
      case "create": return msg().rooms.createTitle;
      case "rename": return msg().rooms.renameTitle({ name: roomName(request.room) });
      case "move": return msg().rooms.moveTitle({ name: request.label });
      case "delete": return msg().rooms.deleteTitle({ name: roomName(request.room) });
    }
  });
  const confirmLabel = $derived(
    request.mode === "create" ? msg().rooms.createButton
      : request.mode === "rename" ? msg().rooms.renameButton
      : request.mode === "move" ? msg().rooms.moveConfirm
      : msg().rooms.deleteConfirm,
  );
  const needsName = $derived(request.mode === "create" || request.mode === "rename");
  const canConfirm = $derived(
    !busy && (needsName ? name.trim() !== "" : preview.kind === "ok"),
  );

  async function confirm(): Promise<void> {
    if (!canConfirm) return;
    busy = true;
    error = null;
    try {
      if (request.mode === "create") {
        await api.createRoom(name.trim());
        onDone(null);
      } else if (request.mode === "rename") {
        await api.renameRoom(request.room.id, name.trim());
        onDone(null);
      } else if (request.mode === "move") {
        const target = rooms.find((room) => room.id === destination);
        const result = await api.moveAgent(request.agentId, destination);
        onDone(msg().rooms.movedNotice({
          name: request.label,
          room: target === undefined ? destination : roomName(target),
          closed: result.closedCount,
        }));
      } else {
        const result = await api.deleteRoom(request.room.id);
        onDone(msg().rooms.deletedNotice({
          room: roomName(request.room),
          moved: result.movedCount,
          closed: result.closedCount,
        }));
      }
    } catch (failure) {
      error = codeOf(failure);
    } finally {
      busy = false;
    }
  }
</script>

<Modal ariaLabel={title} {onClose} contentClass="room-dialog">
  <h2>{title}</h2>
  <form onsubmit={(event) => { event.preventDefault(); void confirm(); }}>
    {#if needsName}
      <label>
        {msg().rooms.nameLabel}
        <!-- svelte-ignore a11y_autofocus -- inside a native <dialog> opened
             with showModal() (Modal.svelte), autofocus is the sanctioned
             initial-focus mechanism. -->
        <input type="text" bind:value={name} placeholder={msg().rooms.namePlaceholder} autofocus />
      </label>
    {:else if request.mode === "move"}
      <p>{msg().rooms.moveCurrentRoom({
        room: request.currentRoomId === null
          ? msg().rooms.unknownGroup
          : roomName(rooms.find((room) => room.id === request.currentRoomId) ?? { id: request.currentRoomId, name: null }),
      })}</p>
      {#if destinations.length === 0}
        <p>{msg().rooms.noDestination}</p>
      {:else}
        <label>
          {msg().rooms.moveDestinationLabel}
          <select bind:value={destination}>
            {#each destinations as room (room.id)}
              <option value={room.id}>{roomName(room)}</option>
            {/each}
          </select>
        </label>
      {/if}
    {/if}
    {#if preview.kind === "loading"}
      <p role="status">{msg().rooms.previewLoading}</p>
    {:else if preview.kind === "error"}
      <p role="alert" class="error">{roomErrorText(preview.code)}</p>
    {:else if preview.kind === "ok"}
      {#if request.mode === "delete"}
        <p>{msg().rooms.deleteMembers({ n: preview.members, lobby: lobbyName })}</p>
        <p>{msg().rooms.deleteClosing({ n: preview.closing })}</p>
      {:else}
        <p>{msg().rooms.moveClosing({ n: preview.closing })}</p>
      {/if}
      <p class="note">{msg().rooms.previewNote}</p>
    {/if}
    {#if error !== null}
      <p role="alert" class="error">{roomErrorText(error)}</p>
      {#if isUnconfirmed(error)}
        <button type="button" onclick={() => { onReload(); onClose(); }}>{msg().rooms.reload}</button>
      {/if}
    {/if}
    <div class="actions">
      <button type="button" onclick={onClose}>{msg().common.cancel}</button>
      <button type="submit" class:danger={request.mode === "delete"} disabled={!canConfirm}>
        {busy ? msg().rooms.working : confirmLabel}
      </button>
    </div>
  </form>
</Modal>

<style>
  :global(.modal-content.room-dialog) { width: min(32rem, calc(100vw - 2rem)); overflow-wrap: anywhere; }
  h2 { font-size: var(--fs-h2); margin-top: 0; }
  label { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.8rem; }
  input, select { font: inherit; padding: 0.3rem 0.5rem; }
  .note { color: var(--fg-dim); font-size: var(--fs-body-sm); }
  .error { color: var(--c-error); font-size: var(--fs-body-sm); }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
  button {
    font-size: var(--fs-body-sm);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.35rem 0.8rem;
    cursor: pointer;
    color: var(--fg-dim);
  }
  button:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-dim); }
  button.danger { color: var(--c-error); border-color: var(--c-error); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
