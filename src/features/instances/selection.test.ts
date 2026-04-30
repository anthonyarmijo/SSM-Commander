import { describe, expect, it } from "vitest";
import { getInstancePowerSelection, normalizeInstanceSelection, updateInstanceSelection } from "./selection";

const orderedInstanceIds = ["i-1", "i-2", "i-3", "i-4"];

describe("instance selection helpers", () => {
  it("selects a single row on plain click", () => {
    expect(updateInstanceSelection({
      selectedInstanceIds: ["i-1"],
      primarySelectedInstanceId: "i-1",
      anchorInstanceId: "i-1",
      orderedInstanceIds,
      targetInstanceId: "i-3",
      toggleSelection: false,
      rangeSelection: false,
    })).toEqual({
      selectedInstanceIds: ["i-3"],
      primarySelectedInstanceId: "i-3",
      anchorInstanceId: "i-3",
    });
  });

  it("toggles rows with modifier selection", () => {
    expect(updateInstanceSelection({
      selectedInstanceIds: ["i-1"],
      primarySelectedInstanceId: "i-1",
      anchorInstanceId: "i-1",
      orderedInstanceIds,
      targetInstanceId: "i-3",
      toggleSelection: true,
      rangeSelection: false,
    })).toEqual({
      selectedInstanceIds: ["i-1", "i-3"],
      primarySelectedInstanceId: "i-3",
      anchorInstanceId: "i-3",
    });
  });

  it("selects a contiguous range with shift selection", () => {
    expect(updateInstanceSelection({
      selectedInstanceIds: ["i-2"],
      primarySelectedInstanceId: "i-2",
      anchorInstanceId: "i-2",
      orderedInstanceIds,
      targetInstanceId: "i-4",
      toggleSelection: false,
      rangeSelection: true,
    })).toEqual({
      selectedInstanceIds: ["i-2", "i-3", "i-4"],
      primarySelectedInstanceId: "i-4",
      anchorInstanceId: "i-2",
    });
  });

  it("normalizes selection after refresh removes missing rows", () => {
    expect(normalizeInstanceSelection(
      [
        { instanceId: "i-2", state: "running", platform: "linux", tags: [], ssmStatus: "ready" },
        { instanceId: "i-3", state: "stopped", platform: "linux", tags: [], ssmStatus: "unknown" },
      ],
      ["i-1", "i-2", "i-3"],
      "i-1",
      "i-1",
    )).toEqual({
      selectedInstanceIds: ["i-2", "i-3"],
      primarySelectedInstanceId: "i-2",
      anchorInstanceId: "i-2",
    });
  });

  it("defaults to the first available row when selection becomes empty", () => {
    expect(normalizeInstanceSelection(
      [
        { instanceId: "i-2", state: "running", platform: "linux", tags: [], ssmStatus: "ready" },
        { instanceId: "i-3", state: "stopped", platform: "linux", tags: [], ssmStatus: "unknown" },
      ],
      [],
      "",
      "",
    )).toEqual({
      selectedInstanceIds: ["i-2"],
      primarySelectedInstanceId: "i-2",
      anchorInstanceId: "i-2",
    });
  });
});

describe("bulk power selection", () => {
  const instances = [
    { instanceId: "i-1", state: "running", platform: "linux", tags: [], ssmStatus: "ready" as const },
    { instanceId: "i-2", state: "stopped", platform: "linux", tags: [], ssmStatus: "unknown" as const },
    { instanceId: "i-3", state: "running", platform: "windows", tags: [], ssmStatus: "offline" as const },
  ];

  it("filters start eligibility across a mixed selection", () => {
    expect(getInstancePowerSelection(instances, ["i-1", "i-2", "i-3"], "start")).toEqual({
      selectedCount: 3,
      eligibleInstanceIds: ["i-2"],
    });
  });

  it("filters stop eligibility across a mixed selection", () => {
    expect(getInstancePowerSelection(instances, ["i-1", "i-2", "i-3"], "stop")).toEqual({
      selectedCount: 3,
      eligibleInstanceIds: ["i-1", "i-3"],
    });
  });
});
