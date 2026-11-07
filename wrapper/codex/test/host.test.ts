import "../../../scripts/test/fixtures/test-isolation.mjs";
import { describe, expect, it } from "vitest";
import type { Envelope, WrapperConfig } from "@kaoiro/agent-common";
import { CodexHost } from "../src/host.js";

const CONFIG: WrapperConfig = {
  codex_backend: "app-server",
  agent_id: "host-1.codex-a",
  persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
  display_name: "クロエ",
  server_url: "ws://localhost:4000/wrapper",
  codex_auth_mode: "chatgpt",
  codex_chatgpt_plan: "plus",
};

describe("CodexHost statusExtSnapshot", () => {
  it("initial idle に config-static capabilities を stamp する (#107)", () => {
    const config = { ...CONFIG, model: "gpt-5.6-sol" };
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
    });
    try {
      const initial = host.statusExtSnapshot();
      expect(initial).toMatchObject({
        engine: "codex",
        session_capabilities: {
          supports_attachments: true,
          attachment_types: ["image"],
          supports_user_input_dialog: true,
          supports_model_switch: true,
          supports_effort_switch: true,
          supports_session_reset: true,
          session_reset_modes: ["new", "clear"],
          supports_context_usage: true,
        },
      });
      expect(
        (initial.models as { value: string }[]).map((m) => m.value),
      ).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6.1-terra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
    } finally {
      host.close();
    }
  });

  it("未申告 catalog は switch capability を fail-closed にする (#107)", () => {
    const host = new CodexHost(
      { ...CONFIG, codex_auth_mode: "unknown" },
      { onState: () => {}, appendSystemPrompt: "p" },
    );
    try {
      expect(host.statusExtSnapshot()).toMatchObject({
        session_capabilities: {
          supports_model_switch: false,
          supports_effort_switch: false,
        },
      });
    } finally {
      host.close();
    }
  });

  // issue #292: codex_extra_models (relayed from runner.config.json's
  // codex.extra_models) merges into the resolved catalog before ext.models
  // is stamped.
  it("appends a new codex_extra_models model to ext.models (issue #292)", () => {
    const config: WrapperConfig = {
      ...CONFIG,
      codex_extra_models: [
        {
          value: "gpt-9-nova",
          display_name: "GPT-9 Nova",
          effort_levels: ["low", "high"],
          default_effort: "low",
        },
      ],
    };
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
    });
    try {
      const initial = host.statusExtSnapshot();
      expect(
        (initial.models as { value: string }[]).map((m) => m.value),
      ).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6.1-terra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-9-nova",
      ]);
    } finally {
      host.close();
    }
  });

  it("codex_extra_models overrides an existing value (issue #292)", () => {
    const config: WrapperConfig = {
      ...CONFIG,
      codex_extra_models: [
        { value: "gpt-5.6-luna", display_name: "overridden" },
      ],
    };
    const host = new CodexHost(config, {
      onState: () => {},
      appendSystemPrompt: "p",
    });
    try {
      const initial = host.statusExtSnapshot();
      const luna = (
        initial.models as { value: string; display_name: string }[]
      ).find((m) => m.value === "gpt-5.6-luna");
      expect(luna?.display_name).toBe("overridden");
    } finally {
      host.close();
    }
  });

  it("does not stamp an extra model above the bundled Codex version", () => {
    const host = new CodexHost(
      {
        ...CONFIG,
        codex_extra_models: [
          {
            value: "requires-newer-codex",
            display_name: "Requires newer Codex",
            minimal_client_version: "999.0.0",
          },
        ],
      },
      {
        onState: () => {},
        appendSystemPrompt: "p",
        codexClientVersion: "0.144.1",
      },
    );
    try {
      const initial = host.statusExtSnapshot();
      expect(
        (initial.models as { value: string }[]).map((model) => model.value),
      ).not.toContain("requires-newer-codex");
    } finally {
      host.close();
    }
  });
});

