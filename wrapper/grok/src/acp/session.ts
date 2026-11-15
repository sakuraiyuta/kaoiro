import * as acp from "@agentclientprotocol/sdk";

export class AcpSession {
  sessionId: string | undefined;
  initializeResponse: acp.InitializeResponse | undefined;
  newSessionResponse: acp.NewSessionResponse | undefined;
  /** The latest `configOptions` this session was given: by new, by load, or
   *  by the last accepted `set_config_option`. */
  configOptions: acp.SessionConfigOption[] | undefined;
  constructor(readonly connection: acp.ClientConnection) {}

  async initialize() {
    this.initializeResponse = await this.connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "kaoiro", version: "0.0.0" },
        clientCapabilities: {},
      },
    );
    return this.initializeResponse;
  }

  async newSession(
    cwd: string,
    mcpServers: acp.McpServer[],
    newSessionMeta?: Record<string, unknown>,
  ) {
    this.newSessionResponse = await this.connection.agent.request(
      acp.methods.agent.session.new,
      { cwd, mcpServers, ...(newSessionMeta ? { _meta: newSessionMeta } : {}) },
    );
    this.sessionId = this.newSessionResponse.sessionId;
    this.configOptions = this.newSessionResponse.configOptions ?? undefined;
    return this.newSessionResponse;
  }

  async load(sessionId: string, cwd: string, mcpServers: acp.McpServer[]) {
    const response = await this.connection.agent.request(acp.methods.agent.session.load, {
      sessionId, cwd, mcpServers,
    });
    this.sessionId = sessionId;
    this.configOptions = response.configOptions ?? undefined;
    return response;
  }

  /** Attaches to a stored session without replaying its history. */
  async resume(sessionId: string, cwd: string, mcpServers: acp.McpServer[]) {
    const response = await this.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId, cwd, mcpServers,
    });
    this.sessionId = sessionId;
    this.configOptions = response.configOptions ?? undefined;
    return response;
  }

  async setConfigOption(configId: string, value: string) {
    if (!this.sessionId) throw new Error("ACP session is not initialized");
    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      { sessionId: this.sessionId, configId, value },
    );
    this.configOptions = response.configOptions;
    return response;
  }

  async open(
    cwd: string,
    mcpServers: acp.McpServer[],
    newSessionMeta?: Record<string, unknown>,
  ) {
    await this.initialize();
    return this.newSession(cwd, mcpServers, newSessionMeta);
  }

  prompt(text: string, meta?: Record<string, unknown>) {
    if (!this.sessionId) throw new Error("ACP session is not initialized");
    return this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
      ...(meta ? { _meta: meta } : {}),
    });
  }

  cancel() {
    if (!this.sessionId) return Promise.resolve();
    return this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.sessionId,
    });
  }
}
