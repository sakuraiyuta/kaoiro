export const ROOM_FOLD_STORAGE_KEY = "kaoiro.roomFold.v1";

export function loadRoomFold(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ROOM_FOLD_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export function saveRoomFold(keys: readonly string[]): void {
  try {
    localStorage.setItem(ROOM_FOLD_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Display preference is best effort.
  }
}
