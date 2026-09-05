import { describe, expect, it } from "vitest";
import { MAX_LOG_BYTES } from "../src/logpayload.js";
import { boundErrorDetail, redactCredentials } from "../src/redact.js";

const TOKEN = "abcdef1234567890";
const MASKED_TOKEN = "************7890";

describe("redactCredentials (issue #300 round 2)", () => {
  it("masks an sk-style API key to its last 4 characters", () => {
    expect(redactCredentials("key=sk-abcdefghijklmnopqrstuvwxyz")).toBe(
      "key=sk-**********************wxyz",
    );
  });

  it("masks an Authorization/Bearer header value, including the scheme word (issue #300 round 4, finding M-C)", () => {
    // The scheme word ("Bearer" here) is swept into the same masked run as
    // the credential -- see the round-4 comment above the Authorization/
    // Bearer regex in redact.ts for why this file no longer tries to keep
    // it readable.
    expect(redactCredentials("Authorization: Bearer abcdef123456")).toBe(
      "Authorization: ***************3456",
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
    // makeResult (the actual choke point, called by every engine's own
    // result path) masks AFTER codex's codexExecFailureRelay already
    // masked upstream (mask-before-clip ordering requires the upstream
    // call; makeResult's own masking is a backstop for producers that
    // bypass the relay) -- so the same text can pass through
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

  it("does not match a keyword glued onto a preceding letter (negative control)", () => {
    const text = "xBearer token";
    expect(redactCredentials(text)).toBe(text);
  });

  it("does not match api_key glued onto a preceding letter (negative control)", () => {
    // Left-boundary sibling of the "xBearer token" case above -- pins
    // that LEFT_BOUNDARY's rejection applies to api_key too, not only
    // the Authorization/Bearer pattern (issue #300 round 3 review).
    const text = "myapi_key=x";
    expect(redactCredentials(text)).toBe(text);
  });
});

describe("redactCredentials — round 3 finding M-A: compact-JSON value leak (issue #300)", () => {
  it("masks the exact reported fixture: compact-JSON Authorization/Bearer with no whitespace", () => {
    // Root cause (クロエ's live measurement): with no whitespace, the OLD
    // `\S+` value class swallowed `":"Bearer` whole (a closing quote,
    // colon, opening quote, and the literal word "Bearer") as if it were
    // the secret -- leaving the REAL token, after the next space,
    // completely untouched. This is the third sighting of "value class
    // crosses a delimiter it shouldn't" (after api_key's own JSON-quoted
    // form and the underscore left-boundary bug), so the fix is a shared
    // VALUE_CLASS/separator, not a one-off patch. (The scheme word
    // "Bearer" itself is masked along with the token as of round 4,
    // finding M-C -- see the redact.ts comment above the regex.)
    expect(
      redactCredentials('{"Authorization":"Bearer abc123456789"}'),
    ).toBe('{"Authorization":"***************6789"}');
  });

  // 3 keywords x 4 separator/quoting forms -- the grid this class of
  // defect keeps surfacing in one cell at a time. Each cell name doubles
  // as the failure-mode label a future regression would fall under.
  it.each([
    ["Authorization", "plain", `Authorization: ${TOKEN}`, `Authorization: ${MASKED_TOKEN}`],
    ["Authorization", "assign", `Authorization=${TOKEN}`, `Authorization=${MASKED_TOKEN}`],
    [
      "Authorization",
      "json_spaced",
      `"Authorization": "${TOKEN}"`,
      `"Authorization": "${MASKED_TOKEN}"`,
    ],
    [
      "Authorization",
      "json_compact",
      `"Authorization":"${TOKEN}"`,
      `"Authorization":"${MASKED_TOKEN}"`,
    ],
    ["Bearer", "plain", `Bearer: ${TOKEN}`, `Bearer: ${MASKED_TOKEN}`],
    ["Bearer", "assign", `Bearer=${TOKEN}`, `Bearer=${MASKED_TOKEN}`],
    ["Bearer", "json_spaced", `"Bearer": "${TOKEN}"`, `"Bearer": "${MASKED_TOKEN}"`],
    ["Bearer", "json_compact", `"Bearer":"${TOKEN}"`, `"Bearer":"${MASKED_TOKEN}"`],
    ["api_key", "plain", `api_key: ${TOKEN}`, `api_key: ${MASKED_TOKEN}`],
    ["api_key", "assign", `api_key=${TOKEN}`, `api_key=${MASKED_TOKEN}`],
    ["api_key", "json_spaced", `"api_key": "${TOKEN}"`, `"api_key": "${MASKED_TOKEN}"`],
    ["api_key", "json_compact", `"api_key":"${TOKEN}"`, `"api_key":"${MASKED_TOKEN}"`],
  ])("%s / %s masks and is idempotent", (_keyword, _form, input, expected) => {
    const once = redactCredentials(input);
    expect(once).toBe(expected);
    expect(redactCredentials(once)).toBe(once);
  });
});

describe("redactCredentials — round 4 finding M-C: non-Bearer Authorization schemes (issue #300)", () => {
  // Root cause (クロエ's live measurement, 8/25 LEAK on the acceptance
  // probe): the compound alternative hardcoded the literal keyword
  // "Bearer", so any OTHER scheme -- Basic, Digest, Token, ApiKey, or an
  // unregistered vendor scheme -- fell through to the bare "Authorization"
  // alternative instead, which then masked the SCHEME WORD ITSELF (the
  // first thing after "Authorization: ") and left the real credential,
  // one word further along, completely untouched.
  //
  // A first fix tried to CLASSIFY the word after "Authorization" as
  // either a scheme or the credential (a length cap: short words are a
  // scheme, long ones are the value). Live mutation testing (クロエ)
  // showed that is not decidable from shape alone and just moves the
  // failure: `Authorization: <token> failed` regressed to treating the
  // real (short) token as a "scheme" and masking "failed" instead. This
  // version does not classify at all -- it masks up to TWO consecutive
  // whitespace-joined words as one combined value, so whichever one is
  // the real credential ends up inside the masked run either way. Cost,
  // accepted (see redact.ts's own "over-masking is the safe failure
  // mode" header comment): the scheme keyword itself is no longer
  // readable in the output.
  it.each([
    ["Basic", `Authorization: Basic ${TOKEN}`, "Authorization: ******************7890"],
    ["Token", `Authorization: Token ${TOKEN}`, "Authorization: ******************7890"],
    [
      "unregistered vendor scheme",
      `Authorization: Vendor-Xyz ${TOKEN}`,
      "Authorization: ***********************7890",
    ],
    [
      "Basic, JSON-compact",
      `{"Authorization":"Basic ${TOKEN}"}`,
      '{"Authorization":"******************7890"}',
    ],
  ])("masks the scheme word and the credential after a %s scheme together", (_scheme, input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  // The actual regression this redesign exists to close (review-cycle
  // finding: the prior grid above only varied the SCHEME WORD, never the
  // TRAILING PROSE that broke the rejected SCHEME_CLASS classifier
  // attempt). A scheme-less or short credential immediately followed by
  // an ordinary word must still end up fully inside the masked run,
  // whichever of the two adjacent words the "up to 2 tokens" capture
  // treats as the credential.
  it.each([
    ["scheme-less, trailing prose", `Authorization: ${TOKEN} failed`, "Authorization: *******************iled"],
    [
      "Bearer, trailing prose",
      `Authorization: Bearer ${TOKEN} failed to renew`,
      "Authorization: *******************7890 failed to renew",
    ],
    [
      "assign form, trailing prose",
      `Authorization=${TOKEN} rejected`,
      "Authorization=*********************cted",
    ],
    [
      "JSON form, trailing prose outside the string",
      `{"Authorization":"${TOKEN}"} rejected`,
      '{"Authorization":"************7890"} rejected',
    ],
  ])("never leaves the real credential unmasked (%s)", (_label, input, expected) => {
    const out = redactCredentials(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(TOKEN);
  });
});

describe("boundErrorDetail (issue #300 round 3, finding M-B: the mask-then-clip transform makeResult applies)", () => {
  it("masks a credential and stays under the byte bound for ordinary text", () => {
    expect(boundErrorDetail("api_key=abcdef123456")).toBe(
      "api_key=********3456",
    );
  });

  it("clips oversized text to MAX_LOG_BYTES", () => {
    const oversized = "x".repeat(MAX_LOG_BYTES + 100);
    const detail = boundErrorDetail(oversized);
    expect(Buffer.byteLength(detail, "utf8")).toBe(MAX_LOG_BYTES);
  });

  it("masks a credential near the start of oversized text (both transforms apply in one call)", () => {
    // `clipText` is a HEAD clip (keeps the first MAX_LOG_BYTES bytes), so
    // a keyword+value pair near the start keeps its own anchor within the
    // kept region regardless of transform order here -- unlike
    // codexExecFailureRelay's TAIL clip, this does not by itself prove an
    // ordering requirement (see boundErrorDetail's doc comment), but it
    // does pin that masking still fires when the input is oversized. The
    // filler starts with a newline so the api_key value class (which
    // stops at whitespace) does not greedily swallow it too.
    const secret = "api_key=abcdef123456";
    const after = `\n${"y".repeat(MAX_LOG_BYTES)}`;
    const detail = boundErrorDetail(`${secret}${after}`);
    expect(Buffer.byteLength(detail, "utf8")).toBe(MAX_LOG_BYTES);
    expect(detail.startsWith("api_key=********3456\n")).toBe(true);
  });

  it("leaves short, non-secret text unchanged", () => {
    const text = "tool crashed: EACCES";
    expect(boundErrorDetail(text)).toBe(text);
  });
});
