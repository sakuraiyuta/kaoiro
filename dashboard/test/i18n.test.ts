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

import { parseSessionResetFailed } from "../src/lib/protocol";

it.each(["en", "ja"] as const)("explains both authentication refusals in %s", (locale) => {
  setLocale(locale);
  for (const reason of ["engine_auth_unsupported", "engine_auth_invalid"]) {
    const notice = { request_id: "request", agent_id: "agent", mode: "new", reason };
    expect(parseSessionResetFailed(notice)?.reason).toBe(reason);
    for (const text of [
      msg().app.spawnFailed({ label: "agent", reason }),
      msg().app.restoreFailed({ reason }),
      msg().app.sessionResetFailed({ mode: "new", reason, hint: null }),
    ]) {
      expect(text).toContain(reason);
      expect(text).toContain("antigravity.auth");
      if (reason === "engine_auth_invalid") expect(text).toContain("google-cloud-adc");
    }
  }
});

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
