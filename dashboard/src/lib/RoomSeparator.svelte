<script lang="ts">
  import { msg } from "./i18n/index.svelte";
  import { roomName, type Room } from "./rooms";

  // One full-width row of the agent grid: a rule, the room name, how many
  // tiles it holds and, for an operator, the controls that apply to it. A
  // control is shown only when its handler is given (the lobby cannot be
  // deleted; a group of unconfirmed rooms is not a room). `reorder` adds the
  // up/down pair (this browser's display order, not a room change, so anyone
  // may use it); a `null` side is the end of the list and is shown disabled.
  let { room, count, onRename, onDelete, reorder }: {
    room: Room | "unknown";
    count: number;
    onRename?: (() => void) | undefined;
    onDelete?: (() => void) | undefined;
    reorder?: { up: (() => void) | null; down: (() => void) | null } | undefined;
  } = $props();

  const title = $derived(room === "unknown" ? msg().rooms.unknownGroup : roomName(room));
</script>

<li class="room-header" data-room={room === "unknown" ? "unknown" : room.id}>
  <h3>{title}</h3>
  <span class="count">{msg().rooms.memberCount({ n: count })}</span>
  {#if reorder !== undefined}
    <button
      type="button"
      class="reorder"
      disabled={reorder.up === null}
      onclick={reorder.up ?? undefined}
      aria-label={msg().rooms.reorderUpAria({ name: title })}
    >
      {msg().rooms.reorderUp}
    </button>
    <button
      type="button"
      class="reorder"
      disabled={reorder.down === null}
      onclick={reorder.down ?? undefined}
      aria-label={msg().rooms.reorderDownAria({ name: title })}
    >
      {msg().rooms.reorderDown}
    </button>
  {/if}
  {#if onRename !== undefined}
    <button type="button" onclick={onRename} aria-label={msg().rooms.renameAria({ name: title })}>
      {msg().rooms.renameButton}
    </button>
  {/if}
  {#if onDelete !== undefined}
    <button type="button" class="danger" onclick={onDelete} aria-label={msg().rooms.deleteAria({ name: title })}>
      {msg().rooms.deleteButton}
    </button>
  {/if}
  {#if count === 0}<span class="empty">{msg().rooms.emptyRoom}</span>{/if}
</li>

<style>
  .room-header {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.8rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--line);
    overflow-wrap: anywhere;
  }

  h3 {
    margin: 0;
    font-size: var(--fs-h2);
  }

  .count, .empty {
    color: var(--fg-dim);
    font-size: var(--fs-body-sm);
  }

  button {
    font-size: var(--fs-body-sm);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    padding: 0.15rem 0.6rem;
    cursor: pointer;
    color: var(--fg-dim);
  }

  button:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  button.danger {
    color: var(--c-error);
    border-color: var(--c-error);
  }
</style>
