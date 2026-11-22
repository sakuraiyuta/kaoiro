export type AntigravitySubcommand = "hook";

/** Wraps a shell argument in single quotes unconditionally so spaces or
 *  metacharacters in paths and execArgv cannot split or expand in `sh -c`. */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface AntigravitySubcommandOptions {
  nodePath: string;
  nodeArgs?: readonly string[] | undefined;
  entryPath: string;
  subcommand: AntigravitySubcommand;
}

/** Builds the command prefix that hooks.json registers and the hook list
 *  check compares. */
export function antigravitySubcommandPrefix(options: AntigravitySubcommandOptions): string {
  return [
    options.nodePath,
    ...(options.nodeArgs ?? []).map(shellSingleQuote),
    shellSingleQuote(options.entryPath),
    "wrapper",
    "antigravity",
    options.subcommand,
  ].join(" ");
}
