import { describe, expect, it } from "vitest";
import { toManagedChild } from "../src/spawn.js";

/** A child stub that can emit `exit` and `error` separately. */
class FakeChild {
  readonly #exit: Array<() => void> = [];
  readonly #error: Array<() => void> = [];
  kills = 0;
  on(event: "exit" | "error", listener: () => void): void {
    (event === "exit" ? this.#exit : this.#error).push(listener);
  }
  kill(): void {
    this.kills += 1;
  }
  emitExit(): void {
    for (const listener of [...this.#exit]) listener();
  }
  emitError(): void {
    for (const listener of [...this.#error]) listener();
  }
}

describe("toManagedChild", () => {
  it("exit で 1 回発火する", () => {
    const child = new FakeChild();
    let n = 0;
    toManagedChild(child).on("exit", () => (n += 1));
    child.emitExit();
    expect(n).toBe(1);
  });

  it("error でも発火する(spawn 失敗を取りこぼさない)", () => {
    const child = new FakeChild();
    let n = 0;
    toManagedChild(child).on("exit", () => (n += 1));
    child.emitError();
    expect(n).toBe(1);
  });

  it("error と exit が両方来ても 1 回だけ発火する", () => {
    const child = new FakeChild();
    let n = 0;
    toManagedChild(child).on("exit", () => (n += 1));
    child.emitError();
    child.emitExit();
    expect(n).toBe(1);
  });

  it("kill を委譲する", () => {
    const child = new FakeChild();
    toManagedChild(child).kill();
    expect(child.kills).toBe(1);
  });
});
