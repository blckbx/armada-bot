import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | undefined;

export function setArmadaRuntime(nextRuntime: PluginRuntime): void {
  runtime = nextRuntime;
}

export function getArmadaRuntime(): PluginRuntime {
  if (runtime === undefined) {
    throw new Error("Armada DM runtime is not initialized.");
  }
  return runtime;
}
