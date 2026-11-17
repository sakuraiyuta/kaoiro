import "../../../scripts/test/fixtures/test-isolation.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchesPeerOpener, peerReportToken, PEER_ROOT_PREFIX, PEER_ROOT_SUFFIX } from "../src/native_peer_opener.js";
import { peerFixture, recordedPeer } from "./fixtures/native_peer_opener.js";

const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));

describe("recorded native peer root and installed native framing", () => {
  it("matches the independently recorded row bytes", () => {
    expect(PEER_ROOT_PREFIX + recordedPeer.hook + PEER_ROOT_SUFFIX).toBe(recordedPeer.row.message.content);
    expect(matchesPeerOpener(recordedPeer.row.message.content, recordedPeer.hook, recordedPeer.row.origin.from)).toBe(true);
  });
  it("reads one report token only from the body of exactly one frame", () => {
    const token = "B".repeat(43), other = "C".repeat(43);
    const frame = (text: string) => peerFixture(text).hook;
    expect(peerReportToken(frame(`report [kaoiro-continuation:${token}]`))).toBe(token);
    // Quoting another launch is not a report token, whether or not the report also ends with its own.
    expect(peerReportToken(frame(`see [kaoiro-continuation:${other}] then done`))).toBeUndefined();
    expect(peerReportToken(frame(`see [kaoiro-continuation:${other}] and [kaoiro-continuation:${token}]`))).toBeUndefined();
    expect(peerReportToken(frame(`report [kaoiro-continuation:${token}] trailing`))).toBeUndefined();
    // Only a prompt that is exactly one frame can carry a report; bare text and double frames cannot.
    expect(peerReportToken(`done [kaoiro-continuation:${token}]`)).toBeUndefined();
    const one = frame(`report [kaoiro-continuation:${token}]`);
    expect(peerReportToken(`${one}\n${one}`)).toBeUndefined();
    expect(peerReportToken(`note\n${one}`)).toBeUndefined();
    expect(peerReportToken('<agent-message from="x">\n</agent-message>')).toBeUndefined();
  });
  // CI runs this on Linux x64; the golden checks also run on other platforms. It shows that the
  // framing text is in the installed binary, not that the binary uses it or is otherwise unchanged.
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("finds the framing text in the installed native binary", () => {
    const binary = readFileSync(join(dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude"));
    // The binary holds JS source, where a newline, a quote or a non-ASCII character may be written as an escape.
    const pieces = (PEER_ROOT_PREFIX + PEER_ROOT_SUFFIX).split(/[^\x20-\x7e]|["']/).filter(piece => piece.length > 20);
    for (const piece of pieces) {
      const middle = piece.length >> 1;
      const changed = piece.slice(0, middle) + (piece[middle] === "#" ? "%" : "#") + piece.slice(middle + 1);
      expect(binary.includes(piece), piece).toBe(true);
      expect(binary.includes(changed), changed).toBe(false);
    }
  });
});
