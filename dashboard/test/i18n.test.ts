import "./isolation.setup";
import { describe, expect, it } from "vitest";
import {
  currentLocale,
  intlTag,
  msg,
  resolveLocale,
  setLocale,
} from "../src/lib/i18n/index.svelte";
import { plural } from "../src/lib/i18n/en/plural";

describe("resolveLocale (issue #269, B1)", () => {
  it("auto takes the first supported language of the list", () => {
    expect(resolveLocale("auto", ["ja-JP", "en-US"])).toBe("ja");
    expect(resolveLocale("auto", ["en-US", "ja"])).toBe("en");
    expect(resolveLocale("auto", ["fr", "ja"])).toBe("ja");
    expect(resolveLocale("auto", ["fr"])).toBe("en");
    expect(resolveLocale("auto", [])).toBe("en");
  });

  it("matches the primary subtag case-insensitively and rejects look-alikes", () => {
    expect(resolveLocale("auto", ["JA"])).toBe("ja");
    expect(resolveLocale("auto", ["en-GB"])).toBe("en");
    expect(resolveLocale("auto", ["jam", "ja"])).toBe("ja");
    expect(resolveLocale("auto", ["ent", "fr"])).toBe("en");
  });

  it("an explicit choice wins over the browser's languages", () => {
    expect(resolveLocale("ja", ["en-US"])).toBe("ja");
    expect(resolveLocale("en", ["ja-JP"])).toBe("en");
  });
});

describe("locale state", () => {
  it("msg() and intlTag() follow setLocale without a reload", () => {
    setLocale("ja");
    expect(currentLocale()).toBe("ja");
    expect(msg().common.close).toBe("閉じる");
    expect(intlTag()).toBe("ja-JP");
    setLocale("en");
    expect(currentLocale()).toBe("en");
    expect(msg().common.close).toBe("Close");
    expect(intlTag()).toBe("en-US");
  });
});

describe("plural", () => {
  it("writes the singular only for 1", () => {
    expect(plural(1, "agent", "agents")).toBe("1 agent");
    expect(plural(0, "agent", "agents")).toBe("0 agents");
    expect(plural(2, "agent", "agents")).toBe("2 agents");
  });
});
