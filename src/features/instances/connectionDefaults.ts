import type { CredentialKind, InstanceSummary } from "../../types/models";

export function isLinuxInstance(instance: Pick<InstanceSummary, "platform">): boolean {
  return instance.platform.toLowerCase().includes("linux");
}

export function defaultConnectionKindForInstance(instance: Pick<InstanceSummary, "platform">): CredentialKind {
  return isLinuxInstance(instance) ? "ssh" : "rdp";
}
