// @vitest-environment jsdom
// The trim of a truncated status line head, judged by the real renderers
// (issue 514): at every grapheme cut of every document, in both profiles, what
// the trimmed head draws must be a start of what the full line draws, and no
// link may appear that the full line does not draw. The counts below are the
// measured ones; a change in them is the alarm for a `marked` upgrade or a
// regression, so they are exact on purpose.
import { describe, expect, it } from "vitest";
import { trimIncompleteMarkdown } from "../src/lib/truncatedMarkdown";
import {
  ADDRESSES,
  CUT_ADDRESS,
  DEFINITIONS,
  DUPLICATE_DEFINITIONS,
  LONG,
  PROFILES,
  RESIDUAL,
  STRUCTURES,
  SYNTHETIC,
  graphemeEnds,
  leak,
  randomDocuments,
  tally,
  type Tally,
} from "./truncatedMarkdownOracle";

const SEEDS = [527, 532, 539, 541] as const;

function trimmed(onFallback?: () => void): (head: string) => string {
  return (head) => trimIncompleteMarkdown(head, onFallback);
}

const untrimmed = (head: string): string => head;

/** The shown head must be faithful and the trim must be idempotent. `hidden` is
 *  the count of cuts that hide a delimiter the full line shows (benign). */
function expectFaithful(result: Tally, hidden: number): void {
  expect(result.notIdempotent).toBe(0);
  for (const profile of PROFILES) {
    expect(result[profile], profile).toEqual({
      ok: result.cuts - hidden,
      "delim-hidden": hidden,
    });
  }
}

describe("the committed corpus, at every grapheme cut", () => {
  const fixed = [...SYNTHETIC, ...CUT_ADDRESS, ...ADDRESSES, ...STRUCTURES, ...LONG];
  const random = SEEDS.flatMap((seed) => randomDocuments(seed, 8));

  it("shows only what the full line shows, and never calls the fallback", () => {
    let fallbacks = 0;
    const result = tally([...fixed, ...random], trimmed(() => (fallbacks += 1)));

    expect(fixed.length + random.length).toBe(126);
    expect(result.cuts).toBe(21880);
    expect(fallbacks).toBe(0);
    expectFaithful(result, 68);
  }, 60_000);

  // The negative control: the same oracle on the head as the server cut it.
  it("fails on the untrimmed head, for every family of documents", () => {
    const families: Record<string, readonly string[]> = {
      synthetic: SYNTHETIC,
      "cut addresses": CUT_ADDRESS,
      addresses: ADDRESSES,
      structures: STRUCTURES,
      long: LONG,
    };
    for (const [name, docs] of Object.entries(families)) {
      const result = tally(docs, untrimmed, 3);
      for (const profile of PROFILES) {
        const leaks = Object.entries(result[profile]).filter(([kind]) => kind !== "ok");
        expect(leaks.length, `${name} ${profile}`).toBeGreaterThan(0);
      }
    }
    // The address shapes are the harm that motivated the trim: a link to a cut
    // address, clickable in the detail view.
    expect(tally(CUT_ADDRESS, untrimmed, 3).full.href).toBeGreaterThan(0);
    expect(tally(ADDRESSES, untrimmed, 3).full.href).toBeGreaterThan(0);
  }, 60_000);
});

describe("the neighbours of a delimiter run", () => {
  // `前{p}{d}{x}強調{y}{d}後`: what stands before the run, right after it and
  // right before the closer decides whether the lexer opens an emphasis. The
  // trim reads the lexer's own patterns for that, so a `marked` upgrade that
  // changes a rule fails here before a user sees a raw delimiter.
  const NEIGHBOURS = ["あ", "a", "1", " ", "$", "「", "~", "_", "!", "😀"];
  const DELIMITERS = ["**", "*", "_", "__", "~", "~~", "~~~"];

  it("draws no raw delimiter at the cut just after the opener, and one inside", () => {
    const result = { cuts: 0, bad: [] as string[] };
    for (const d of DELIMITERS) {
      for (const p of NEIGHBOURS) {
        for (const x of NEIGHBOURS) {
          for (const y of NEIGHBOURS) {
            const full = `前${p}${d}${x}強調${y}${d}後に続く文章です`;
            const open = full.indexOf(d, 1) + d.length;
            const ends = new Set(graphemeEnds(full));
            for (const end of new Set([open, open + 1, full.indexOf("強調") + 1])) {
              if (!ends.has(end) || end >= full.length) continue;
              const shown = trimIncompleteMarkdown(full.slice(0, end));
              for (const profile of PROFILES) {
                result.cuts++;
                const why = leak(profile, full, shown);
                if (why !== null && why !== "delim-hidden" && result.bad.length < 5) {
                  result.bad.push(`${profile} ${why} ${JSON.stringify(full.slice(0, end))}`);
                }
              }
            }
          }
        }
      }
    }

    expect(result.bad).toEqual([]);
    expect(result.cuts).toBe(40700);
  }, 60_000);
});

describe("definitions and their references", () => {
  const docs = [...DEFINITIONS, ...Object.values(RESIDUAL)];

  it("never draws a link to a half address, whatever the cut", () => {
    let fallbacks = 0;
    const result = tally(docs, trimmed(() => (fallbacks += 1)));

    expect(fallbacks).toBe(0);
    expect(result.notIdempotent).toBe(0);
    for (const profile of PROFILES) expect(result[profile].href ?? 0, profile).toBe(0);
  });

  it("is red on the untrimmed head: the definition is where the half address comes from", () => {
    expect(tally(DEFINITIONS, untrimmed).full.href).toBeGreaterThan(0);
  });

  // A reference whose definition comes after the cut, a footnote-style
  // definition and a table without leading pipes: what a prefix cannot see.
  // Never an address; the brackets are drawn as text until the rest arrives.
  it("keeps what a prefix cannot see to text, and pins its size", () => {
    const result = tally(docs, trimmed());

    expect(result.cuts).toBe(573);
    expect(result.full).toEqual({ ok: 237, text: 252, "delim-extra": 84 });
    expect(result.inline).toEqual({ ok: 243, text: 246, "delim-extra": 84 });
  });
});

describe("a label defined twice", () => {
  // The lexer emits no token for the second definition, so the tokens do not
  // add up to the head. The text after it must survive and no address may be
  // drawn that the full line does not draw.
  it("draws no link the full line does not, loses nothing after it, and needs no fallback", () => {
    let fallbacks = 0;
    const result = tally(Object.values(DUPLICATE_DEFINITIONS), trimmed(() => (fallbacks += 1)));

    expect(fallbacks).toBe(0);
    expect(result.notIdempotent).toBe(0);
    for (const profile of PROFILES) expect(result[profile].href ?? 0, profile).toBe(0);
  });

  it("keeps the text that follows the second definition", () => {
    const head = DUPLICATE_DEFINITIONS.top!.slice(0, DUPLICATE_DEFINITIONS.top!.indexOf("後の文"));

    expect(trimIncompleteMarkdown(head)).toBe(head);
  });
});
