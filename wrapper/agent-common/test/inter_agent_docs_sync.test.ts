// Regression test for issue #134: inter_agent.ts's error-code tables
// (ERROR_CODE_GUIDANCE / ERROR_CODE_MESSAGE) and
// docs/specs/protocol-inter-agent.md's "Error codes (initial set)" table
// are both hand-written (the code side is a wire-notice template, the docs
// side is spec prose for readers — translating one into the other
// mechanically would not read naturally on either end, so nothing
// generates one from the other). What DOES need to stay in sync is the SET
// OF CODES: a code added to only one side is exactly the drift #131's
// review warned about (#134). This test is that sync check; it rides the
// existing `pnpm test` step in `.gitea/workflows/ci.yml`'s `wrapper` job,
// so no new CI job or script was added.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  INTER_AGENT_ERROR_CODES,
  INTER_AGENT_ERROR_MESSAGE_CODES,
} from "../src/inter_agent.js";

// import.meta.url anchored so this resolves the same way regardless of the
// process cwd vitest is invoked from. CI runs `cd wrapper && pnpm test`,
// which pnpm --filter then runs from this package's own directory
// (wrapper/agent-common) — a cwd-relative path happens to also resolve
// correctly there today, but anchoring to the test file's own location
// means it stays correct even if that invocation ever changes (issue #170
// already had a "passed locally, broke in CI" gap from an unverified
// environment difference).
const SPEC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/specs/protocol-inter-agent.md",
);

const SECTION_HEADING = "#### Error codes (initial set)";

/** Extracts the `code` column of the "Error codes (initial set)" markdown
 *  table. Matches only rows whose first cell is backtick-quoted
 *  (`` `rate_limit` `` etc.) — this naturally skips the header row
 *  (`| code | meaning | recommended action for origin |`) and the
 *  `|---|---|---|` separator, neither of which has backticks. */
function extractDocsErrorCodes(markdown: string): string[] {
  const startIdx = markdown.indexOf(SECTION_HEADING);
  if (startIdx === -1) {
    throw new Error(
      `${SPEC_PATH}: could not find the "${SECTION_HEADING}" heading — ` +
        "has the section been renamed or removed? (issue #134 sync check " +
        "in inter_agent_docs_sync.test.ts needs updating to match)",
    );
  }
  const afterHeading = markdown.slice(startIdx + SECTION_HEADING.length);
  const nextHeadingIdx = afterHeading.search(/\n#{2,4} /);
  const section =
    nextHeadingIdx === -1
      ? afterHeading
      : afterHeading.slice(0, nextHeadingIdx);
  const codes: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([a-z0-9_]+)`\s*\|/.exec(line);
    if (m?.[1] !== undefined) codes.push(m[1]);
  }
  return codes;
}

/** Floor, not an exact count (あお review, issue #134): a legitimate new
 *  error code raises the real count above this without needing a bump
 *  here. What this guards against is extraction silently returning an
 *  empty (or near-empty) list — the docs table's format changed, the
 *  heading was renamed, or the file could not be read — which would
 *  otherwise make the set-equality test below vacuously pass (empty
 *  docs-side set trivially "missing" nothing, if compared the wrong way;
 *  more importantly, a broken extractor's silence would look identical to
 *  "everything is in sync"). Set to the code count as of writing; lower it
 *  only if codes are legitimately removed. */
const MIN_EXPECTED_DOCS_CODES = 6;

describe("inter-agent error-code table sync (issue #134)", () => {
  it("docs の \"Error codes (initial set)\" 表から抽出ロジックが想定件数以上のコードを拾える(抽出経路そのものの健全性)", () => {
    const markdown = readFileSync(SPEC_PATH, "utf-8");
    const docsCodes = extractDocsErrorCodes(markdown);
    expect(
      docsCodes.length,
      `${SPEC_PATH} からコードを ${docsCodes.length} 件しか抽出できなかった` +
        `(期待: ${MIN_EXPECTED_DOCS_CODES} 件以上)。表形式か見出しが変わった` +
        "可能性がある — extractDocsErrorCodes() (inter_agent_docs_sync." +
        "test.ts) を見直すこと。",
    ).toBeGreaterThanOrEqual(MIN_EXPECTED_DOCS_CODES);
  });

  it("ERROR_CODE_GUIDANCE/ERROR_CODE_MESSAGE と docs の表がコード集合で一致する", () => {
    const markdown = readFileSync(SPEC_PATH, "utf-8");
    const docsCodes = new Set(extractDocsErrorCodes(markdown));
    const codeCodes = new Set(INTER_AGENT_ERROR_CODES);

    const missingFromDocs = [...codeCodes].filter((c) => !docsCodes.has(c));
    const missingFromCode = [...docsCodes].filter((c) => !codeCodes.has(c));

    expect(
      missingFromDocs,
      missingFromDocs.length === 0
        ? undefined
        : "wrapper/agent-common/src/inter_agent.ts の ERROR_CODE_GUIDANCE/" +
          "ERROR_CODE_MESSAGE にあるが docs/specs/protocol-inter-agent.md の" +
          `"Error codes (initial set)" 表に無いコード: ${missingFromDocs.join(", ")}。` +
          "両テーブルは手書きの別文言(コード側は wire 通知文言、docs 側は" +
          "スペック説明)だが、コードの集合は同期している必要がある。" +
          "docs の表に行を追加すること。",
    ).toEqual([]);

    expect(
      missingFromCode,
      missingFromCode.length === 0
        ? undefined
        : "docs/specs/protocol-inter-agent.md の \"Error codes (initial set)\" 表に" +
          "あるが wrapper/agent-common/src/inter_agent.ts の " +
          "ERROR_CODE_GUIDANCE/ERROR_CODE_MESSAGE に無いコード: " +
          `${missingFromCode.join(", ")}。ERROR_CODE_GUIDANCE と ` +
          "ERROR_CODE_MESSAGE の両方にエントリを追加すること。",
    ).toEqual([]);
  });

  it("ERROR_CODE_GUIDANCE と ERROR_CODE_MESSAGE のキー集合が一致する(2テーブル間の drift、今は無保証)", () => {
    const guidanceCodes = new Set(INTER_AGENT_ERROR_CODES);
    const messageCodes = new Set(INTER_AGENT_ERROR_MESSAGE_CODES);

    const missingFromMessage = [...guidanceCodes].filter(
      (c) => !messageCodes.has(c),
    );
    const missingFromGuidance = [...messageCodes].filter(
      (c) => !guidanceCodes.has(c),
    );

    expect(
      missingFromMessage,
      missingFromMessage.length === 0
        ? undefined
        : `ERROR_CODE_GUIDANCE にあるが ERROR_CODE_MESSAGE に無いコード: ` +
          `${missingFromMessage.join(", ")}。両方に同じキーを追加すること。`,
    ).toEqual([]);
    expect(
      missingFromGuidance,
      missingFromGuidance.length === 0
        ? undefined
        : `ERROR_CODE_MESSAGE にあるが ERROR_CODE_GUIDANCE に無いコード: ` +
          `${missingFromGuidance.join(", ")}。両方に同じキーを追加すること。`,
    ).toEqual([]);
  });
});
