import "./isolation.setup";
// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetail from "../src/lib/AgentDetail.svelte";
import { agentDetail } from "../src/lib/i18n/ja/agentDetail";
import type { Envelope, KaoiroConnection } from "../src/lib/protocol";

const mounted: object[] = [];
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Composer attachment categories", () => {
  it.each([
    [undefined, ["screen.png", "script.js", "notes.txt", "unknown"]],
    [["image"], ["screen.png"]],
    [["text"], ["script.js", "notes.txt"]],
    [["image", "text"], ["screen.png", "script.js", "notes.txt"]],
    [["pdf"], []],
  ])("uses the advertised categories for picker, paste and drop: %j", async (
    categories, expected,
  ) => {
    const target = document.createElement("div");
    document.body.append(target);
    const envelope: Envelope = {
      version: "0", agent_id: "host-a.a", state: "waiting_input",
      type: "state_change", ts: "2026-11-28T00:00:00Z", payload: {},
      persona: { id: "p", name: "P", sprite_set: "p" },
      ext: { session_capabilities: {
        supports_attachments: true,
        supports_user_input_dialog: true,
        ...(categories ? { attachment_types: categories } : {}),
      } },
    };
    const connection = {
      sendInstruction: vi.fn(),
      uploadFile: vi.fn(),
    } as unknown as KaoiroConnection;
    mounted.push(mount(AgentDetail, {
      target,
      props: { envelope, connection, onClose: vi.fn() },
    }));
    await tick();
    const files = [
      new File(["image"], "screen.png", { type: "image/png" }),
      new File(["js"], "script.js", { type: "application/javascript" }),
      new File(["text"], "notes.txt", { type: "text/plain" }),
      new File(["unknown"], "unknown"),
    ];
    const input = target.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.disabled).toBe(expected.length === 0);
    if (categories?.includes("text")) {
      expect(input.parentElement?.title).toBe(categories.includes("image")
        ? agentDetail.attachImagesAndTextTitle
        : agentDetail.attachTextTitle);
    }
    for (const eventName of ["change", "paste", "drop"]) {
      const event = new Event(eventName, { bubbles: true, cancelable: true });
      if (eventName === "change") {
        Object.defineProperty(input, "files", { configurable: true, value: files });
        input.dispatchEvent(event);
      } else if (eventName === "paste") {
        Object.defineProperty(event, "clipboardData", { value: { files } });
        target.querySelector("form.instruct textarea")!.dispatchEvent(event);
      } else {
        Object.defineProperty(event, "dataTransfer", {
          value: { types: ["Files"], files },
        });
        input.dispatchEvent(event);
      }
      await tick();
      const rendered = [...target.querySelectorAll<HTMLElement>(".staged-name")];
      expect(rendered.map(element => element.title.split(" (")[0]))
        .toEqual(expected);
      for (const remove of target.querySelectorAll<HTMLButtonElement>(".staged button")) {
        remove.click();
        flushSync();
      }
    }
    expect(input.accept.includes("text/*"))
      .toBe(categories === undefined || categories.includes("text"));
    expect(input.accept.includes("image/"))
      .toBe(categories === undefined || categories.includes("image"));
  });
});
