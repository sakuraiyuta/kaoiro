// Common tool description layer — the single source of truth for tools the
// wrapper offers to its engine (ADR-0032 F5): one (name, description, JSON
// Schema, handler) record per tool. Engine adapters translate, never
// re-implement: the Claude adapter maps a descriptor to a Zod schema +
// createSdkMcpServer registration; the codex adapter serves the same
// descriptors through the bundled stdio MCP bridge. Phase-13 ships the
// skeleton only; the inter-agent tools and ask_user_question move onto it
// in phase-14 (14-6 / 14-7).

/** One content part of a tool result, MCP-shaped (text only for now —
 *  every current kaoiro tool returns text). */
export interface ToolResultContent {
  type: "text";
  text: string;
}

/** The engine-agnostic result of a tool handler. The index signature
 *  mirrors the upstream MCP CallToolResult so the Claude SDK's `tool()`
 *  helper accepts it structurally without a cast. */
export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  [extra: string]: unknown;
}

/** Per-call context an engine adapter MAY hand to a handler. Absent on
 *  adapters that do not track it (the Claude SDK server, antigravity). */
export interface ToolHandlerContext {
  /** Aborts once the call can no longer deliver its result to the model
   *  or act on its behalf — the owning engine turn ended or was
   *  interrupted, the bridge connection closed, or the host shut down. A
   *  handler whose effect outlives the call (a reservation) must check it
   *  after every await and do nothing once it has fired. */
  signal?: AbortSignal;
}

/** One tool: JSON Schema definition + handler pair (ADR-0032 F5). */
export interface ToolDescriptor {
  /** Bare tool name under the "kaoiro" MCP server (e.g. `send_to_agent`,
   *  `ask_user_question`). Claude surfaces it as `mcp__kaoiro__<name>`. */
  name: string;
  description: string;
  /** JSON Schema for the tool input (draft 2020-12 subset both engines
   *  accept). */
  inputSchema: Record<string, unknown>;
  handler: (
    input: Record<string, unknown>,
    context?: ToolHandlerContext,
  ) => Promise<ToolResult>;
}
