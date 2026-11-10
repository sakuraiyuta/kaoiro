import "./isolation.setup";
// @vitest-environment jsdom
// Issue #537: the room dialog. A move and a delete show how many conversations
// they would close before anything is sent, cancelling sends nothing, and a
// refusal is shown by its code.
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/lib/i18n/index.svelte";
import RoomDialog from "../src/lib/RoomDialog.svelte";
import type { Room, RoomRequest } from "../src/lib/rooms";

HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

const ROOMS: Room[] = [{ id: "lobby", name: null }, { id: "r1", name: "Review" }, { id: "r2", name: "Docs" }];
const MOVE: RoomRequest = { mode: "move", agentId: "h.a", label: "Target", currentRoomId: "lobby" };

let mounted: object | null = null;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
});

function makeApi() {
  return {
    createRoom: vi.fn(async (name: string) => ({ id: "new", name })),
    renameRoom: vi.fn(async (id: string, name: string) => ({ id, name })),
    deleteRoom: vi.fn(async () => ({ closedCount: 1, movedCount: 2 })),
    moveAgent: vi.fn(async () => ({ closedCount: 2, movedCount: 1 })),
    previewRoomMove: vi.fn(async () => ({ closingCount: 2, memberCount: 1 })),
    previewRoomDelete: vi.fn(async () => ({ closingCount: 1, memberCount: 2 })),
  };
}

async function open(request: RoomRequest, api = makeApi()) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onReload = vi.fn();
  mounted = mount(RoomDialog, { target: document.body, props: { request, rooms: ROOMS, api, onClose, onDone, onReload } });
  await tick();
  return { api, onClose, onDone, onReload };
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const settled = async () => { await tick(); await vi.waitFor(() => expect(text()).not.toContain("確認しています")); };

describe("move", () => {
  it("shows the previewed count before anything is sent, then moves on confirm", async () => {
    const api = makeApi();
    let answer!: (value: { closingCount: number; memberCount: number }) => void;
    api.previewRoomMove.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { onDone } = await open(MOVE, api);
    expect(button("移動する")!.disabled).toBe(true);
    expect(text()).toContain("閉じる会話の件数を確認しています");
    answer({ closingCount: 2, memberCount: 1 });
    await settled();

    expect(api.previewRoomMove).toHaveBeenCalledWith("h.a", "r1");
    expect(text()).toContain("この移動で 2 件の会話が閉じます。");
    expect(text()).toContain("件数は確認した時点の目安です");
    expect(api.moveAgent).not.toHaveBeenCalled();

    button("移動する")!.click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.moveAgent).toHaveBeenCalledExactlyOnceWith("h.a", "r1");
    expect(onDone).toHaveBeenCalledWith("Target を Review へ移動しました。閉じた会話は 2 件です。");
  });

  it("sends nothing but the preview when cancelled", async () => {
    const { api, onClose } = await open(MOVE);
    await settled();

    button("キャンセル")!.click();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.moveAgent).not.toHaveBeenCalled();
    expect(api.deleteRoom).not.toHaveBeenCalled();
  });

  it("previews the room chosen last and ignores a slower answer for the first one", async () => {
    const api = makeApi();
    let answerFirst!: (value: { closingCount: number; memberCount: number }) => void;
    api.previewRoomMove
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockImplementationOnce(async () => ({ closingCount: 7, memberCount: 1 }));
    await open(MOVE, api);

    const select = document.querySelector<HTMLSelectElement>("select")!;
    select.value = "r2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(text()).toContain("この移動で 7 件の会話が閉じます。"));
    answerFirst({ closingCount: 1, memberCount: 1 });
    await tick();

    expect(api.previewRoomMove).toHaveBeenLastCalledWith("h.a", "r2");
    expect(text()).toContain("この移動で 7 件の会話が閉じます。");
    expect(text()).not.toContain("この移動で 1 件");
  });

  it("offers every room but the current one, and says so when there is none", async () => {
    await open(MOVE);
    expect([...document.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Review", "Docs"]);
    await unmount(mounted!);
    mounted = null;
    document.body.innerHTML = "";

    const api = makeApi();
    mounted = mount(RoomDialog, {
      target: document.body,
      props: { request: MOVE, rooms: [ROOMS[0]!], api, onClose: vi.fn(), onDone: vi.fn(), onReload: vi.fn() },
    });
    await tick();
    expect(text()).toContain("移動先にできる部屋がありません");
    expect(button("移動する")!.disabled).toBe(true);
    expect(api.previewRoomMove).not.toHaveBeenCalled();
  });

  it("keeps the confirm button off when the preview fails, and shows why", async () => {
    const api = makeApi();
    api.previewRoomMove.mockRejectedValueOnce(new Error("rooms_unavailable"));
    await open(MOVE, api);
    await vi.waitFor(() => expect(text()).toContain("サーバが部屋の情報を保存または読み取れませんでした"));
    expect(button("移動する")!.disabled).toBe(true);
  });
});

