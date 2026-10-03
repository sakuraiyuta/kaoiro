// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatusLineHistoryDialog from "../src/lib/StatusLineHistoryDialog.svelte";
import type { StatusLineHistoryEntry } from "../src/lib/statusLine";
import { renderUntrustedMarkdown } from "../src/lib/untrustedMarkdown";
import { reactiveObject } from "./reactiveObject.svelte";

// The real renderer, observed: the dialog must parse markdown for the entries
// the operator actually looks at, and for no others.
vi.mock("../src/lib/untrustedMarkdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/untrustedMarkdown")>();
  return { ...actual, renderUntrustedMarkdown: vi.fn(actual.renderUntrustedMarkdown) };
});

// jsdom does not implement HTMLDialogElement.showModal/close; the Modal
// primitive calls them on mount.
if (
  typeof HTMLDialogElement !== "undefined" &&
  typeof HTMLDialogElement.prototype.showModal !== "function"
) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

const mounted: object[] = [];
const renderCalls = () => vi.mocked(renderUntrustedMarkdown).mock.calls.length;

beforeEach(() => {
  vi.mocked(renderUntrustedMarkdown).mockClear();
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
});

function entry(seq: number, text: string | null, updatedAt = `2026-10-03T12:00:${String(seq % 60).padStart(2, "0")}.000000Z`): StatusLineHistoryEntry {
  return { seq, text, bytes: text === null ? null : text.length, updatedAt };
}

/** A log of `n` entries, newest first: seq n .. 1. */
function log(n: number, text = (seq: number) => `entry ${seq}`): StatusLineHistoryEntry[] {
  return Array.from({ length: n }, (_, i) => entry(n - i, text(n - i)));
}

async function open(
  fetchHistory: (agentId: string) => Promise<StatusLineHistoryEntry[]>,
  props: { refreshKey?: string | null } = {},
) {
  const state = reactiveObject({ agentId: "a.one", refreshKey: props.refreshKey ?? "k0" });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(StatusLineHistoryDialog, {
      target,
      props: {
        get agentId() { return state.agentId; },
        label: "あお",
        fetchHistory,
        get refreshKey() { return state.refreshKey; },
        onClose: () => {},
      },
    }),
  );
  await vi.waitFor(() => expect(target.querySelector(".loading")).toBeNull());
  await tick();
  return { target, state };
}

const items = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>("li.entry")];

