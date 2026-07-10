// ask_user_question — the codex-side stand-in for Claude's native
// AskUserQuestion tool (ADR-0032 F6). Served ONLY through the codex MCP
// bridge; the Claude adapter keeps the SDK-native tool and never registers
// this descriptor. The handler normalizes into the same QuestionBroker
// path as the native tool, so the operator sees one question_request
// envelope shape (ADR-0027) regardless of engine, and the MCP call blocks
// the turn until the operator answers — which is what makes
// waiting_question hold on codex.

import { z } from "zod";
import type { QuestionDecision } from "./question.js";
import type { ToolDescriptor } from "./tooling.js";
import type { Question } from "./types.js";

const QUESTION_SHAPE = z.object({
  question: z
    .string()
    .min(1)
    .describe("The complete question to ask the operator."),
  header: z
    .string()
    .min(1)
    .max(12)
    .describe("Very short label displayed as a chip/tag (max 12 chars)."),
  multiSelect: z
    .boolean()
    .describe("true = the operator may select multiple options."),
  options: z
    .array(
      z.object({
        label: z.string().min(1).describe("Display text of this option."),
        description: z
          .string()
          .describe("What choosing this option means."),
      }),
    )
    .min(2)
    .max(4)
    .describe("2-4 distinct choices. Do not add an 'Other' option."),
});

const INPUT_SCHEMA = z.object({
  questions: z
    .array(QUESTION_SHAPE)
    .min(1)
    .max(4)
    .describe("1-4 questions to ask the operator in one dialog."),
});

const DESCRIPTION =
  "Ask the human operator up to 4 structured multiple-choice questions and wait for their answers. Use when you are blocked on a decision only the operator can make (requirement ambiguity, destructive-action approval, a choice that materially changes the outcome). Each question needs 2-4 mutually exclusive options; the operator can always answer with free text instead. The call blocks until the operator responds; the result contains the selected answers keyed by question text, or cancelled=true when the operator dismissed the dialog.";

/** Builds the ask_user_question descriptor around the wrapper's question
 *  path (normally QuestionBroker#decide). */
export function askUserQuestionDescriptor(
  decide: (questions: Question[]) => Promise<QuestionDecision>,
): ToolDescriptor {
  return {
    name: "ask_user_question",
    description: DESCRIPTION,
    inputSchema: z.toJSONSchema(INPUT_SCHEMA, { io: "input" }),
    handler: async (input) => {
      const parsed = INPUT_SCHEMA.safeParse(input);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text",
              text: `ask_user_question failed: invalid input: ${parsed.error.message}`,
            },
          ],
          isError: true,
        };
      }
      const decision = await decide(parsed.data.questions);
      if (decision.cancelled) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ cancelled: true }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              cancelled: false,
              answers: decision.answers ?? {},
            }),
          },
        ],
      };
    },
  };
}
