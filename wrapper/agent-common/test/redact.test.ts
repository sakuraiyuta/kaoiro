import { describe, expect, it } from "vitest";
import { redactCredentials } from "../src/redact.js";

describe("redactCredentials (issue #300 round 2)", () => {
  it("masks an sk-style API key to its last 4 characters", () => {
    expect(redactCredentials("key=sk-abcdefghijklmnopqrstuvwxyz")).toBe(
      "key=sk-**********************wxyz",
    );
  });

  it("masks an Authorization/Bearer header value, keeping the keyword", () => {
    expect(redactCredentials("Authorization: Bearer abcdef123456")).toBe(
      "Authorization: Bearer ********3456",
    );
  });

  it("masks a bare api_key assignment", () => {
    expect(redactCredentials("api_key=abcdef123456")).toBe(
      "api_key=********3456",
    );
  });

  it("masks a 4-or-fewer character value in full", () => {
    expect(redactCredentials("api_key=ab12")).toBe("api_key=****");
  });

  it("masks a hyphenated api-key with spaces around the separator", () => {
    expect(redactCredentials("api-key = abcdef1234567890")).toBe(
      "api-key = ************7890",
    );
  });

  it("masks a JSON-quoted api_key field, preserving the quotes", () => {
    expect(redactCredentials('{"api_key": "abcdef1234567890"}')).toBe(
      '{"api_key": "************7890"}',
    );
  });

  it("masks an underscore-prefixed Authorization value with no literal \"Bearer\" keyword (issue #300 round 2 review finding: sibling of the api_key \\b defect)", () => {
    // Regression: the api_key pattern's left boundary was fixed to a
    // negative lookbehind, but the Authorization/Bearer pattern right
    // above it kept the original `\b`, which has the identical defect --
    // an underscore-joined env-var name (e.g. the CGI/WSGI-style
    // HTTP_AUTHORIZATION) carrying the token directly, with no separate
    // "Bearer" keyword, rode through completely unmasked.
    expect(
      redactCredentials("HTTP_AUTHORIZATION=abcdef123456verylongtoken"),
    ).toBe("HTTP_AUTHORIZATION=*********************oken");
  });

  it("masks an sk- key glued to a preceding identifier via underscore (same left-boundary class, proactively closed alongside the Authorization fix)", () => {
    expect(
      redactCredentials("MY_TOKEN_sk-abcdefghijklmnopqrstuvwxyz"),
    ).toBe("MY_TOKEN_sk-**********************wxyz");
  });

  it("masks an env-var-style prefixed key (issue #300 review finding: \\b misses an underscore-joined prefix)", () => {
    // Regression: `\b` never matches between an underscore and a letter
    // (both are \w), so `OPENAI_API_KEY=`/`CODEX_API_KEY=` -- a real path
    // per ADR-0032 F7, since the SDK passes environment variables through
    // to the child process -- rode through completely unmasked.
    expect(redactCredentials("OPENAI_API_KEY=abcdef1234567890")).toBe(
      "OPENAI_API_KEY=************7890",
    );
    expect(redactCredentials("CODEX_API_KEY=abcdef1234567890")).toBe(
      "CODEX_API_KEY=************7890",
    );
    expect(redactCredentials("openai_api_key=abcdef1234567890")).toBe(
      "openai_api_key=************7890",
    );
  });

  it("leaves ordinary text untouched (negative control)", () => {
    const text = "Reading prompt from stdin...\nthread failed to start";
    expect(redactCredentials(text)).toBe(text);
  });

  it("leaves filesystem paths untouched", () => {
    const text = "config not found at /home/operator/.codex/config.toml";
    expect(redactCredentials(text)).toBe(text);
  });

  it("is idempotent on its own output (issue #300 round 2: two call sites can both mask the same text)", () => {
    // codex's #emitResult masks at the choke point AFTER
    // codexExecFailureRelay already masked upstream (mask-before-clip
    // ordering requires the upstream call; the choke point is a backstop
    // for producers that bypass it) -- so the same text can pass through
    // redactCredentials twice. Two DIFFERENT reasons make each pattern a
    // fixed point, and both must be pinned: a naive "one case is enough"
    // check would miss a future maskValue change (e.g. to a fixed
    // "[REDACTED]" replacement) that breaks one reason but not the other.
    //
    // Reason A (re-matches, but the match is already a fixed point):
    // maskValue is a same-length substitution that always reveals only
    // its OWN input's last 4 characters -- those characters are the
    // same on every pass, so re-masking an already-masked api_key/
    // Authorization value reproduces byte-for-byte the same output.
    const apiKeyOnce = redactCredentials("api_key=abcdef123456");
    expect(redactCredentials(apiKeyOnce)).toBe(apiKeyOnce);
    const authOnce = redactCredentials("Authorization: Bearer abcdef123456");
    expect(redactCredentials(authOnce)).toBe(authOnce);
    // Reason B (does not re-match at all): the sk- pattern's value
    // character class (`[A-Za-z0-9_-]`) excludes `*`, so a masked
    // "sk-****...wxyz" no longer satisfies the pattern on a second pass
    // -- unchanged because nothing matches, not because the match is a
    // fixed point.
    const skOnce = redactCredentials("key=sk-abcdefghijklmnopqrstuvwxyz");
    expect(redactCredentials(skOnce)).toBe(skOnce);
  });

  it("does not match a keyword glued onto a longer word with no separator (negative control)", () => {
    // "apikeyword" contains "apikey" as a literal substring; nothing after
    // it is a `[:=]` separator, so this must not match at all -- pins the
    // right-boundary behavior the left-boundary fix above must not break.
    const text = "apikeyword is a word";
    expect(redactCredentials(text)).toBe(text);
  });
});
