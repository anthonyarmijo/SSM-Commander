import type { InstanceSummary } from "../../types/models";
import type { InstanceTableColumnId } from "./tableColumns";

export type InstanceTableSortDirection = "asc" | "desc";

export interface InstanceTableSort {
  columnId: InstanceTableColumnId;
  direction: InstanceTableSortDirection;
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const instanceStateRank: Record<string, number> = {
  running: 0,
  pending: 1,
  stopping: 2,
  stopped: 3,
};

function compareNumbers(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareText(left: string | null | undefined, right: string | null | undefined): number {
  const normalizedLeft = left?.trim() ?? "";
  const normalizedRight = right?.trim() ?? "";
  return collator.compare(normalizedLeft, normalizedRight);
}

function parseIpAddress(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const parsed = parts.map((part) => Number.parseInt(part, 10));
  if (parsed.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }

  return parsed;
}

function compareIpAddresses(left: string | null | undefined, right: string | null | undefined): number {
  const parsedLeft = parseIpAddress(left);
  const parsedRight = parseIpAddress(right);

  if (parsedLeft && parsedRight) {
    for (let index = 0; index < parsedLeft.length; index += 1) {
      const delta = parsedLeft[index] - parsedRight[index];
      if (delta !== 0) {
        return delta;
      }
    }
    return 0;
  }

  return compareText(left, right);
}

function parseLaunchTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getPlatformSortLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("windows")) return "Windows";
  if (normalized.includes("linux")) return "Linux";
  return platform;
}

function compareState(left: string, right: string): number {
  const leftRank = instanceStateRank[left.toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  const rightRank = instanceStateRank[right.toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  return compareNumbers(leftRank, rightRank) || compareText(left, right);
}

function compareInstances(left: InstanceSummary, right: InstanceSummary, columnId: InstanceTableColumnId): number {
  switch (columnId) {
    case "state":
      return compareState(left.state, right.state);
    case "name":
      return compareText(left.name || "Unnamed", right.name || "Unnamed");
    case "platform":
      return compareText(getPlatformSortLabel(left.platform), getPlatformSortLabel(right.platform));
    case "privateIp":
      return compareIpAddresses(left.privateIp, right.privateIp);
    case "publicIp":
      return compareIpAddresses(left.publicIp, right.publicIp);
    case "launchTime":
      return compareNumbers(parseLaunchTime(left.launchTime), parseLaunchTime(right.launchTime)) || compareText(left.launchTime, right.launchTime);
    case "instanceId":
      return compareText(left.instanceId, right.instanceId);
    case "vpcId":
      return compareText(left.vpcId, right.vpcId);
    case "subnetId":
      return compareText(left.subnetId, right.subnetId);
    case "ssmStatus":
      return compareText(left.ssmStatus, right.ssmStatus);
    case "ssmPingStatus":
      return compareText(left.ssmPingStatus, right.ssmPingStatus);
    case "agentVersion":
      return compareText(left.agentVersion, right.agentVersion);
    default:
      return 0;
  }
}

export function toggleInstanceTableSort(
  current: InstanceTableSort | null,
  columnId: InstanceTableColumnId,
): InstanceTableSort {
  if (!current || current.columnId !== columnId) {
    return { columnId, direction: "asc" };
  }

  return {
    columnId,
    direction: current.direction === "asc" ? "desc" : "asc",
  };
}

export function sortInstances(
  instances: InstanceSummary[],
  sort: InstanceTableSort | null,
): InstanceSummary[] {
  if (!sort) {
    return instances;
  }

  const directionMultiplier = sort.direction === "asc" ? 1 : -1;

  return [...instances].sort((left, right) => {
    const comparison = compareInstances(left, right, sort.columnId);
    if (comparison !== 0) {
      return comparison * directionMultiplier;
    }

    return compareText(left.instanceId, right.instanceId);
  });
}
