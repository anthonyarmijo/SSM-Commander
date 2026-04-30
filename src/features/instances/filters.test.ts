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
});
