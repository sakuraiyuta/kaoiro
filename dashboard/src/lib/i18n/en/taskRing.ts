import type { Messages } from "../ja";

export const taskRing: Messages["taskRing"] = {
  running: ({ count }) =>
    `Subagent/workflow running (${count} ${count === 1 ? "task" : "tasks"})`,
};
