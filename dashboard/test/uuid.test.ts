import { afterEach, describe, expect, it, vi } from "vitest";

import { randomUUID } from "../src/lib/uuid";

const V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Insecure-context crypto: getRandomValues only, no randomUUID
// (what a plain-HTTP deployment, KAOIRO_PLAIN_HTTP, exposes).
const insecureCrypto = {
  getRandomValues: (buf: Uint8Array): Uint8Array => {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
    return buf;
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomUUID", () => {
  it("returns a v4 UUID via the native API when available", () => {
    expect(randomUUID()).toMatch(V4_RE);
  });

  it("falls back to getRandomValues in insecure contexts", () => {
    vi.stubGlobal("crypto", insecureCrypto);
    expect(randomUUID()).toMatch(V4_RE);
  });

  it("fallback output is unique across calls", () => {
    vi.stubGlobal("crypto", insecureCrypto);
    expect(randomUUID()).not.toBe(randomUUID());
  });
});
