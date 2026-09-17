import { describe, expect, it } from "vitest";
import { appServerInput, type AppServerInput } from "../src/app_server_input.js";

describe("app-server input conversion", () => {
  it("keeps text and local image ordering without retaining caller objects", () => {
    expect(appServerInput("hello")).toEqual([{ type: "text", text: "hello", text_elements: [] }]);
    const input: AppServerInput = [{ type: "text", text: "one" }, { type: "local_image", path: "/tmp/image.png" }, { type: "text", text: "two" }];
    expect(appServerInput(input)).toEqual([
      { type: "text", text: "one", text_elements: [] }, { type: "localImage", path: "/tmp/image.png" },
      { type: "text", text: "two", text_elements: [] },
    ]);
    expect(input[1]).toEqual({ type: "local_image", path: "/tmp/image.png" });
  });
  it.each([null, {}, [null], [{ type: "text", text: 1 }], [{ type: "local_image", path: "" }], [{ type: "image", url: "https://example.invalid" }], [{ type: "audio", url: "x" }], [{ type: "toolOutput", output: "external" }]])("rejects unsupported input %j", input => {
    expect(() => appServerInput(input as AppServerInput)).toThrow(TypeError);
  });
});
