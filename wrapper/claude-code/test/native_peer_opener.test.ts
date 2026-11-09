import "../../../scripts/test/fixtures/test-isolation.mjs";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchesPeerOpener, peerReportToken, PEER_ROOT_PREFIX, PEER_ROOT_SUFFIX } from "../src/native_peer_opener.js";
import { peerFixture, recordedPeer } from "./fixtures/native_peer_opener.js";

const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));

describe("recorded native peer root and installed pin", () => {
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
  it("requires review of the native framing on SDK updates", () => {
    const sdk = JSON.parse(readFileSync(join(dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
    expect(sdk.version).toBe("0.3.321");
  });
  // CI runs this artifact check on Linux x64; version and golden checks also run on other platforms.
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("pins the installed native formatter artifact", async () => {
    const binary = join(dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(binary)) hash.update(bytes);
    expect(hash.digest("hex")).toBe("426c33815ca6645a772f722fbff10dbf2cbdb124a8aeab733c1365dbf8bbf61f");
  });
});
