import { isAbsolute } from "node:path";

export type AppServerInput = string | ReadonlyArray<
  { type: "text"; text: string } | { type: "local_image"; path: string }
>;

export type AppServerWireInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export function appServerInput(input: AppServerInput): AppServerWireInput[] {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  if (!Array.isArray(input)) throw new TypeError("Invalid app-server input");
  return input.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new TypeError("Invalid app-server input item");
    const value = item as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      return { type: "text", text: value.text, text_elements: [] };
    }
    if (value.type === "local_image" && typeof value.path === "string" && isAbsolute(value.path)) {
      return { type: "localImage", path: value.path };
    }
    throw new TypeError("Unsupported app-server input item");
  });
}
