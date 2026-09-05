// Credential-shaped substring redaction for operator-facing error text
// (protocol.md `result.error_detail`: "credential-shaped substrings are
// redacted ... before clipping"). `makeResult` (state.ts) applies
// `boundErrorDetail` to every result envelope's error_detail
// unconditionally (issue #300 round 3, finding M-B), so the same wire
// field carries the same guarantee regardless of which engine adapter
// produced the text (round 2: the guarantee previously existed only for
// Codex, and only incompletely). A pattern match, not a full secret
// scanner: it may occasionally mask non-secret text following these
// keywords -- over-masking is the safe failure mode for a redaction pass,
// under-masking is not. Deliberately does NOT touch filesystem paths
// (including home directories) -- those are not credentials.

import { clipText } from "./logpayload.js";

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

// Shared value class for the two keyword=value patterns (Authorization/
// Bearer and api_key -- sk- is a different grammar, a bare prefix with no
// separator, and keeps its own strict shape check below). `\S+` (the
// original value class) has no JSON-delimiter awareness, so a JSON-shaped
// body like `"Authorization":"Bearer abc123"` let its value capture eat
// straight through the closing quote into `"Bearer` (issue #300 review
// round 3, finding M-A -- the third sighting of this "value class crosses
// a delimiter it shouldn't" defect class, after api_key's own JSON-quoted
// form and the underscore left-boundary bug). Stopping at a quote, comma,
// whitespace, or closing brace keeps the match inside one JSON string/
// bare token, whichever this text turns out to contain.
const VALUE_CLASS = '[^"\',\\s}]+';

/** Builds the separator between a keyword and its value, tolerating an
 *  optional quote on either side of the `:`/`=` operator (JSON's own
 *  quoting around a key or value) so the same separator bridges both a
 *  bare `keyword=value` assignment and a JSON `"keyword":"value"` field,
 *  compact or spaced. `requireOperator` is false only for the
 *  Authorization/Bearer keywords, matching their original (pre-#300)
 *  design of tolerating a bare space with no `:`/`=` at all -- api_key's
 *  operator stays mandatory, since that requirement is what rejects a
 *  false match like "apikeyword" (no colon/equals following it). */
function separator(requireOperator: boolean): string {
  const operator = requireOperator ? "[:=]" : "[:=]?";
  return `\\s*["']?\\s*${operator}\\s*["']?`;
}

/** Redacts the three credential shapes this text can plausibly carry: an
 *  OpenAI-style API key, an Authorization/Bearer header value, and an
 *  api_key assignment -- each in bare (`key=value`), JSON-spaced
 *  (`"key": "value"`), or JSON-compact (`"key":"value"`) form. */
export function redactCredentials(text: string): string {
  let masked = text.replace(
    new RegExp(`${LEFT_BOUNDARY}(sk-)([A-Za-z0-9_-]{16,})\\b`, "g"),
    (_match, prefix: string, value: string) => `${prefix}${maskValue(value)}`,
  );
  // A first attempt at finding M-C (a non-Bearer Authorization scheme --
  // Basic, Digest, Token, an unregistered vendor scheme -- riding through
  // unmasked) tried to CLASSIFY the word after "Authorization" as either a
  // scheme or the credential itself. That is not decidable from shape
  // alone: a scheme name and a short credential are both plain
  // alphanumeric words, so any classifier -- a length cap included --
  // just moves the boundary where a real, scheme-less credential gets
  // misread as a "scheme" and only the unrelated word after IT gets
  // masked (round 4 review, live-measured: `Authorization: <token> failed`
  // regressed to leaking `<token>` and masking "failed" instead). Rather
  // than classify, this captures up to TWO consecutive whitespace-joined
  // tokens as one combined value and masks them together -- whichever one
  // is the real credential, it ends up inside the masked run either way.
  // Cost, accepted per this file's own header comment ("over-masking is
  // the safe failure mode"): a real scheme keyword (Bearer included) is no
  // longer readable in the output, and up to one adjacent prose word can
  // be swept in too.
  const authSep = separator(false);
  masked = masked.replace(
    new RegExp(
      `${LEFT_BOUNDARY}(Authorization|Bearer)(${authSep})((?:${VALUE_CLASS}\\s+)?${VALUE_CLASS})`,
      "gi",
    ),
    (_match, keyword: string, sep: string, value: string) =>
      `${keyword}${sep}${maskValue(value)}`,
  );
  masked = masked.replace(
    new RegExp(
      `${LEFT_BOUNDARY}(api[_-]?key)(${separator(true)})(${VALUE_CLASS})`,
      "gi",
    ),
    (_match, keyword: string, sep: string, value: string) =>
      `${keyword}${sep}${maskValue(value)}`,
  );
  return masked;
}

/** The `result.error_detail` mask-then-clip transform (issue #300 round 3,
 *  finding M-B). `clipText` keeps the FIRST MAX_LOG_BYTES bytes (a head
 *  clip), so a keyword+value pair near the start of the text -- the
 *  common case here -- keeps its own anchor in either order; masking
 *  first is still the chosen order for defensive consistency with
 *  `codexExecFailureRelay`'s own clip (a TAIL clip, where the ordering IS
 *  load-bearing: clipping first there can discard a secret's keyword
 *  anchor while keeping the value's tail, masking nothing). Called from
 *  exactly one place, `makeResult` (state.ts) -- the actual choke point,
 *  since every `EngineAdapter`'s result envelope funnels through it
 *  unconditionally, unlike a per-engine `#emitResult` an engine could
 *  omit or bypass. */
export function boundErrorDetail(text: string): string {
  return clipText(redactCredentials(text)).text;
}
