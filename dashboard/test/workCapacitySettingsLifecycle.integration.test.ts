import "./isolation.setup";
// @vitest-environment jsdom
// issue 800: the connection / generation effect clears the edit marks even
// when the snapshot stays ready. App nulls the snapshot on every disconnect
// and join, so the snapshot's else branch always clears them first; only a
// direct mount with a changed connection or generation observes this path.
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkSettingsSnapshot } from "@kaoiro/protocol";
import WorkCapacitySettings from "../src/lib/WorkCapacitySettings.svelte";
import type { KaoiroConnection } from "../src/lib/protocol";
import { reactiveProps } from "./reactiveProps.svelte";

const ready: WorkSettingsSnapshot = {
  version: "0", state: "ready", revision: 42,
  overrides: {},
  effective: { work_nominated_per_principal: 16, work_active_per_assignee: 16 },
  fallbacks: { work_nominated_per_principal: 16, work_active_per_assignee: 16 },
  sources: { work_nominated_per_principal: "default", work_active_per_assignee: "default" },
  last_change: null,
};

let component: object | null = null;

const fakeConnection = () => ({
  getWorkSettings: vi.fn(),
  setWorkSettings: vi.fn(),
}) as unknown as KaoiroConnection;

async function render(connection: KaoiroConnection | undefined, generation: number) {
  const target = document.createElement("div");
  document.body.append(target);
  const props = reactiveProps({
    connection,
    generation,
    snapshot: ready as WorkSettingsSnapshot | null,
    onSnapshot: vi.fn(),
  });
  component = mount(WorkCapacitySettings, { target, props });
  await tick();
  return { target, props };
}

const input = (target: HTMLElement) => target.querySelector<HTMLInputElement>("input")!;
const saveButton = (target: HTMLElement) =>
  Array.from(target.querySelectorAll("button")).find(b => b.textContent === "保存")!;

async function editNominated(target: HTMLElement) {
  input(target).value = "0";
  input(target).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

describe("WorkCapacitySettings edit-mark lifetime (issue 800)", () => {
  it("clears the edit marks when the generation changes with the snapshot still ready", async () => {
    const { target, props } = await render(fakeConnection(), 1);
    await editNominated(target);
    expect(saveButton(target).disabled).toBe(false);
    props.generation = 2;
    await tick();
    expect(saveButton(target).disabled).toBe(true);
  });

  it("clears the edit marks when the connection object is replaced with the snapshot still ready", async () => {
    const { target, props } = await render(fakeConnection(), 1);
    await editNominated(target);
    expect(saveButton(target).disabled).toBe(false);
    props.connection = fakeConnection();
    await tick();
    expect(saveButton(target).disabled).toBe(true);
  });
});
