import { describe, expect, it } from "vitest";
import type { InstanceSummary } from "../../types/models";
import { filterInstances } from "./filters";

const instances: InstanceSummary[] = [
  {
    instanceId: "demo-alpha",
    name: "sample-alpha",
    state: "running",
    platform: "linux",
    privateIp: "192.0.2.10",
    publicIp: null,
    vpcId: null,
    subnetId: null,
    launchTime: null,
    tags: [{ key: "Team", value: "Ops" }],
    ssmStatus: "ready",
  },
  {
    instanceId: "demo-beta",
    name: "sample-beta",
    state: "stopped",
    platform: "windows",
    privateIp: "192.0.2.20",
    publicIp: null,
    vpcId: null,
    subnetId: null,
    launchTime: null,
    tags: [{ key: "Role", value: "rdp" }],
    ssmStatus: "offline",
  },
];

describe("filterInstances", () => {
  it("matches by name, id, ip, and tags", () => {
    expect(filterInstances(instances, "sample-alpha")).toHaveLength(1);
    expect(filterInstances(instances, "demo-beta")).toHaveLength(1);
    expect(filterInstances(instances, "192.0.2.20")).toHaveLength(1);
    expect(filterInstances(instances, "ops")).toHaveLength(1);
  });

  it("returns all instances for blank queries", () => {
    expect(filterInstances(instances, " ")).toHaveLength(2);
  });

  it("filters common power states independently from search", () => {
    expect(filterInstances(instances, "", "running").map((instance) => instance.instanceId)).toEqual(["demo-alpha"]);
    expect(filterInstances(instances, "", "stopped").map((instance) => instance.instanceId)).toEqual(["demo-beta"]);
    expect(filterInstances(instances, "sample", "running")).toHaveLength(1);
    expect(filterInstances(instances, "sample-beta", "running")).toHaveLength(0);
  });

  it("groups non-running and non-stopped states as transitional", () => {
    const pending = { ...instances[0], instanceId: "demo-pending", state: "pending" };
    expect(filterInstances([...instances, pending], "", "transitional")).toEqual([pending]);
  });
});
