/** Parse a PID from a child handle or decimal text before passing it to a signal API. */
export function requirePositiveSafePid(value: unknown): number {
  let pid: number;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) throw new RangeError("PID must be a positive safe integer");
    pid = Number(text);
  } else if (typeof value === "number") {
    pid = value;
  } else {
    throw new RangeError("PID must be a positive safe integer");
  }

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("PID must be a positive safe integer");
  }
  return pid;
}