describe("StatusLineHistoryDialog", () => {
  it("renders only the latest entry as markdown when it opens, however long the log is", async () => {
    const { target } = await open(async () => log(100));

    expect(items(target)).toHaveLength(100);
    expect(renderCalls()).toBe(1);
    expect(items(target)[0]!.querySelector(".untrusted-markdown")).not.toBeNull();
    // Older entries show their first line as plain text, and offer to expand.
    expect(items(target)[1]!.querySelector(".first-line")?.textContent).toBe("entry 99");
    expect(items(target)[1]!.querySelector(".toggle")?.textContent).toBe("展開");
  });

  it("parses nothing for 99 collapsed pathological entries", async () => {
    const hostile = ">".repeat(3000);
    const { target } = await open(async () => [entry(100, "# latest"), ...log(99, () => hostile).map((e, i) => ({ ...e, seq: 99 - i }))]);

    expect(items(target)).toHaveLength(100);
    expect(renderCalls()).toBe(1);
  });

  it("renders an older entry only once it is expanded, and not again on collapse", async () => {
    const { target } = await open(async () => log(5, (seq) => `# heading ${seq}`));
    expect(renderCalls()).toBe(1);

    items(target)[2]!.querySelector<HTMLButtonElement>(".toggle")!.click();
    await tick();

    expect(renderCalls()).toBe(2);
    expect(items(target)[2]!.querySelector("h1")?.textContent).toBe("heading 3");
    expect(items(target)[2]!.querySelector(".toggle")?.textContent).toBe("折りたたむ");

    items(target)[2]!.querySelector<HTMLButtonElement>(".toggle")!.click();
    await tick();

    expect(items(target)[2]!.querySelector("h1")).toBeNull();
    expect(renderCalls()).toBe(2);
  });

  it("re-reads on a new line, parses only the new latest, and does not re-parse an expanded entry", async () => {
    let current = log(5, (seq) => `# heading ${seq}`);
    const { target, state } = await open(async () => current);
    items(target)[3]!.querySelector<HTMLButtonElement>(".toggle")!.click();
    await tick();
    expect(renderCalls()).toBe(2);

    current = [entry(6, "# heading 6"), ...current];
    state.refreshKey = "k1";
    await vi.waitFor(() => expect(items(target)).toHaveLength(6));
    await tick();

    expect(renderCalls()).toBe(3);
    expect(items(target)[0]!.querySelector("h1")?.textContent).toBe("heading 6");
    // The expanded entry (seq 2) is still expanded, with the same rendering.
    expect(items(target).find((li) => li.dataset.seq === "2")!.querySelector("h1")?.textContent).toBe("heading 2");
  });

  it("shows a clear as (クリア) with no markdown", async () => {
    const { target } = await open(async () => [entry(3, null), entry(2, "was set"), entry(1, null)]);

    expect(items(target)[0]!.querySelector(".cleared")?.textContent).toBe("(クリア)");
    expect(items(target)[2]!.querySelector(".cleared")?.textContent).toBe("(クリア)");
    expect(renderCalls()).toBe(0);
  });

  it("renders the latest as sanitized markdown and shows hostile markup literally", async () => {
    const { target } = await open(async () => [entry(1, "# Title\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1))")]);

    expect(target.querySelector("h1")?.textContent).toBe("Title");
    expect(target.querySelector("img")).toBeNull();
    expect(target.querySelector("a")).toBeNull();
    expect(target.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("says so when there is no log", async () => {
    const { target } = await open(async () => []);

    expect(target.querySelector(".empty")?.textContent).toBe("履歴はありません");
  });

  it("clears the list and says the log cannot be shown when the agent left the set the viewer may see", async () => {
    let fail = false;
    const { target, state } = await open(async () => {
      if (fail) throw new Error("unknown_agent");
      return log(3);
    });
    expect(items(target)).toHaveLength(3);

    fail = true;
    state.refreshKey = "k1";
    await vi.waitFor(() => expect(target.querySelector(".notice")).not.toBeNull());

    expect(target.querySelector(".notice")?.textContent).toBe("このエージェントの履歴は現在表示できません");
    expect(items(target)).toHaveLength(0);
  });

  it("keeps the last log and says it is temporarily unavailable", async () => {
    let fail = false;
    const { target, state } = await open(async () => {
      if (fail) throw new Error("status_line_unavailable");
      return log(3);
    });

    fail = true;
    state.refreshKey = "k1";
    await vi.waitFor(() => expect(target.querySelector(".notice")).not.toBeNull());

    expect(target.querySelector(".notice")?.textContent).toBe("履歴を一時的に取得できません");
    expect(items(target)).toHaveLength(3);
  });

  it("clears the notice once a later read succeeds", async () => {
    let fail = true;
    const { target, state } = await open(async () => {
      if (fail) throw new Error("status_line_unavailable");
      return log(2);
    });
    expect(target.querySelector(".notice")).not.toBeNull();

    fail = false;
    state.refreshKey = "k1";
    await vi.waitFor(() => expect(items(target)).toHaveLength(2));

    expect(target.querySelector(".notice")).toBeNull();
  });

  it("ignores a reply that arrives after a newer read", async () => {
    const resolvers: Array<(entries: StatusLineHistoryEntry[]) => void> = [];
    const fetchHistory = () => new Promise<StatusLineHistoryEntry[]>((resolve) => resolvers.push(resolve));
    const state = reactiveObject({ refreshKey: "k0" });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(StatusLineHistoryDialog, {
        target,
        props: {
          agentId: "a.one",
          label: "あお",
          fetchHistory,
          get refreshKey() { return state.refreshKey; },
          onClose: () => {},
        },
      }),
    );
    await tick();
    state.refreshKey = "k1";
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1]!(log(2));
    await vi.waitFor(() => expect(items(target)).toHaveLength(2));
    resolvers[0]!(log(5));
    await tick();
    await Promise.resolve();

    expect(items(target)).toHaveLength(2);
  });
});
