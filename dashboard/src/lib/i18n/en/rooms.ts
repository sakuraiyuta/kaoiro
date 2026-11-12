import type { Messages } from "../ja";
import { plural } from "./plural";

export const rooms = {
  lobbyDefaultName: "Lobby",
  unknownGroup: "Room not confirmed",
  memberCount: ({ n }) => plural(n, "agent", "agents"),
  emptyRoom: "No agents in this room",
  createButton: "Create room",
  renameButton: "Rename",
  renameAria: ({ name }) => `Rename room ${name}`,
  deleteButton: "Delete",
  deleteAria: ({ name }) => `Delete room ${name}`,
  reorderUp: "↑",
  reorderUpAria: ({ name }) => `Move room ${name} up`,
  reorderDown: "↓",
  reorderDownAria: ({ name }) => `Move room ${name} down`,
  moveButton: "Change room",
  moveAria: ({ name }) => `Move ${name} to another room`,
  createTitle: "Create a room",
  renameTitle: ({ name }) => `Rename room ${name}`,
  nameLabel: "Room name",
  namePlaceholder: "e.g. Review",
  working: "Working…",
  moveTitle: ({ name }) => `Move ${name} to another room`,
  moveCurrentRoom: ({ room }) => `Current room: ${room}`,
  moveDestinationLabel: "Move to",
  noDestination: "There is no other room to move to",
  moveClosing: ({ n }) =>
    n === 0
      ? "No conversation will be closed by this move."
      : `${plural(n, "conversation", "conversations")} will be closed by this move.`,
  moveConfirm: "Move",
  deleteTitle: ({ name }) => `Delete room ${name}`,
  deleteMembers: ({ n, lobby }) =>
    n === 0
      ? "There are no agents in this room."
      : `${plural(n, "agent", "agents")} in this room will return to ${lobby}.`,
  deleteClosing: ({ n }) =>
    n === 0
      ? "No conversation will be closed by this deletion."
      : `${plural(n, "conversation", "conversations")} will be closed by this deletion.`,
  deleteConfirm: "Delete",
  previewNote:
    "The count is an estimate from when it was checked. It may change before the request runs.",
  previewLoading: "Checking how many conversations will close…",
  previewFailed: ({ code }) =>
    `Cannot check how many conversations will close (${code}). Close this dialog and open it again.`,
  reload: "Reload",
  movedNotice: ({ name, room, closed }) =>
    `Moved ${name} to ${room}. ${plural(closed, "conversation", "conversations")} closed.`,
  deletedNotice: ({ room, moved, closed }) =>
    `Deleted room ${room}. ${plural(moved, "agent", "agents")} returned, ${plural(closed, "conversation", "conversations")} closed.`,
  error: {
    forbidden: "Not allowed (only an operator can do this)",
    invalid_room_name:
      "The room name is not valid (it cannot be blank, contain control characters or be too long)",
    missing_room_id: "No room was given",
    unknown_room: "That room does not exist",
    rooms_unavailable: "The server could not save or read its rooms",
    room_change_unconfirmed:
      "It is not certain whether the change was applied. Reload to check",
    timeout:
      "The server did not answer. It is not certain whether the change was applied. Reload to check",
    invalid_reply:
      "The server's answer could not be read. It is not certain whether the change was applied. Reload to check",
    lobby_protected: "The lobby cannot be deleted",
    unknown_agent: "That agent does not exist",
    invalid_agent_id: "The agent is not valid",
    missing_agent_id: "No agent was given",
  },
  errorUnknown: ({ code }) => `Failed (${code})`,
} satisfies Messages["rooms"];
