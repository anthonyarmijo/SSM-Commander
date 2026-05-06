import type { ConsoleSessionKind, InstanceSummary } from "../../types/models";

export function isLinuxInstance(instance: Pick<InstanceSummary, "platform">): boolean {
  return instance.platform.toLowerCase().includes("linux");
}

export function defaultConnectionKindForInstance(instance: Pick<InstanceSummary, "platform">): ConsoleSessionKind {
  return isLinuxInstance(instance) ? "ssh" : "rdp";
}
