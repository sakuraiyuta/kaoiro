import { afterEach, describe, expect, it } from "vitest";
import { resolveWrapperLaunch, toManagedChild } from "../src/spawn.js";

describe("resolveWrapperLaunch", () => {
  afterEach(() => {
    delete process.env.KAOIRO_WRAPPER_DEV;
  });

  it("prod は dist の cli を 1 つ返す", () => {
    delete process.env.KAOIRO_WRAPPER_DEV;
    const prefix = resolveWrapperLaunch();
    expect(prefix).toHaveLength(1);
    expect(prefix[0]).toMatch(/claude-code\/dist\/cli\.js$/);
  });

  it("KAOIRO_WRAPPER_DEV で tsx watch + src を返す(ホットリロード)", () => {
    process.env.KAOIRO_WRAPPER_DEV = "1";
    const prefix = resolveWrapperLaunch();
    expect(prefix).toHaveLength(3);
    expect(prefix[0]).toMatch(/tsx/);
    expect(prefix[1]).toBe("watch");
    expect(prefix[2]).toMatch(/claude-code\/src\/cli\.ts$/);
  });
});

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
