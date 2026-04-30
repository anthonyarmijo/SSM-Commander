import type { InstanceSummary } from "../../types/models";

export function filterInstances(instances: InstanceSummary[], query: string): InstanceSummary[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return instances;
  }

  return instances.filter((instance) => {
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

