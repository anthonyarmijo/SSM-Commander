import type { InstancePowerAction, InstanceSummary } from "../../types/models";

export interface InstanceSelectionState {
  selectedInstanceIds: string[];
  primarySelectedInstanceId: string;
  anchorInstanceId: string;
}

export interface InstanceSelectionInput extends InstanceSelectionState {
  orderedInstanceIds: string[];
  targetInstanceId: string;
  toggleSelection: boolean;
  rangeSelection: boolean;
}

export interface InstancePowerSelection {
  selectedCount: number;
  eligibleInstanceIds: string[];
}

export function updateInstanceSelection(input: InstanceSelectionInput): InstanceSelectionState {
  const {
    selectedInstanceIds,
    primarySelectedInstanceId,
    anchorInstanceId,
    orderedInstanceIds,
    targetInstanceId,
    toggleSelection,
    rangeSelection,
  } = input;

  if (rangeSelection && anchorInstanceId && orderedInstanceIds.includes(anchorInstanceId)) {
    const startIndex = orderedInstanceIds.indexOf(anchorInstanceId);
    const endIndex = orderedInstanceIds.indexOf(targetInstanceId);
    if (startIndex >= 0 && endIndex >= 0) {
      const [start, end] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
      return {
        selectedInstanceIds: orderedInstanceIds.slice(start, end + 1),
        primarySelectedInstanceId: targetInstanceId,
        anchorInstanceId,
      };
    }
  }

  if (toggleSelection) {
    const nextSelected = selectedInstanceIds.includes(targetInstanceId)
      ? selectedInstanceIds.filter((instanceId) => instanceId !== targetInstanceId)
      : [...selectedInstanceIds, targetInstanceId];

    return {
      selectedInstanceIds: nextSelected,
      primarySelectedInstanceId: nextSelected.includes(targetInstanceId)
        ? targetInstanceId
        : nextSelected[0] ?? "",
      anchorInstanceId: targetInstanceId,
    };
  }

  return {
    selectedInstanceIds: [targetInstanceId],
    primarySelectedInstanceId: targetInstanceId,
    anchorInstanceId: targetInstanceId,
  };
}

export function normalizeInstanceSelection(
  instances: InstanceSummary[],
  selectedInstanceIds: string[],
  primarySelectedInstanceId: string,
  anchorInstanceId: string,
): InstanceSelectionState {
  const availableIds = new Set(instances.map((instance) => instance.instanceId));
  const normalizedSelectedInstanceIds = selectedInstanceIds.filter((instanceId) => availableIds.has(instanceId));
  const nextSelectedInstanceIds = normalizedSelectedInstanceIds.length > 0
    ? normalizedSelectedInstanceIds
    : (instances[0] ? [instances[0].instanceId] : []);
  const nextPrimarySelectedInstanceId = availableIds.has(primarySelectedInstanceId)
    ? primarySelectedInstanceId
    : nextSelectedInstanceIds[0] ?? "";
  const nextAnchorInstanceId = availableIds.has(anchorInstanceId)
    ? anchorInstanceId
    : nextPrimarySelectedInstanceId;

  return {
    selectedInstanceIds: nextSelectedInstanceIds,
    primarySelectedInstanceId: nextPrimarySelectedInstanceId,
    anchorInstanceId: nextAnchorInstanceId,
  };
}

export function getInstancePowerSelection(
  instances: InstanceSummary[],
  selectedInstanceIds: string[],
  action: InstancePowerAction,
): InstancePowerSelection {
  const selected = new Set(selectedInstanceIds);
  const eligibleInstanceIds = instances
    .filter((instance) => selected.has(instance.instanceId))
    .filter((instance) => (
      action === "start"
        ? instance.state === "stopped"
        : instance.state === "running"
    ))
    .map((instance) => instance.instanceId);

  return {
    selectedCount: selectedInstanceIds.length,
    eligibleInstanceIds,
  };
}