describe("a refused request", () => {
  async function refuse(code: string) {
    const api = makeApi();
    api.moveAgent.mockRejectedValueOnce(new Error(code));
    const opened = await open(MOVE, api);
    await settled();
    button("移動する")!.click();
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")).not.toBeNull());
    return opened;
  }

  it("shows a known code in words and stays open", async () => {
    const { onDone } = await refuse("unknown_room");
    expect(text()).toContain("その部屋は存在しません");
    expect(onDone).not.toHaveBeenCalled();
    expect(button("読み直す")).toBeUndefined();
  });

  it("shows an unknown code as it is", async () => {
    await refuse("brand_new_code");
    expect(text()).toContain("失敗しました (brand_new_code)");
  });

  it.each(["room_change_unconfirmed", "timeout"])("offers a reload after %s, and reloads only when asked", async (code) => {
    const { onReload, onClose } = await refuse(code);
    expect(onReload).not.toHaveBeenCalled();

    button("読み直す")!.click();

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("delete", () => {
  it("shows how many agents return and how many conversations close, then deletes on confirm", async () => {
    const { api, onDone } = await open({ mode: "delete", room: ROOMS[1]! });
    await settled();

    expect(api.previewRoomDelete).toHaveBeenCalledWith("r1");
    expect(text()).toContain("この部屋の 2 件の agent は ロビー に戻ります。");
    expect(text()).toContain("この削除で 1 件の会話が閉じます。");

    button("削除する")!.click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.deleteRoom).toHaveBeenCalledExactlyOnceWith("r1");
    expect(onDone).toHaveBeenCalledWith("部屋 Review を削除しました。agent 2 件の所属を戻し、会話 1 件を閉じました。");
  });
});

describe("create and rename", () => {
  it("will not send a blank name, and sends the trimmed one", async () => {
    const { api, onDone } = await open({ mode: "create" });
    expect(button("部屋を作成")!.disabled).toBe(true);

    const input = document.querySelector<HTMLInputElement>("input")!;
    input.value = "  Review  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    button("部屋を作成")!.click();

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(api.createRoom).toHaveBeenCalledExactlyOnceWith("Review");
  });

  it("starts a rename from the name on show, the lobby's default name included", async () => {
    const { api } = await open({ mode: "rename", room: ROOMS[0]! });
    expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("ロビー");
    button("改名")!.click();
    await vi.waitFor(() => expect(api.renameRoom).toHaveBeenCalledExactlyOnceWith("lobby", "ロビー"));
  });
});

describe("language", () => {
  it("repaints the title, the sentence and the buttons on a switch, and keeps the names as typed", async () => {
    await open(MOVE);
    await settled();
    expect(document.querySelector("h2")?.textContent).toBe("Target を別の部屋へ移動");

    setLocale("en");
    await tick();

    expect(document.querySelector("h2")?.textContent).toBe("Move Target to another room");
    expect(text()).toContain("2 conversations will be closed by this move.");
    expect(button("Move")).toBeDefined();
    expect(button("Cancel")).toBeDefined();
    expect([...document.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Review", "Docs"]);
  });
});