describe("CodexHost — display_name rename (issue #197 段階3, revised issue #219 D19/D23)", () => {
  // A FRESH object per call, NOT a shared const — renameDisplayName
  // reassigns #config.display_name, and CodexHost holds the SAME object
  // reference it was constructed with (no clone). A single const reused
  // across both `it` blocks below would let the first test's rename
  // mutate the object the second test starts from (review round1
  // finding, same as the claude-code AgentHost twin of this suite).
  function freshRenameConfig(): WrapperConfig {
    return {
      agent_id: "test.rename-agent",
      persona: { id: "kuroe", name: "クロエ", sprite_set: "kuroe" },
      display_name: "クロエ",
      server_url: "ws://localhost:4000/wrapper",
    };
  }

  it("revision が新しければ display_name を更新し state_change を即時再送する。persona は不変", () => {
    const envs: Envelope[] = [];
    const host = new CodexHost(freshRenameConfig(), {
      onState: (e) => envs.push(e),
      appendSystemPrompt: "p",
      now: () => "T",
    });

    host.renameDisplayName("クロエ(改名)", 1);

    expect(envs.at(-1)?.display_name).toBe("クロエ(改名)");
    expect(envs.at(-1)?.persona).toEqual({
      id: "kuroe",
      name: "クロエ",
      sprite_set: "kuroe",
    });
  });

  it("revision が現在値以下なら無視し state_change を再送しない (D15)", () => {
    const envs: Envelope[] = [];
    const host = new CodexHost(freshRenameConfig(), {
      onState: (e) => envs.push(e),
      appendSystemPrompt: "p",
      now: () => "T",
    });

    host.renameDisplayName("先勝ち", 2);
    expect(envs).toHaveLength(1);

    host.renameDisplayName("同revision再送", 2);
    host.renameDisplayName("古いrevision", 1);

    expect(envs).toHaveLength(1);
    expect(envs.at(-1)?.display_name).toBe("先勝ち");
  });
});

describe("CodexHost", () => {

  it("fails startup for a curated model newer than the bundled Codex CLI", () => {
    expect(
      () =>
        new CodexHost(
          { ...CONFIG, model: "gpt-6-astra" },
          {
            onState: () => {},
            appendSystemPrompt: "p",
            codexClientVersion: "0.144.1",
          },
        ),
    ).toThrow(
      "codex: model gpt-6-astra requires Codex >= 0.153.0, bundled version is 0.144.1",
    );
  });

  it("leaves an explicitly declared operator model outside the curated startup gate", () => {
    expect(
      () =>
        new CodexHost(
          {
            ...CONFIG,
            model: "operator-model",
            codex_extra_models: [
              {
                value: "operator-model",
                display_name: "Operator model",
                minimal_client_version: "0.153.0",
              },
            ],
          },
          {
            onState: () => {},
            appendSystemPrompt: "p",
            codexClientVersion: "0.144.1",
          },
        ),
    ).not.toThrow();
  });

  it("whoami は effective snapshot の model/effort/source/permission を返す", () => {
    const host = new CodexHost(
      {
        ...CONFIG,
        model: "gpt-5.6-sol",
        effort: "xhigh",
        sandbox: "workspace-write",
        network_access: true,
      },
      {
        onState: () => {},
        appendSystemPrompt: "p",
        modelSource: "config",
        effortSource: "config",
      },
    );

    expect(host.statusSnapshot()).toMatchObject({
      engine: "codex",
      model: "gpt-5.6-sol",
      model_source: "config",
      effort: "xhigh",
      effort_source: "config",
      permission: {
        sandbox: "workspace-write",
        approval: "never",
        enforcement: "os",
      },
      network_access: true,
    });
  });

  it("非画像 upload は attach_rejected で loud に弾く", () => {
    const rejected: Envelope[] = [];
    const host = new CodexHost(CONFIG, {
      onState: () => {}, appendSystemPrompt: "p",
      onAttachRejected: (e) => rejected.push(e), now: () => "T",
    });
    host.attachOpen({ upload_id: "not-image", filename: "note.txt", mime: "text/plain", size: 1, chunks: 1 });
    expect(rejected[0]?.payload).toMatchObject({ upload_id: "not-image", reason: "mime_denied" });
  });

  it("setPendingQuestion が waiting_question / 復帰を駆動する", () => {
    const states: Envelope[] = [];
    const host = new CodexHost(CONFIG, {
      onState: (e) => states.push(e),
      appendSystemPrompt: "p",
      now: () => "T",
    });
    host.setPendingQuestion({
      request_id: "q1",
      questions: [],
      ts: "T",
    });
    expect(states.at(-1)?.state).toBe("waiting_question");
    expect(states.at(-1)?.ext.pending_question).toMatchObject({
      request_id: "q1",
    });
    host.setPendingQuestion(null);
    expect(states.at(-1)?.state).toBe("tool_running");
    expect(states.at(-1)?.ext.pending_question).toBeUndefined();
  });

  it("setPermissionMode は six-value API unsupported として reject する", async () => {
    const host = new CodexHost(CONFIG, {
      onState: () => {},
      appendSystemPrompt: "p",
      now: () => "T",
    });
    await expect(host.setPermissionMode("default")).rejects.toThrow(
      /permission-mode switching is unsupported/,
    );
  });

  describe("rate_limits (rollout tail)", () => {

    // issue #254: 自分の rate limit を自分で観測できるようにする。list_agents
    // は呼び出し元を除外するので、ここが唯一の自己観測点になる。
    it("rollout snapshot が無い間は whoami から key ごと省略する", () => {
      const host = new CodexHost(CONFIG, {
        onState: () => {},
        appendSystemPrompt: "p",
      });
      expect(host.statusSnapshot()).not.toHaveProperty("rate_limits");
    });
  });
});
