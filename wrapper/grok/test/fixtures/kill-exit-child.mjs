// Child for background_kill.test.ts: leaves the interrupted turn's kills
// unanswered, then closes (SCENARIO=hang-close) or lets Grok exit
// (SCENARIO=grok-exit). Prints "closed" once the host has closed, then must
// end on its own; nothing here calls process.exit.
import { GrokHost } from "../../dist/host.js";

const scenario = process.env.SCENARIO;
const host = new GrokHost({
  config: { agent_id: "kill-exit-594", display_name: "Kill exit", server_url: "ws://127.0.0.1:1/agent",
    persona: { id: "default", name: "Default", sprite_set: "default" },
    sandbox: "workspace-write", network_access: true },
  cwd: process.env.KAOIRO_TEST_ROOT, personaPrompt: "fixture",
  executable: new URL("./grok.mjs", import.meta.url).pathname,
  env: { ...process.env, KAOIRO_TEST_GROK_KILL: scenario === "grok-exit" ? "exit" : "hang" },
  send: () => {}, decidePermission: async () => ({ allow: true }),
});
void host.run().catch(() => {});
while (host.state !== "waiting_input") await new Promise((resolve) => setTimeout(resolve, 20));
const turn = host.send("bg-two");
void turn.catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 200));
await host.interrupt();
await turn.catch(() => {});
if (scenario === "hang-close") host.close();
await host.closed;
process.stdout.write("closed\n");
