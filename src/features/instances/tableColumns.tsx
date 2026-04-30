import type { ReactNode } from "react";
import { StatusPill } from "../../components/StatusPill";
import type { InstanceSummary } from "../../types/models";

export type InstanceTableColumnId =
  | "name"
  | "instanceId"
  | "state"
  | "privateIp"
  | "platform"
  | "publicIp"
  | "vpcId"
  | "subnetId"
  | "launchTime"
  | "ssmStatus"
  | "ssmPingStatus"
  | "agentVersion";

export interface InstanceTableColumnDefinition {
  id: InstanceTableColumnId;
  label: string;
  minWidth: number;
  defaultWidth: number;
  resizable: boolean;
  renderCell: (instance: InstanceSummary) => ReactNode;
}

export interface InstanceTableColumnLayout {
  definition: InstanceTableColumnDefinition;
  width: number;
}

export type InstanceTableColumnWidths = Partial<Record<InstanceTableColumnId, number>>;

function ssmTone(status: string): "good" | "warn" | "bad" | "neutral" {
  if (status === "ready") return "good";
  if (status === "offline" || status === "notManaged") return "warn";
  if (status === "accessDenied" || status === "error") return "bad";
  return "neutral";
}

function formatLaunchTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function StateIcon({ state }: { state: string }) {
  const normalized = state.toLowerCase();
  const tone =
    normalized === "running"
      ? "instance-icon instance-icon--good"
      : normalized === "stopped"
        ? "instance-icon instance-icon--stopped"
        : normalized === "pending" || normalized === "stopping"
          ? "instance-icon instance-icon--warn"
          : "instance-icon instance-icon--muted";

  return (
    <span aria-label={state} className={tone} role="img" title={state}>
      <svg aria-hidden="true" className="platform-chip__icon" fill="none" viewBox="0 0 24 24">
        {normalized === "running" && <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />}
        {normalized === "stopped" && <rect fill="currentColor" height="12" rx="1.75" stroke="none" width="12" x="6" y="6" />}
        {normalized === "pending" && (
          <>
            <circle cx="12" cy="12" r="6" />
            <path d="M12 6a6 6 0 0 1 6 6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
          </>
        )}
        {normalized === "stopping" && (
          <>
            <circle cx="12" cy="12" r="6" />
            <path d="M12 18a6 6 0 0 1-6-6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
          </>
        )}
        {!["running", "stopped", "pending", "stopping"].includes(normalized) && <circle cx="12" cy="12" r="6" />}
      </svg>
    </span>
  );
}

function PlatformIcon({ platform }: { platform: string }) {
  const normalized = platform.toLowerCase();
  const label = normalized.includes("windows") ? "Windows" : normalized.includes("linux") ? "Linux" : platform;

  return (
    <span aria-label={label} className="platform-chip" role="img" title={label}>
      {normalized.includes("windows") ? (
        <svg aria-hidden="true" className="platform-chip__icon" fill="none" viewBox="0 0 24 24">
          <path d="M4 5.5 11 4v7H4Zm9 5.5V4l9-1v8Zm-9 2h7v7.5l-7-1Zm9 0h9v8l-9-1Z" />
        </svg>
      ) : normalized.includes("linux") ? (
        <svg aria-hidden="true" className="platform-chip__icon" fill="none" viewBox="0 0 24 24">
          <path d="M9.5 4.5c0-1.66 1.12-3 2.5-3s2.5 1.34 2.5 3c0 1.05-.45 2.05-1.2 2.62 2.34.84 4.2 3.34 4.2 6.38 0 1.74-.62 3.54-1.82 5.28-.6.87-1.77 1.13-2.68.58L12 18.75l-1 1.61c-.91.55-2.08.29-2.68-.58C7.12 18.04 6.5 16.24 6.5 14.5c0-3.04 1.86-5.54 4.2-6.38-.75-.57-1.2-1.57-1.2-2.62Z" />
          <path d="M10 8.75h.01M14 8.75h.01M9.25 14.5c1.05.9 4.45.9 5.5 0" />
        </svg>
      ) : (
        <svg aria-hidden="true" className="platform-chip__icon" fill="none" viewBox="0 0 24 24">
          <rect height="12" rx="1.5" width="16" x="4" y="5" />
          <path d="M10 19h4M8 22h8" />
        </svg>
      )}
    </span>
  );
}

export const instanceTableColumns: InstanceTableColumnDefinition[] = [
  {
    id: "name",
    label: "Name",
    minWidth: 110,
    defaultWidth: 210,
    resizable: true,
    renderCell: (instance) => instance.name || "Unnamed",
  },
  {
    id: "instanceId",
    label: "Instance ID",
    minWidth: 150,
    defaultWidth: 170,
    resizable: true,
    renderCell: (instance) => <code>{instance.instanceId}</code>,
  },
  {
    id: "state",
    label: "State",
    minWidth: 72,
    defaultWidth: 88,
    resizable: true,
    renderCell: (instance) => <StateIcon state={instance.state} />,
  },
  {
    id: "privateIp",
    label: "Private IP",
    minWidth: 118,
    defaultWidth: 132,
    resizable: true,
    renderCell: (instance) => instance.privateIp || "-",
  },
  {
    id: "platform",
    label: "Platform",
    minWidth: 72,
    defaultWidth: 82,
    resizable: true,
    renderCell: (instance) => <PlatformIcon platform={instance.platform} />,
  },
  {
    id: "publicIp",
    label: "Public IP",
    minWidth: 118,
    defaultWidth: 132,
    resizable: true,
    renderCell: (instance) => instance.publicIp || "-",
  },
  {
    id: "vpcId",
    label: "VPC",
    minWidth: 128,
    defaultWidth: 148,
    resizable: true,
    renderCell: (instance) => instance.vpcId || "-",
  },
  {
    id: "subnetId",
    label: "Subnet",
    minWidth: 130,
    defaultWidth: 160,
    resizable: true,
    renderCell: (instance) => instance.subnetId || "-",
  },
  {
    id: "launchTime",
    label: "Launch Time",
    minWidth: 168,
    defaultWidth: 188,
    resizable: true,
    renderCell: (instance) => formatLaunchTime(instance.launchTime),
  },
  {
    id: "ssmStatus",
    label: "SSM",
    minWidth: 112,
    defaultWidth: 128,
    resizable: true,
    renderCell: (instance) => <StatusPill label={instance.ssmStatus} tone={ssmTone(instance.ssmStatus)} />,
  },
  {
    id: "ssmPingStatus",
    label: "Ping",
    minWidth: 108,
    defaultWidth: 120,
    resizable: true,
    renderCell: (instance) => instance.ssmPingStatus || "-",
  },
  {
    id: "agentVersion",
    label: "Agent Version",
    minWidth: 130,
    defaultWidth: 144,
    resizable: true,
    renderCell: (instance) => instance.agentVersion || "-",
  },
];

