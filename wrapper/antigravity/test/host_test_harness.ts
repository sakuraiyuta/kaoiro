import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { WrapperConfig } from "@kaoiro/agent-common";
import { AntigravityHost, type AntigravityHostOptions, type GateProbe, type SpawnedAgy } from "../src/host.js";

class HarnessChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.killed = signal;
    return true;
  }

  finish(): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

function unavailableProbe(): GateProbe {
  const child = new HarnessChild();
  queueMicrotask(() => {
    const error = Object.assign(new Error("test harness probe is disabled"), { code: "ENOENT" });
    child.emit("error", error);
  });
  return child as unknown as GateProbe;
}

function fakeSignalTarget(target: unknown, _destination: "pid" | "process_group", signal: NodeJS.Signals): boolean {
  if (typeof target !== "object" || target === null) return false;
  const kill = (target as { kill?: (value: NodeJS.Signals) => boolean }).kill;
  return typeof kill === "function" ? kill.call(target, signal) : false;
}

export interface HarnessAgy extends SpawnedAgy {
  finish(): void;
}

export interface HostHarnessObserver {
  onAgySpawn?: (child: HarnessAgy) => void;
  onGateProbeSpawn?: () => void;
  onModelsProbeSpawn?: () => void;
  onUsageProbeSpawn?: () => void;
}

/** One place that prevents unit tests from starting or signalling real children. */
export function createHarnessHost(
  config: WrapperConfig,
  options: AntigravityHostOptions,
  observer: HostHarnessObserver = {},
): AntigravityHost {
  return new AntigravityHost(config, {
    ...options,
    spawn: options.spawn ?? (() => {
      const child = new HarnessChild();
      observer.onAgySpawn?.(child as unknown as HarnessAgy);
      return child as unknown as SpawnedAgy;
    }),
    probeSpawn: options.probeSpawn ?? (() => {
      observer.onGateProbeSpawn?.();
      return unavailableProbe();
    }),
    modelsProbeSpawn: options.modelsProbeSpawn ?? (() => {
      observer.onModelsProbeSpawn?.();
      return unavailableProbe();
    }),
    usageProbeSpawn: options.usageProbeSpawn ?? (() => {
      observer.onUsageProbeSpawn?.();
      return unavailableProbe() as unknown as any;
    }),
    signalTarget: options.signalTarget ?? fakeSignalTarget,
  });
}
