import type { Messages } from "../ja";
import { plural } from "./plural";

export const time: Messages["time"] = {
  justNow: "just now",
  secondsAgo: ({ n }) => `${plural(n, "second", "seconds")} ago`,
  minutesAgo: ({ n }) => `${plural(n, "minute", "minutes")} ago`,
  hoursAgo: ({ n }) => `${plural(n, "hour", "hours")} ago`,
  daysAgo: ({ n }) => `${plural(n, "day", "days")} ago`,
};