const legacyDefaultInstanceTableVisibleColumns: InstanceTableColumnId[] = ["name", "instanceId", "state", "platform", "privateIp"];

export const defaultInstanceTableVisibleColumns: InstanceTableColumnId[] = ["state", "name", "platform", "privateIp"];

const instanceTableColumnIdSet = new Set<InstanceTableColumnId>(instanceTableColumns.map((column) => column.id));
const instanceTableColumnDefinitions = new Map<InstanceTableColumnId, InstanceTableColumnDefinition>(
  instanceTableColumns.map((column) => [column.id, column]),
);
const instanceTableColumnOrder = new Map<InstanceTableColumnId, number>(
  instanceTableColumns.map((column, index) => [column.id, index]),
);

export function isInstanceTableColumnId(value: string): value is InstanceTableColumnId {
  return instanceTableColumnIdSet.has(value as InstanceTableColumnId);
}

export function normalizeInstanceTableVisibleColumns(value: string[] | null | undefined): InstanceTableColumnId[] {
  if (!Array.isArray(value)) {
    return [...defaultInstanceTableVisibleColumns];
  }

  const seen = new Set<InstanceTableColumnId>();
  const normalized = value.filter((columnId): columnId is InstanceTableColumnId => {
    if (!isInstanceTableColumnId(columnId) || seen.has(columnId)) {
      return false;
    }
    seen.add(columnId);
    return true;
  });

  return normalized.length > 0 ? normalized : [...defaultInstanceTableVisibleColumns];
}

export function normalizeInitialInstanceTableVisibleColumns(value: string[] | null | undefined): {
  columns: InstanceTableColumnId[];
  migrated: boolean;
} {
  const normalized = normalizeInstanceTableVisibleColumns(value);
  const migrated =
    normalized.length === legacyDefaultInstanceTableVisibleColumns.length &&
    normalized.every((columnId, index) => columnId === legacyDefaultInstanceTableVisibleColumns[index]);

  return {
    columns: migrated ? [...defaultInstanceTableVisibleColumns] : normalized,
    migrated,
  };
}

export function normalizeInstanceTableColumnWidths(value: Record<string, number> | null | undefined): InstanceTableColumnWidths {
  if (!value || typeof value !== "object") {
    return {};
  }

  const normalized: InstanceTableColumnWidths = {};
  for (const [columnId, width] of Object.entries(value)) {
    if (!isInstanceTableColumnId(columnId) || typeof width !== "number" || !Number.isFinite(width)) {
      continue;
    }

    const definition = instanceTableColumns.find((column) => column.id === columnId);
    if (!definition) continue;
    normalized[columnId] = Math.max(definition.minWidth, Math.round(width));
  }
  return normalized;
}

export function toggleInstanceTableColumn(
  visibleColumnIds: InstanceTableColumnId[],
  columnId: InstanceTableColumnId,
  isVisible: boolean,
): InstanceTableColumnId[] {
  const current = normalizeInstanceTableVisibleColumns(visibleColumnIds);
  const exists = current.includes(columnId);

  if (isVisible) {
    if (exists) return current;
    const targetIndex = instanceTableColumnOrder.get(columnId) ?? instanceTableColumns.length;
    const next = [...current];
    const insertionIndex = next.findIndex((visibleId) => {
      const visibleIndex = instanceTableColumnOrder.get(visibleId) ?? instanceTableColumns.length;
      return visibleIndex > targetIndex;
    });

    if (insertionIndex === -1) {
      next.push(columnId);
      return next;
    }

    next.splice(insertionIndex, 0, columnId);
    return next;
  }

  if (!exists || current.length === 1) {
    return current;
  }

  return current.filter((id) => id !== columnId);
}

export function buildInstanceTableLayout(
  visibleColumnIds: string[] | null | undefined,
  savedWidths: Record<string, number> | null | undefined,
): InstanceTableColumnLayout[] {
  const normalizedVisibleColumnIds = normalizeInstanceTableVisibleColumns(visibleColumnIds);
  const normalizedWidths = normalizeInstanceTableColumnWidths(savedWidths);

  return normalizedVisibleColumnIds
    .map((columnId) => instanceTableColumnDefinitions.get(columnId))
    .filter((definition): definition is InstanceTableColumnDefinition => Boolean(definition))
    .map((definition) => ({
      definition,
      width: normalizedWidths[definition.id] ?? definition.defaultWidth,
    }));
}
