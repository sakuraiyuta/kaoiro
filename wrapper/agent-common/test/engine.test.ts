import { describe, expect, it } from "vitest";
import { mergePendingPersonaSync } from "../src/engine.js";

describe("mergePendingPersonaSync (issue #197 段階3, D15 review follow-up)", () => {
  it("current が undefined なら常に採用する", () => {
    expect(mergePendingPersonaSync(undefined, "あお", 1)).toEqual({
      name: "あお",
      revision: 1,
    });
  });

  it("revision が current より大きければ上書きする", () => {
    const current = { name: "古い", revision: 1 };
    expect(mergePendingPersonaSync(current, "新しい", 2)).toEqual({
      name: "新しい",
      revision: 2,
    });
  });

  // このテストが本件の核心: 素の代入 (`pendingPersonaSync = { name, revision }`)
  // だと、より高い revision を先に受けた後により低い revision (broadcast
  // 順序の入れ替わりで遅延到着した古い rename) が来ると、後着優先で古い方が
  // 勝ってしまう。D15 の「巻き戻らない」不変条件を pre-host バッファでも
  // 維持できているかを固定する。
  it("revision が current 以下なら current を維持する (古い方には巻き戻らない)", () => {
    const current = { name: "新しい", revision: 2 };
    expect(mergePendingPersonaSync(current, "古い", 1)).toBe(current);
    expect(mergePendingPersonaSync(current, "同revision再送", 2)).toBe(
      current,
    );
  });

  it("3 件が到着順を入れ替えても、最終的に revision 最大の値が残る", () => {
    // rev 2 → rev 1 (遅延到着、無視されるべき) → rev 3 の順で届いたケース。
    let pending = mergePendingPersonaSync(undefined, "二回目", 2);
    pending = mergePendingPersonaSync(pending, "一回目(遅延)", 1);
    pending = mergePendingPersonaSync(pending, "三回目", 3);
    expect(pending).toEqual({ name: "三回目", revision: 3 });
  });
});
