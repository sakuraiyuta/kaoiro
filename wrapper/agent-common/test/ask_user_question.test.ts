import { describe, expect, it } from "vitest";
import { askUserQuestionDescriptor } from "../src/ask_user_question.js";
import type { QuestionDecision } from "../src/question.js";
import type { Question } from "../src/types.js";

const QUESTIONS: Question[] = [
  {
    question: "どの案で進めますか?",
    header: "方針",
    multiSelect: false,
    options: [
      { label: "A", description: "案 A" },
      { label: "B", description: "案 B" },
    ],
  },
];

describe("askUserQuestionDescriptor", () => {
  it("有効入力を decide に渡し answers を JSON で返す", async () => {
    let received: Question[] | null = null;
    const descriptor = askUserQuestionDescriptor(async (questions) => {
      received = questions;
      return { cancelled: false, answers: { "どの案で進めますか?": "A" } };
    });
    const result = await descriptor.handler({ questions: QUESTIONS });
    expect(received).toEqual(QUESTIONS);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      cancelled: false,
      answers: { "どの案で進めますか?": "A" },
    });
  });

  it("キャンセルは cancelled: true を返す", async () => {
    const descriptor = askUserQuestionDescriptor(async () => {
      return { cancelled: true } satisfies QuestionDecision;
    });
    const result = await descriptor.handler({ questions: QUESTIONS });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ cancelled: true });
  });

  it("不正入力は decide を呼ばず isError を返す", async () => {
    let called = false;
    const descriptor = askUserQuestionDescriptor(async () => {
      called = true;
      return { cancelled: true };
    });
    const result = await descriptor.handler({ questions: [] });
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("inputSchema は JSON Schema object 形で questions を要求する", () => {
    const descriptor = askUserQuestionDescriptor(async () => ({
      cancelled: true,
    }));
    expect(descriptor.name).toBe("ask_user_question");
    const schema = descriptor.inputSchema as {
      type?: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("questions");
    expect(schema.properties).toHaveProperty("questions");
  });
});
