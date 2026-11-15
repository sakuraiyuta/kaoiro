import "../../../scripts/test/fixtures/test-isolation.mjs";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { connectAcp } from "../src/acp/connection.js";
import { promptIdOf, turnCompletion } from "../src/grok/events.js";
import {
  GROK_QUEUE_CHANGED,
  GROK_SESSION_NOTIFICATION,
  grokExtension,
  grokPromptMeta,
  grokSessionMeta,
  grokWireFields,
  type GrokWireMetadata,
} from "../src/grok/wire.js";

describe("grokWireFields", () => {
  it("reads the vendor kind only on _x.ai methods", () => {
    expect(
      grokWireFields({
        method: "_x.ai/session_notification",
        params: { update: { sessionUpdate: "turn_completed" } },
      }),
    ).toEqual({ vendor_kind: "turn_completed" });
    expect(
      grokWireFields({
        method: "_x.ai/other",
        params: { notification: { type: "legacy_kind" } },
      }),
    ).toEqual({ vendor_kind: "legacy_kind" });
    expect(
      grokWireFields({
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk" } },
      }),
    ).toEqual({});
  });
  it("reads prompt and request ids from the result _meta", () => {
    expect(
      grokWireFields({
        id: 1,
        result: { _meta: { promptId: "p-1", requestId: "r-1" } },
      }),
    ).toEqual({ prompt_id: "p-1", request_id: "r-1" });
  });
  it("falls back to the update prompt_id", () => {
    expect(
      grokWireFields({
        method: "_x.ai/session_notification",
        params: { update: { sessionUpdate: "turn_completed", prompt_id: "p-2" } },
      }),
    ).toEqual({ vendor_kind: "turn_completed", prompt_id: "p-2" });
  });
  it("reads the hook event from update, notification or hook_event", () => {
    expect(
      grokWireFields({ params: { update: { event_name: "pre_tool_use" } } }),
    ).toEqual({ hook_event: "pre_tool_use" });
    expect(
      grokWireFields({ params: { notification: { event: "stop" } } }),
    ).toEqual({ hook_event: "stop" });
    expect(
      grokWireFields({ params: { notification: { hook_event: "session_end" } } }),
    ).toEqual({ hook_event: "session_end" });
  });
  it("drops names that are not safe identifiers", () => {
    expect(
      grokWireFields({
        method: "_x.ai/session_notification",
        params: { update: { sessionUpdate: "has space", prompt_id: "a b" } },
        result: { _meta: { promptId: 7, requestId: "x".repeat(121) } },
      }),
    ).toEqual({});
  });
  it("keeps the key order the log lines had before the extraction", () => {
    expect(
      Object.keys(
        grokWireFields({
          method: "_x.ai/session_notification",
          params: {
            update: {
              sessionUpdate: "turn_completed",
              event_name: "stop",
              prompt_id: "p",
            },
          },
          result: { _meta: { requestId: "r" } },
        }),
      ),
    ).toEqual(["vendor_kind", "prompt_id", "request_id", "hook_event"]);
  });
  it("throws on a non-string method, as the tee expression did", () => {
    expect(() => grokWireFields({ method: 7 })).toThrow(TypeError);
  });
});

describe("grok session meta and extension", () => {
  it("wraps the rules as the session/new _meta value", () => {
    expect(grokSessionMeta("persona")).toEqual({ rules: "persona" });
  });
  it("names the prompt in the session/prompt _meta value", () => {
    expect(grokPromptMeta("kaoiro-1")).toEqual({ promptId: "kaoiro-1" });
  });
  it("registers the _x.ai session and queue notifications", () => {
    const handle = vi.fn();
    const queue = vi.fn();
    const extension = grokExtension(handle, queue);
    expect(extension.notifications?.map((n) => n.method)).toEqual([
      GROK_SESSION_NOTIFICATION,
      GROK_QUEUE_CHANGED,
    ]);
    const [entry, queueEntry] = extension.notifications!;
    const payload = { sessionId: "s", update: {} };
    entry!.handle(entry!.parse(payload));
    expect(handle).toHaveBeenCalledWith(payload);
    const changed = { sessionId: "s", entries: [], runningPromptId: "p" };
    queueEntry!.handle(queueEntry!.parse(changed));
    expect(queue).toHaveBeenCalledWith(changed);
    expect(extension.wireFields).toBe(grokWireFields);
  });
  it("delivers the notification and grok metadata through connectAcp", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    stdin.resume();
    const child = { stdout, stdin } as unknown as ChildProcessWithoutNullStreams;
    const metadata: GrokWireMetadata[] = [];
    const handle = vi.fn();
    const connection = connectAcp<GrokWireMetadata>(
      child,
      {
        update: () => {},
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
        metadata: (m) => metadata.push(m),
      },
      grokExtension(handle),
    );
    const params = {
      sessionId: "s1",
      update: { sessionUpdate: "turn_completed", prompt_id: "p-1" },
    };
    stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: GROK_SESSION_NOTIFICATION,
        params,
      }) + "\n",
    );
    await vi.waitFor(() => expect(handle).toHaveBeenCalledWith(params));
    expect(metadata).toEqual([
      {
        direction: "in",
        method: GROK_SESSION_NOTIFICATION,
        variant: "turn_completed",
        vendor_kind: "turn_completed",
        prompt_id: "p-1",
      },
    ]);
    connection.close();
    stdout.end();
    stdin.end();
  });
});

describe("turnCompletion", () => {
  const completed = {
    sessionId: "s1",
    update: { sessionUpdate: "turn_completed", prompt_id: "p-1" },
  };
  it("returns the completed turn of the current session", () => {
    expect(turnCompletion(completed, "s1")).toEqual({
      sessionId: "s1",
      promptId: "p-1",
    });
  });
  it("accepts the snake_case session id", () => {
    expect(
      turnCompletion({ session_id: "s1", update: completed.update }, "s1"),
    ).toEqual({ sessionId: "s1", promptId: "p-1" });
  });
  it.each([
    ["another session", completed, "s2"],
    ["no current session", completed, undefined],
    [
      "another update kind",
      { sessionId: "s1", update: { sessionUpdate: "response_completed" } },
      "s1",
    ],
    [
      "a non-string prompt id",
      { sessionId: "s1", update: { sessionUpdate: "turn_completed", prompt_id: 7 } },
      "s1",
    ],
    ["no update", { sessionId: "s1" }, "s1"],
  ])("ignores %s", (_label, notification, current) => {
    expect(turnCompletion(notification, current)).toBeUndefined();
  });
});

describe("promptIdOf", () => {
  it("reads promptId from a result _meta", () => {
    expect(promptIdOf({ promptId: "p-1" })).toBe("p-1");
  });
  it.each([[undefined], [null], [{}], ["text"]])(
    "is undefined for %j",
    (meta) => {
      expect(promptIdOf(meta)).toBeUndefined();
    },
  );
});
