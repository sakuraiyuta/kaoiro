// Credential-shaped substring redaction for operator-facing error text
// (protocol.md `result.error_detail`: "credential-shaped substrings are
// redacted ... before clipping"). Every engine adapter's error_detail
// generation point applies this same pass before its own clipText, so the
// same wire field carries the same guarantee regardless of which SDK
// produced the text (issue #300 round 2: the guarantee previously existed
// only for Codex, and only incompletely). A pattern match, not a full
// secret scanner: it may occasionally mask non-secret text following these
// keywords -- over-masking is the safe failure mode for a redaction pass,
// under-masking is not. Deliberately does NOT touch filesystem paths
// (including home directories) -- those are not credentials.

/** Masks a matched secret-shaped value to security.md's convention (at
 *  most the last 4 characters visible). A value of 4 or fewer characters
 *  is masked in full -- revealing all of it is not masking. */
function maskValue(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

// None of the three patterns' LEFT boundary uses `\b`: an underscore is a
// word character, so `\b` never matches between it and a following
// letter/digit, and would miss real env-var-style prefixes this text can
// carry (`OPENAI_API_KEY=`, `HTTP_AUTHORIZATION=...` -- issue #300 review
// findings M1 and its sibling, same underscore-adjacency defect class,
// found one pattern at a time and fixed uniformly here instead of
// per-pattern). A negative lookbehind for a letter/digit allows any
// non-alphanumeric character (including `_`, quotes, braces, whitespace,
// or start-of-string) immediately before the keyword, while still
// rejecting a keyword glued onto a preceding identifier (e.g. `myapi_key`,
// `xBearer`).
const LEFT_BOUNDARY = "(?<![A-Za-z0-9])";

/** Redacts the three credential shapes this text can plausibly carry: an
 *  OpenAI-style API key, an Authorization/Bearer header value, and an
 *  api_key assignment (bare `api_key=value` or JSON-quoted
 *  `"api_key": "value"`). */
export function redactCredentials(text: string): string {
  let masked = text.replace(
    new RegExp(`${LEFT_BOUNDARY}(sk-)([A-Za-z0-9_-]{16,})\\b`, "g"),
    (_match, prefix: string, value: string) => `${prefix}${maskValue(value)}`,
  );
  // The compound alternative ("Authorization: Bearer <token>") must be
  // tried before the two bare keywords, or a plain "Authorization|Bearer"
  // alternation matches "Authorization" first and treats the word "Bearer"
  // itself as the value to mask, leaving the actual token right after it
  // untouched.
  masked = masked.replace(
    new RegExp(
      `${LEFT_BOUNDARY}(Authorization\\s*[:=]?\\s*Bearer|Authorization|Bearer)(\\s*[:=]?\\s*)(\\S+)`,
      "gi",
    ),
    (_match, keyword: string, sep: string, value: string) =>
      `${keyword}${sep}${maskValue(value)}`,
  );
  // The RIGHT boundary needs no separate guard here: the required `[:=]`
  // immediately after the keyword already rejects a false match like
  // "apikeyword" (no colon/equals follows), and the quotes around the
  // keyword/value are folded into the separator capture so reconstruction
  // restores them untouched; the value itself stops before a closing
  // quote/comma/brace so masking a JSON string cannot swallow surrounding
  // syntax.
  masked = masked.replace(
    new RegExp(
      `${LEFT_BOUNDARY}(api[_-]?key)(\\s*["']?\\s*[:=]\\s*["']?)([^"',\\s}]+)`,
      "gi",
    ),
    (_match, keyword: string, sep: string, value: string) =>
      `${keyword}${sep}${maskValue(value)}`,
  );
  return masked;
}
