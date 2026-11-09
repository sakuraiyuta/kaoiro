import type { Messages } from "../ja";

export const taskRing = {
  running: ({ count }) =>
    `Subagent/workflow running (${count} ${count === 1 ? "task" : "tasks"})`,
} satisfies Messages["taskRing"];
