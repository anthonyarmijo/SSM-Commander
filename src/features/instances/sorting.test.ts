import { describe, expect, it } from "vitest";
import { filterInstances } from "./filters";
import { sortInstances, toggleInstanceTableSort, type InstanceTableSort } from "./sorting";
import type { InstanceSummary } from "../../types/models";

const instances: InstanceSummary[] = [
  {
    instanceId: "demo-node-charlie",
    name: "web-3",
    state: "stopped",
    platform: "windows",
    privateIp: "192.0.2.20",
    publicIp: "203.0.113.4",
    launchTime: "2025-01-03T00:00:00Z",
    tags: [{ key: "Name", value: "web-3" }],
    ssmStatus: "offline",
    ssmPingStatus: "Offline",
    agentVersion: "3.2.100.0",
  },
  {
    instanceId: "demo-node-alpha",
    name: "app-1",
    state: "running",
    platform: "linux",
    privateIp: "192.0.2.3",
    publicIp: "203.0.113.2",
    launchTime: "2025-01-01T00:00:00Z",
    tags: [{ key: "Name", value: "app-1" }],
    ssmStatus: "ready",
    ssmPingStatus: "Online",
    agentVersion: "3.2.90.0",
  },
  {
    instanceId: "demo-node-bravo",
    name: "Batch-2",
    state: "pending",
    platform: "linux",
    privateIp: "192.0.2.12",
    publicIp: "203.0.113.3",
    launchTime: "2025-01-02T00:00:00Z",
    tags: [{ key: "Name", value: "Batch-2" }],
    ssmStatus: "unknown",
    ssmPingStatus: "Pending",
    agentVersion: "3.2.95.0",
  },
];

function sortIds(sort: InstanceTableSort | null): string[] {
  return sortInstances(instances, sort).map((instance) => instance.instanceId);
}

describe("instance sorting helpers", () => {
  it("toggles sort direction from ascending to descending on repeated clicks", () => {
    expect(toggleInstanceTableSort(null, "name")).toEqual({ columnId: "name", direction: "asc" });
    expect(toggleInstanceTableSort({ columnId: "name", direction: "asc" }, "name")).toEqual({
      columnId: "name",
      direction: "desc",
    });
  });

  it("sorts states by operational rank", () => {
    expect(sortIds({ columnId: "state", direction: "asc" })).toEqual(["demo-node-alpha", "demo-node-bravo", "demo-node-charlie"]);
    expect(sortIds({ columnId: "state", direction: "desc" })).toEqual(["demo-node-charlie", "demo-node-bravo", "demo-node-alpha"]);
  });

  it("sorts text columns case-insensitively", () => {
    expect(sortIds({ columnId: "name", direction: "asc" })).toEqual(["demo-node-alpha", "demo-node-bravo", "demo-node-charlie"]);
    expect(sortIds({ columnId: "platform", direction: "desc" })).toEqual(["demo-node-charlie", "demo-node-alpha", "demo-node-bravo"]);
  });

  it("sorts IP addresses and launch times numerically", () => {
    expect(sortIds({ columnId: "privateIp", direction: "asc" })).toEqual(["demo-node-alpha", "demo-node-bravo", "demo-node-charlie"]);
    expect(sortIds({ columnId: "launchTime", direction: "desc" })).toEqual(["demo-node-charlie", "demo-node-bravo", "demo-node-alpha"]);
  });

  it("sorts the filtered subset without reintroducing hidden rows", () => {
    const filtered = filterInstances(instances, "192.0.2.");
    expect(sortInstances(filtered, { columnId: "privateIp", direction: "desc" }).map((instance) => instance.instanceId)).toEqual([
      "demo-node-charlie",
      "demo-node-bravo",
      "demo-node-alpha",
    ]);
  });
});
