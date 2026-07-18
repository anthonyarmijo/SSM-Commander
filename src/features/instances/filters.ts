import type { InstanceSummary } from "../../types/models";

export type InstanceStateFilter = "all" | "running" | "stopped" | "transitional";

function matchesStateFilter(instance: InstanceSummary, stateFilter: InstanceStateFilter): boolean {
  const state = instance.state.trim().toLowerCase();
  if (stateFilter === "all") return true;
  if (stateFilter === "running") return state === "running";
  if (stateFilter === "stopped") return state === "stopped";
  return state !== "running" && state !== "stopped";
}

export function filterInstances(
  instances: InstanceSummary[],
  query: string,
  stateFilter: InstanceStateFilter = "all",
): InstanceSummary[] {
  const normalized = query.trim().toLowerCase();

  return instances.filter((instance) => {
    if (!matchesStateFilter(instance, stateFilter)) return false;
    if (!normalized) return true;

    const searchable = [
      instance.instanceId,
      instance.name ?? "",
      instance.state,
      instance.platform,
      instance.privateIp ?? "",
      instance.publicIp ?? "",
      instance.vpcId ?? "",
      instance.subnetId ?? "",
      ...instance.tags.flatMap((tag) => [tag.key, tag.value]),
    ].join(" ").toLowerCase();

    return searchable.includes(normalized);
  });
}
