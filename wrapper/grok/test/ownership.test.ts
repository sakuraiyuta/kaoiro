import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import { PromptOwnership } from "../src/grok/ownership.js";

function owning(id = "kaoiro-own") {
  const ownership = new PromptOwnership();
  ownership.begin(id);
  return ownership;
}

describe("prompt ownership", () => {
  it("owns only the id it began, and only until it ends", () => {
    const ownership = owning();
    expect(ownership.isOwn("kaoiro-own")).toBe(true);
    expect(ownership.isOwn("task-completed-1")).toBe(false);
    expect(ownership.isOwn(undefined)).toBe(false);
    ownership.end();
    expect(ownership.isOwn("kaoiro-own")).toBe(false);
  });

  it("attributes an update without a prompt id to the running prompt, else to none", () => {
    const ownership = owning();
    expect(ownership.promptOf(undefined)).toBeUndefined();
    ownership.setRunning("task-completed-1");
    expect(ownership.promptOf(undefined)).toBe("task-completed-1");
    expect(ownership.promptOf("kaoiro-own")).toBe("kaoiro-own");
  });

  it("allows a permission only for a call an own tool_call recorded", () => {
    const ownership = owning();
    ownership.recordToolCall("own-call", "kaoiro-own");
    ownership.recordToolCall("foreign-call", "task-completed-1");
    expect(ownership.permissionIsOwn("own-call")).toBe(true);
    expect(ownership.permissionIsOwn("foreign-call")).toBe(false);
  });

  it("refuses a call no tool_call recorded", () => {
    expect(owning().permissionIsOwn("never-seen")).toBe(false);
  });

  it("keeps a call foreign when an own tool_call later claims it", () => {
    const ownership = owning();
    ownership.recordToolCall("call", "task-completed-1");
    ownership.recordToolCall("call", "kaoiro-own");
    expect(ownership.permissionIsOwn("call")).toBe(false);
  });

  it("keeps a call ownerless when a foreign tool_call follows an own one", () => {
    const ownership = owning();
    ownership.recordToolCall("call", "kaoiro-own");
    ownership.recordToolCall("call", "task-completed-1");
    expect(ownership.permissionIsOwn("call")).toBe(false);
  });

  it("never allows a refused call, even after an own tool_call records it", () => {
    const ownership = owning();
    ownership.refuse("call");
    ownership.recordToolCall("call", "kaoiro-own");
    expect(ownership.permissionIsOwn("call")).toBe(false);
  });

  it("gives a reading only to the prompt that was running when it was taken", () => {
    const ownership = owning();
    ownership.setRunning("task-completed-1");
    ownership.recordReading(7000);
    expect(ownership.takeReading("task-completed-1")).toBe(7000);
    ownership.recordReading(8000);
    ownership.setRunning("kaoiro-own");
    expect(ownership.takeReading("kaoiro-own")).toBeUndefined();
    ownership.recordReading(9000);
    expect(ownership.takeReading("kaoiro-own")).toBe(9000);
    expect(ownership.takeReading("kaoiro-own")).toBeUndefined();
  });
});
