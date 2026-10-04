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
  TABS,
  graphemeEnds,
  leak,
  randomDocuments,
  tally,
  tokenDocuments,
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
    expectFaithful(result, 64);
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

describe("strings glued from the tokens of markdown", () => {
  // The harm the trim exists for is a link the full text does not draw. These
  // strings put brackets, backticks, stars and addresses next to each other in
  // every order; the other kinds of difference are the accepted residuals and
  // are not pinned here.
  const docs = [1, 2].flatMap((seed) => tokenDocuments(seed, 150));

  it("never draws a link the full text does not, and needs no fallback but for a tab", () => {
    let fallbacks = 0;
    let withoutTab = 0;
    const result = tally(docs, (head) => {
      let here = 0;
      const shown = trimIncompleteMarkdown(head, () => (here += 1));
      fallbacks += here;
      if (here > 0 && !head.includes("\t")) withoutTab += here;
      return shown;
    });

    expect(withoutTab).toBe(0);
    expect(fallbacks).toBe(234);
    expect(result.notIdempotent).toBe(0);
    expect(result.cuts).toBe(22452);
    for (const profile of PROFILES) expect(result[profile].href ?? 0, profile).toBe(0);
  }, 60_000);

  it("is red on the untrimmed head", () => {
    expect(tally(docs.slice(0, 40), untrimmed, 3).full.href).toBeGreaterThan(0);
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
  // definition, a table without leading pipes and the digits after a bullet that
  // the full text reads as an ordered marker: what a prefix cannot see. Never an
  // address; the brackets and digits are drawn as text until the rest arrives.
  it("keeps what a prefix cannot see to text, and pins its size", () => {
    const result = tally(docs, trimmed());

    expect(result.cuts).toBe(617);
    expect(result.full).toEqual({ ok: 279, text: 254, "delim-extra": 84 });
    expect(result.inline).toEqual({ ok: 287, text: 246, "delim-extra": 84 });
  });
});

describe("tabs", () => {
  /** Tabs spread to the next multiple of four columns before the trim, which is
   *  how CommonMark reads them and `marked` does not. */
  function spreadTabs(head: string): string {
    const spread = head
      .split("\n")
      .map((line) => {
        let out = "";
        let column = 0;
        for (const ch of line) {
          const width = ch === "\t" ? 4 - (column % 4) : 1;
          out += ch === "\t" ? " ".repeat(width) : ch;
          column += width;
        }
        return out;
      })
      .join("\n");
    return trimIncompleteMarkdown(spread);
  }

  const isSubsequence = (shown: string, head: string): boolean => {
    let at = 0;
    for (const ch of head) if (at < shown.length && shown[at] === ch) at++;
    return at === shown.length;
  };

  it("draws no link the full text does not, and gives back the head's own characters", () => {
    let fallbacks = 0;
    const result = tally(TABS, trimmed(() => (fallbacks += 1)));
    const foreign: string[] = [];
    for (const doc of TABS) {
      for (const end of graphemeEnds(doc)) {
        const head = doc.slice(0, end);
        if (end < doc.length && !isSubsequence(trimIncompleteMarkdown(head), head)) foreign.push(head);
      }
    }

    expect(foreign).toEqual([]);
    expect(TABS.length).toBe(99);
    expect(result.cuts).toBe(4391);
    expect(result.notIdempotent).toBe(0);
    expect(fallbacks).toBe(133);
    for (const profile of PROFILES) expect(result[profile], profile).toEqual({ ok: result.cuts });
  }, 60_000);

  // The negative controls: the head as cut, and the trim that reads tabs as
  // columns. The second draws a link to a complete address in a quote where the
  // lexer reads indented code.
  it("is red on the untrimmed head and on a trim that reads tabs as columns", () => {
    expect(tally(TABS, untrimmed, 3).full.href).toBeGreaterThan(0);

    const quoted = TABS.find((doc) => doc.startsWith("> \thttps://example.com/complete-url-here"))!;
    const head = quoted.slice(0, quoted.indexOf("\n") + 1);
    expect(leak("full", quoted, spreadTabs(head))).toBe("href");
    expect(leak("full", quoted, trimIncompleteMarkdown(head))).toBeNull();
    expect(tally(TABS, spreadTabs).full.href).toBeGreaterThan(0);
  }, 60_000);
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
