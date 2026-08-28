// @vitest-environment jsdom
// PersonaDetailDialog (issue #232): manifest.json の全メタデータ +
// personality.md 全文を fetchPersonaPackDetail 経由で表示する。読み込み中
// /失敗時の表示、close ボタン・backdrop クリックでの onClose、homepage の
// http(s) 限定リンク化を固定する。
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonaDetailDialog from "../src/lib/PersonaDetailDialog.svelte";
import { fetchPersonaPackDetail } from "../src/lib/protocol";
import type { PersonaPackDetail } from "../src/lib/protocol";

vi.mock("../src/lib/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/protocol")>();
  return { ...actual, fetchPersonaPackDetail: vi.fn() };
});

const mounted: object[] = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function detail(overrides: Partial<PersonaPackDetail> = {}): PersonaPackDetail {
  return {
    id: "fuji",
    name: "ふじ",
    sprite_set: "fuji",
    version: "1.0.2",
    license: "CC0-1.0",
    min_kaoiro_version: "0.1.0",
    states: ["idle", "thinking"],
    description: "説明文",
    author: "author-fuji",
    personality: "personality body",
    ...overrides,
  };
}

async function render(onClose = vi.fn()) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(PersonaDetailDialog, {
    target,
    props: { personaId: "fuji", onClose },
  });
  mounted.push(component);
  await tick();
  return { target, onClose };
}

describe("PersonaDetailDialog", () => {
  it("解決前は読み込み中を表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockReturnValue(new Promise(() => {}));
    const { target } = await render();

    expect(target.querySelector(".note")?.textContent).toContain("読み込み中");
  });

  it("manifest 全メタデータと personality 全文を表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(fetchPersonaPackDetail).toHaveBeenCalledWith("fuji");
    expect(target.querySelector("h2")?.textContent).toBe("ふじ");
    const text = target.textContent ?? "";
    expect(text).toContain("fuji");
    expect(text).toContain("1.0.2");
    expect(text).toContain("CC0-1.0");
    expect(text).toContain("0.1.0");
    expect(text).toContain("idle, thinking");
    expect(text).toContain("説明文");
    expect(text).toContain("author-fuji");
    expect(target.querySelector(".personality")?.textContent).toBe(
      "personality body",
    );
  });

  it("任意フィールド (author/homepage) 欠落時はその行を出さない", async () => {
    // exactOptionalPropertyTypes: `detail({ author: undefined })` is a type
    // error (the key existing with an undefined value differs from the key
    // being absent) — omit the keys entirely instead of overriding them.
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue({
      id: "fuji",
      name: "ふじ",
      sprite_set: "fuji",
      version: "1.0.2",
      license: "CC0-1.0",
      min_kaoiro_version: "0.1.0",
      states: ["idle", "thinking"],
      personality: "personality body",
    });
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(target.querySelector(".meta")?.textContent).not.toContain("author");
    expect(target.querySelector(".meta")?.textContent).not.toContain(
      "homepage",
    );
  });

  it("homepage が http(s) ならリンク化する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(
      detail({ homepage: "https://example.test/fuji" }),
    );
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    const link = target.querySelector<HTMLAnchorElement>(".meta a");
    expect(link?.href).toBe("https://example.test/fuji");
    expect(link?.rel).toContain("noopener");
    expect(link?.target).toBe("_blank");
  });

  it("homepage が http(s) 以外ならリンク化せずテキストのまま表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(
      detail({ homepage: "javascript:alert(1)" }),
    );
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    expect(target.querySelector(".meta a")).toBeNull();
    expect(target.querySelector(".meta")?.textContent).toContain(
      "javascript:alert(1)",
    );
  });

  it("取得失敗時はエラーメッセージを表示する", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(null);
    const { target } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")?.textContent).toContain(
        "取得に失敗",
      );
    });
  });

  it("close ボタンで onClose を呼ぶ", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target, onClose } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    target
      .querySelector<HTMLButtonElement>("button.close")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop クリックで onClose を呼ぶ", async () => {
    vi.mocked(fetchPersonaPackDetail).mockResolvedValue(detail());
    const { target, onClose } = await render();
    await vi.waitFor(() => {
      expect(target.querySelector(".note")).toBeNull();
    });

    target
      .querySelector<HTMLElement>(".backdrop")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
