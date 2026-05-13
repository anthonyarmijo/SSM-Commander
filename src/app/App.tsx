import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { listen } from "@tauri-apps/api/event";
import { message as dialogMessage, open as openDialog } from "@tauri-apps/plugin-dialog";
import Guacamole from "guacamole-common-js";
import "@xterm/xterm/css/xterm.css";
import { StatusPill } from "../components/StatusPill";
import { filterInstances } from "../features/instances/filters";
import { defaultConnectionKindForInstance } from "../features/instances/connectionDefaults";
import {
  matchingCredentials,
  selectDefaultCredentialId,
} from "../features/instances/credentialDefaults";
import {
  getInstancePowerSelection,
  normalizeInstanceSelection,
  updateInstanceSelection,
} from "../features/instances/selection";
import {
  sortInstances,
  toggleInstanceTableSort,
  type InstanceTableSort,
} from "../features/instances/sorting";
import {
  buildInstanceTableLayout,
  defaultInstanceTableVisibleColumns,
  instanceTableColumns,
  normalizeInitialInstanceTableVisibleColumns,
  normalizeInstanceTableColumnWidths,
  normalizeInstanceTableVisibleColumns,
  toggleInstanceTableColumn,
  type InstanceTableColumnId,
  type InstanceTableColumnWidths,
} from "../features/instances/tableColumns";
import {
  buildProfileStatusLabel,
  buildProfileStatusMessage,
  buildProfileOverview,
  getAddableProfiles,
  getProfileCapability,
  normalizeSavedProfiles,
  resolveActiveProfileRegion,
  resolveActiveProfile,
  shouldAutoExpandProfileDetails,
  summarizeRegionChips,
  type SavedProfileState,
} from "../features/profiles/profileHelpers";
import { resolveTooltipPlacement, type TooltipPreference } from "./tooltipPlacement";
import { shouldAutoCloseEndedConsoleSession } from "./consoleLifecycle";
import { buildConsoleSessionRequest } from "./consoleSessionRequest";
import { clearCredentialFormSecrets, emptyCredentialForm, type CredentialFormState } from "./credentialForm";
import { buildPortForwardInvokeArgs, validateTunnelForm } from "./tunnelForm";
import { getBrowserPreviewConfig, invokeCommand, isTauriRuntime, openExternalUrl } from "../lib/tauri";
import { isInitializationGatedView, navItems, SSM_COMMANDER_ASCII, type ActiveView } from "./navigation";
import type {
  AwsProfile,
  CapabilityStatus,
  CallerIdentity,
  ConsoleOutputEvent,
  ConsoleSessionEndedEvent,
  ConsoleSessionKind,
  ConsoleSessionRecord,
  CredentialKind,
  CredentialRecord,
  CredentialStoreStatus,
  CredentialSummary,
  DependencyCheck,
  DiagnosticEvent,
  EnvironmentState,
  InstancePowerActionResult,
  InstanceSummary,
  ProfileCapability,
  ProfileCapabilityReport,
  RdpSecurityMode,
  SessionRecord,
  SshAuthMode,
  SsoLoginAttempt,
  ThemeMode,
  UpsertCredentialRequest,
  UserPreferences,
} from "../types/models";

const DEFAULT_SIDEBAR_WIDTH = 190;
const MIN_SIDEBAR_WIDTH = 164;
const MAX_SIDEBAR_WIDTH = 260;
const SIDEBAR_KEYBOARD_STEP = 16;
const INSTANCE_COLUMN_MENU_ID = "instances-column-menu";
const RDP_SECURITY_MODE_OPTIONS: { value: RdpSecurityMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "nla", label: "NLA" },
  { value: "nla-ext", label: "NLA-Ext" },
  { value: "tls", label: "TLS" },
  { value: "rdp", label: "RDP" },
];
const EMPTY_STATE_PROFILE_HELP =
  "The app will discover AWS CLI profiles already configured on your machine. Add one to validate access and unlock the Instances and Console views.";
const SAVED_PROFILE_WORKSPACE_HELP =
  "The active profile powers instance discovery, power actions, and console sessions. Keep additional profiles pinned here so you can switch into them quickly when needed.";
const PROFILE_VALIDATION_CACHE_TTL_MS = 30 * 60 * 1000;
type ResolvedTheme = "light" | "dark";
type ProfileStateMap = Record<string, SavedProfileState>;
type InstanceContextMenuState = { instanceId: string; x: number; y: number } | null;
const technicalInputProps = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

function buildAwsContextKey(profile: string, region: string): string {
  if (!profile || !region) return "";
  return `${profile}::${region}`;
}

function formatDependencyDetail(check: DependencyCheck): string {
  const version = check.version?.trim();
  return version ? `${check.command} (${version})` : check.command;
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function defaultCapabilities(): ProfileCapability[] {
  return [
    { id: "auth", label: "Authenticated identity", status: "unknown", message: "Not checked yet." },
    { id: "regions", label: "Region discovery", status: "unknown", message: "Not checked yet." },
    { id: "ec2", label: "EC2 discovery", status: "unknown", message: "Not checked yet." },
    { id: "ssm", label: "SSM managed nodes", status: "unknown", message: "Not checked yet." },
  ];
}

function checkingCapabilities(): ProfileCapability[] {
  return defaultCapabilities().map((capability) => ({
    ...capability,
    status: "checking",
    message: "Checking…",
  }));
}

function createSavedProfileState(profileName: string): SavedProfileState {
  return {
    profileName,
    authStatus: "unknown",
    busy: null,
    ssoStarted: false,
    ssoAttemptId: null,
    isAutoRevalidating: false,
    identityAccount: null,
    validationMessage: "",
    capabilities: defaultCapabilities(),
  };
}

function cachedProfileState(profileName: string, prefs: UserPreferences): SavedProfileState | null {
  const cached = prefs.profileValidationCache?.[profileName];
  if (!cached?.account || !cached.validatedAt) return null;
  const validatedAt = Date.parse(cached.validatedAt);
  if (!Number.isFinite(validatedAt) || Date.now() - validatedAt > PROFILE_VALIDATION_CACHE_TTL_MS) return null;
  return {
    ...createSavedProfileState(profileName),
    authStatus: "valid",
    identityAccount: cached.account,
    validationMessage: cached.message || `Validated ${cached.account}.`,
  };
}

function isSsoLoginError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("sso") && (normalized.includes("token has expired") || normalized.includes("login"));
}

function dependencyTone(check: DependencyCheck): "good" | "warn" | "bad" {
  if (check.status === "present") return "good";
  if (check.required) return "bad";
  return "warn";
}

function ssmTone(status: string): "good" | "warn" | "bad" | "neutral" {
  if (status === "ready") return "good";
  if (status === "offline" || status === "notManaged") return "warn";
  if (status === "accessDenied" || status === "error") return "bad";
  return "neutral";
}

function authTone(profileState: SavedProfileState): "good" | "warn" | "bad" | "info" | "neutral" {
  if (profileState.busy === "validating") return "info";
  if (profileState.authStatus === "valid") return "good";
  if (profileState.authStatus === "expired") return "warn";
  if (profileState.authStatus === "error") return "bad";
  return "neutral";
}

function profileStateClass(profileState: SavedProfileState): string {
  if (profileState.busy === "validating") return "checking";
  if (profileState.busy === "sso") return "sso-started";
  if (profileState.authStatus === "expired" && profileState.ssoStarted) return "sso-started";
  return profileState.authStatus;
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" fill="none" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" fill="none" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" fill="none" viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function HidePanelIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" fill="none" viewBox="0 0 24 24">
      <path d="m7 6 6 6-6 6M13 6l6 6-6 6" />
    </svg>
  );
}

function NavIcon({ view }: { view: ActiveView }) {
  return (
    <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24">
      {view === "home" && (
        <>
          <path d="M4 11.5 12 4l8 7.5" />
          <path d="M6.5 10.5V20h11v-9.5" />
        </>
      )}
      {view === "initialize" && (
        <>
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 2.5v3M12 18.5v3M4.8 4.8l2.1 2.1M17.1 17.1l2.1 2.1M2.5 12h3M18.5 12h3M4.8 19.2l2.1-2.1M17.1 6.9l2.1-2.1" />
        </>
      )}
      {view === "credentials" && (
        <>
          <rect height="10" rx="2" width="14" x="5" y="10" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2.5" />
        </>
      )}
      {view === "instances" && (
        <>
          <rect height="6" rx="1.5" width="14" x="5" y="4" />
          <rect height="6" rx="1.5" width="14" x="5" y="14" />
          <path d="M8 7h.01M8 17h.01M12 7h4M12 17h4" />
        </>
      )}
      {view === "console" && (
        <>
          <rect height="14" rx="2" width="18" x="3" y="5" />
          <path d="m8 10 3 2-3 2M13 15h4" />
        </>
      )}
      {view === "activity" && (
        <>
          <path d="M4 17V7M9 17V4M14 17v-6M19 17V9" />
          <path d="M3 20h18" />
        </>
      )}
      {view === "logs" && (
        <>
          <path d="M7 4h10l3 3v13H7z" />
          <path d="M17 4v4h4M10 11h7M10 15h7" />
        </>
      )}
    </svg>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" className="theme-icon" fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.93 4.93 6.7 6.7M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" className="theme-icon" fill="none" viewBox="0 0 24 24">
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a7.5 7.5 0 1 0 11 11Z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" fill="none" viewBox="0 0 24 24">
      <path d="M20 12a8 8 0 0 1-13.66 5.66M4 12A8 8 0 0 1 17.66 6.34M17 3.5h2.5V6M7 20.5H4.5V18" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" className="button-icon" fill="none" viewBox="0 0 24 24">
      <rect height="11" rx="2" width="9" x="9" y="8" />
      <path d="M6 15V7a2 2 0 0 1 2-2h7" />
    </svg>
  );
}

function SortIcon({ direction }: { direction: "asc" | "desc" | "none" }) {
  return (
    <svg aria-hidden="true" className={`sort-icon sort-icon--${direction}`.trim()} fill="none" viewBox="0 0 24 24">
      <path className="sort-icon__up" d="m8 10 4-4 4 4" />
      <path className="sort-icon__down" d="m8 14 4 4 4-4" />
    </svg>
  );
}

function LoadingIndicator({ label }: { label: string }) {
  return (
    <div className="loading-indicator" role="status" aria-live="polite">
      <span aria-hidden="true" className="loading-indicator__spinner" />
      <span>{label}</span>
    </div>
  );
}

function HelpTooltip({
  label,
  align = "start",
  children,
}: {
  label: string;
  align?: TooltipPreference;
  children: ReactNode;
}) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<"open-right" | "open-left">(
    align === "end" ? "open-left" : "open-right",
  );

  function updatePlacement() {
    const tooltip = tooltipRef.current;
    const content = contentRef.current;
    if (!tooltip || !content || window.matchMedia("(max-width: 860px)").matches) {
      setPlacement("open-right");
      return;
    }

    const triggerRect = tooltip.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    setPlacement(resolveTooltipPlacement({
      preferred: align,
      triggerLeft: triggerRect.left,
      triggerRight: triggerRect.right,
      tooltipWidth: contentRect.width,
      viewportWidth: window.innerWidth,
    }));
  }

  function schedulePlacementUpdate() {
    window.requestAnimationFrame(updatePlacement);
  }

  useEffect(() => {
    schedulePlacementUpdate();

    function handleResize() {
      updatePlacement();
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [align]);

  return (
    <div
      className={`tooltip tooltip--${placement}`.trim()}
      onFocusCapture={schedulePlacementUpdate}
      onMouseEnter={schedulePlacementUpdate}
      ref={tooltipRef}
    >
      <button aria-label={label} className="tooltip__trigger" type="button">
        ?
      </button>
      <div className="tooltip__content" ref={contentRef} role="tooltip">
        {children}
      </div>
    </div>
  );
}

function capabilityIndicatorTitle(status: CapabilityStatus): string {
  if (status === "available") return "Available";
  if (status === "unavailable") return "Unavailable";
  if (status === "checking") return "Checking";
  return "Not checked";
}

function consoleKindLabel(kind: ConsoleSessionKind): string {
  if (kind === "shell") return "Direct SSM (Shell)";
  return kind.toUpperCase();
}

function consoleOpenLabel(kind: ConsoleSessionKind): string {
  if (kind === "shell") return "Open SSM Shell";
  return `Open ${kind.toUpperCase()}`;
}

function credentialKindLabel(kind: CredentialKind): string {
  return kind === "ssh" ? "SSH" : "RDP";
}

function isLoadedInstancesNotice(message: string): boolean {
  return /^Loaded \d+ instances\.$/.test(message.trim());
}

function buildInstanceActionsSelectionKey(primaryInstanceId: string, selectedInstanceIds: string[]): string {
  return primaryInstanceId ? `${primaryInstanceId}::${selectedInstanceIds.join("|")}` : "";
}

function formatDiagnosticsForClipboard(events: DiagnosticEvent[]): string {
  if (events.length === 0) {
    return "No logs yet.";
  }
  return events
    .map((event) => {
      const timestamp = new Date(event.timestamp).toLocaleString();
      const command = event.command?.length ? `\ncommand: ${event.command.join(" ")}` : "";
      return `${timestamp} - ${event.area} - ${event.severity}\n${event.message}${command}`;
    })
    .join("\n\n");
}

export function App() {
  const previewConfig = useMemo(() => getBrowserPreviewConfig(), []);
  const [environment, setEnvironment] = useState<EnvironmentState | null>(null);
  const [discoveredProfiles, setDiscoveredProfiles] = useState<AwsProfile[]>([]);
  const [savedProfiles, setSavedProfiles] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState("");
  const [profileStates, setProfileStates] = useState<ProfileStateMap>({});
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [loadedInstanceContext, setLoadedInstanceContext] = useState("");
  const [autoLoadAttemptedContext, setAutoLoadAttemptedContext] = useState("");
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState("");
  const [isInstancesLoading, setIsInstancesLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [consoleSessions, setConsoleSessions] = useState<ConsoleSessionRecord[]>([]);
  const [activeConsoleSessionId, setActiveConsoleSessionId] = useState("");
  const [isConsoleDialogOpen, setIsConsoleDialogOpen] = useState(false);
  const [isTunnelDialogOpen, setIsTunnelDialogOpen] = useState(false);
  const [isTunnelStarting, setIsTunnelStarting] = useState(false);
  const [tunnelInstanceId, setTunnelInstanceId] = useState("");
  const [tunnelRemotePort, setTunnelRemotePort] = useState("");
  const [tunnelRemoteHost, setTunnelRemoteHost] = useState("");
  const [tunnelLocalPort, setTunnelLocalPort] = useState("");
  const [tunnelDialogError, setTunnelDialogError] = useState("");
  const [consoleSessionKind, setConsoleSessionKind] = useState<ConsoleSessionKind>("shell");
  const [instanceConnectionKind, setInstanceConnectionKind] = useState<ConsoleSessionKind>("rdp");
  const [consoleInstanceId, setConsoleInstanceId] = useState("");
  const [rdpUsername, setRdpUsername] = useState("");
  const [rdpDomain, setRdpDomain] = useState("");
  const [rdpPassword, setRdpPassword] = useState("");
  const [rdpSecurityMode, setRdpSecurityMode] = useState<RdpSecurityMode>("auto");
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const [logsCopyStatus, setLogsCopyStatus] = useState("");
  const [query, setQuery] = useState("");
  const [sshUser, setSshUser] = useState("ec2-user");
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshPrivateKeyContent, setSshPrivateKeyContent] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<CredentialStoreStatus | null>(null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [credentialPassphrase, setCredentialPassphrase] = useState("");
  const [credentialNotice, setCredentialNotice] = useState("");
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [selectedSshCredentialId, setSelectedSshCredentialId] = useState("");
  const [selectedRdpCredentialId, setSelectedRdpCredentialId] = useState("");
  const [customLocalPort, setCustomLocalPort] = useState("");
  const [isInstancePortMappingEnabled, setIsInstancePortMappingEnabled] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isPowerActionBusy, setIsPowerActionBusy] = useState(false);
  const [notice, setNotice] = useState("Ready.");
  const [activeView, setActiveView] = useState<ActiveView>("home");
  const [isHomeAsciiArmed, setIsHomeAsciiArmed] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => getSystemTheme());
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [instanceTableVisibleColumns, setInstanceTableVisibleColumns] = useState<InstanceTableColumnId[]>(defaultInstanceTableVisibleColumns);
  const [instanceTableColumnWidths, setInstanceTableColumnWidths] = useState<InstanceTableColumnWidths>({});
  const [instanceSort, setInstanceSort] = useState<InstanceTableSort | null>(null);
  const [expandedInstanceDetailId, setExpandedInstanceDetailId] = useState("");
  const [instanceContextMenu, setInstanceContextMenu] = useState<InstanceContextMenuState>(null);
  const [activeInstanceActionsSelectionKey, setActiveInstanceActionsSelectionKey] = useState("");
  const [isColumnMenuOpen, setIsColumnMenuOpen] = useState(false);
  const [isResizingTableColumn, setIsResizingTableColumn] = useState(false);
  const [isAddProfileOpen, setIsAddProfileOpen] = useState(false);
  const [profileToAdd, setProfileToAdd] = useState("");
  const [expandedProfileDetails, setExpandedProfileDetails] = useState<Record<string, boolean>>({});
  const preferencesRef = useRef<UserPreferences>({});
  const instancesRequestIdRef = useRef(0);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const activeConsoleSessionIdRef = useRef("");
  const manuallyClosingConsoleSessionIdsRef = useRef<Set<string>>(new Set());
  const ssoPollTimeoutsRef = useRef<Record<string, number>>({});
  const savedProfilesRef = useRef<string[]>([]);

  const activeProfileState = activeProfile ? profileStates[activeProfile] ?? createSavedProfileState(activeProfile) : null;
  const activeProfileRegion = resolveActiveProfileRegion(discoveredProfiles, activeProfile);
  const activeProfileReady = Boolean(activeProfile && activeProfileState?.authStatus === "valid" && activeProfileRegion);
  const currentAwsContextKey = buildAwsContextKey(activeProfile, activeProfileRegion);
  const selectedInstance = instances.find((instance) => instance.instanceId === selectedInstanceId) ?? null;
  const selectedInstanceActionsKey = buildInstanceActionsSelectionKey(selectedInstanceId, selectedInstanceIds);
  const shouldShowInstanceActionsOverlay = Boolean(
    selectedInstance && selectedInstanceActionsKey && selectedInstanceActionsKey === activeInstanceActionsSelectionKey,
  );
  const selectedInstanceDetailsExpanded = Boolean(selectedInstance && expandedInstanceDetailId === selectedInstance.instanceId);
  const selectedInstanceDetailPanelId = selectedInstance ? `instance-details-${selectedInstance.instanceId}` : undefined;
  const activeConsoleSession =
    consoleSessions.find((session) => session.id === activeConsoleSessionId) ?? consoleSessions[0] ?? null;
  const selectedInstanceIdSet = useMemo(() => new Set(selectedInstanceIds), [selectedInstanceIds]);
  const filteredInstances = useMemo(() => filterInstances(instances, query), [instances, query]);
  const visibleInstances = useMemo(() => sortInstances(filteredInstances, instanceSort), [filteredInstances, instanceSort]);
  const sshCredentials = useMemo(() => matchingCredentials(credentials, "ssh"), [credentials]);
  const rdpCredentials = useMemo(() => matchingCredentials(credentials, "rdp"), [credentials]);
  const instanceCredentialKind: CredentialKind | null = instanceConnectionKind === "ssh" || instanceConnectionKind === "rdp"
    ? instanceConnectionKind
    : null;
  const instanceCredentialOptions = instanceCredentialKind === "ssh" ? sshCredentials : instanceCredentialKind === "rdp" ? rdpCredentials : [];
  const selectedInstanceCredentialId = instanceCredentialKind === "ssh"
    ? selectedSshCredentialId
    : instanceCredentialKind === "rdp"
      ? selectedRdpCredentialId
      : "";
  const runningInstances = useMemo(
    () => instances.filter((instance) => instance.state === "running"),
    [instances],
  );
  const visibleInstanceTableColumns = useMemo(
    () => buildInstanceTableLayout(instanceTableVisibleColumns, instanceTableColumnWidths),
    [instanceTableColumnWidths, instanceTableVisibleColumns],
  );
  const visibleInstanceColumnCount = visibleInstanceTableColumns.length + 1;
  const instanceTableMinWidth = useMemo(
    () => visibleInstanceTableColumns.reduce((sum, column) => sum + column.width, 0),
    [visibleInstanceTableColumns],
  );
  const contextMenuInstance = instanceContextMenu
    ? instances.find((instance) => instance.instanceId === instanceContextMenu.instanceId) ?? null
    : null;
  const consoleTargetInstance = consoleInstanceId
    ? instances.find((instance) => instance.instanceId === consoleInstanceId.trim()) ?? null
    : null;
  const showInstancesRefreshing = isInstancesLoading && instances.length > 0;
  const showInitialInstancesLoader = isInstancesLoading && instances.length === 0;
  const appShellStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties;
  const isMenuSelectionRetained = activeView === "instances" && Boolean(selectedInstance);
  const shouldShowHomeNotice = !["Ready.", "Environment is ready."].includes(notice.trim());
  const hasInstancesNoticeError = activeProfileState?.authStatus === "error";
  const hasInstancesNoticeWarning = activeProfileState?.authStatus === "expired";
  const shouldQuietInstancesNotice = activeView === "instances"
    && !hasInstancesNoticeError
    && !hasInstancesNoticeWarning
    && isLoadedInstancesNotice(notice);
  const instancesNoticeClassName = [
    "notice",
    shouldQuietInstancesNotice ? "notice--quiet" : "",
    hasInstancesNoticeError ? "notice--error" : "",
    hasInstancesNoticeWarning ? "notice--warning" : "",
  ].filter(Boolean).join(" ");
  const environmentReadinessState = environment?.status === "ready" ? "good" : "warn";
  const activeProfileReadinessState =
    activeProfileState?.authStatus === "valid"
      ? "good"
      : activeProfileState?.authStatus === "expired"
        ? "warn"
        : activeProfileState?.authStatus === "error"
          ? "bad"
          : "neutral";
  const instancesReadinessState = instances.length > 0 ? "info" : "neutral";
  const sessionsReadinessState = sessions.length > 0 ? "info" : "neutral";
  const canConnectToInstance = Boolean(
    activeProfileReady && selectedInstance?.state === "running" && selectedInstance?.ssmStatus === "ready",
  );
  const connectionDisabledTitle = !activeProfileReady
    ? "Validate the active profile first."
    : selectedInstance?.ssmStatus !== "ready"
      ? "SSM must be ready before opening a connection."
      : undefined;
  const canOpenConsoleDialog = Boolean(
    activeProfileReady
      && consoleInstanceId.trim()
      && (!consoleTargetInstance || (consoleTargetInstance.state === "running" && consoleTargetInstance.ssmStatus === "ready")),
  );
  const consoleDialogDisabledTitle = !activeProfileReady
    ? "Validate the active profile first."
    : consoleTargetInstance && consoleTargetInstance.state !== "running"
      ? "Resource offline."
    : consoleTargetInstance && consoleTargetInstance.ssmStatus !== "ready"
      ? "SSM must be ready before opening a console."
      : undefined;
  const startSelection = useMemo(
    () => getInstancePowerSelection(instances, selectedInstanceIds, "start"),
    [instances, selectedInstanceIds],
  );
  const stopSelection = useMemo(
    () => getInstancePowerSelection(instances, selectedInstanceIds, "stop"),
    [instances, selectedInstanceIds],
  );
  const addableProfiles = useMemo(
    () => getAddableProfiles(discoveredProfiles, savedProfiles),
    [discoveredProfiles, savedProfiles],
  );
  const hasSavedProfiles = savedProfiles.length > 0;

  function ariaSortValue(columnId: InstanceTableColumnId): "ascending" | "descending" | "none" {
    if (instanceSort?.columnId !== columnId) {
      return "none";
    }
    return instanceSort.direction === "asc" ? "ascending" : "descending";
  }

  function renderProfilePicker(labelText: string, extraClassName = "", options?: { hideLabel?: boolean }) {
    return (
      <div className={`profile-picker ${extraClassName}`.trim()}>
        <label>
          <span className={options?.hideLabel ? "visually-hidden" : undefined}>{labelText}</span>
          <select
            aria-label={labelText}
            onChange={(event) => setProfileToAdd(event.target.value)}
            value={profileToAdd}
          >
            <option value="">{addableProfiles.length > 0 ? "Choose a profile" : "No additional profiles found"}</option>
            {addableProfiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
          </select>
        </label>
        <button
          className="button-primary"
          disabled={!profileToAdd.trim() || !addableProfiles.some((profile) => profile.name === profileToAdd.trim())}
          onClick={() => void addSavedProfile()}
          type="button"
        >
          Add
        </button>
      </div>
    );
  }

  function getProfileState(profileName: string): SavedProfileState {
    return profileStates[profileName] ?? createSavedProfileState(profileName);
  }

  async function openInstallGuide(url: string) {
    try {
      await openExternalUrl(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function updateProfileState(profileName: string, updater: (current: SavedProfileState) => SavedProfileState) {
    setProfileStates((current) => ({
      ...current,
      [profileName]: updater(current[profileName] ?? createSavedProfileState(profileName)),
    }));
  }

  function removeProfileState(profileName: string) {
    setProfileStates((current) => {
      const next = { ...current };
      delete next[profileName];
      return next;
    });
  }

  function storePreferences(nextPreferences: UserPreferences) {
    preferencesRef.current = nextPreferences;
  }

  function clearSsoPoll(profileName: string) {
    const timeoutId = ssoPollTimeoutsRef.current[profileName];
    if (typeof timeoutId === "number") {
      window.clearTimeout(timeoutId);
      delete ssoPollTimeoutsRef.current[profileName];
    }
  }

  function clearAllSsoPolls() {
    for (const profileName of Object.keys(ssoPollTimeoutsRef.current)) {
      clearSsoPoll(profileName);
    }
  }

  async function savePreferencesPatch(patch: Partial<UserPreferences>) {
    const nextPreferences = { ...preferencesRef.current, ...patch };
    storePreferences(nextPreferences);
    await invokeCommand("save_preferences", { preferences: nextPreferences });
  }

  function buildConnectionPreferences(overrides: Partial<UserPreferences> = {}): Partial<UserPreferences> {
    return {
      activeProfile: activeProfile || null,
      savedProfiles,
      lastProfile: activeProfile || null,
      defaultSshUser: sshUser,
      sshKeyPath: sshKeyPath || null,
      preferredRdpClient: null,
      ...overrides,
    };
  }

  function getProfileDefaultRegion(profileName: string): string | null {
    return resolveActiveProfileRegion(discoveredProfiles, profileName) || null;
  }

  function resetInstanceContext() {
    setInstances([]);
    setSelectedInstanceId("");
    setSelectedInstanceIds([]);
    setSelectionAnchorId("");
    setLoadedInstanceContext("");
    setAutoLoadAttemptedContext("");
  }

  async function setThemePreference(mode: ThemeMode) {
    setThemeMode(mode);
    await savePreferencesPatch({ themeMode: mode });
  }

  async function setSystemThemePreference(enabled: boolean) {
    if (enabled) {
      await setThemePreference("system");
      return;
    }
    await setThemePreference(resolvedTheme);
  }

  async function toggleManualTheme() {
    if (themeMode === "system") return;
    await setThemePreference(themeMode === "dark" ? "light" : "dark");
  }

  async function persistSidebarWidth(width: number) {
    const nextWidth = clampSidebarWidth(width);
    setSidebarWidth(nextWidth);
    await savePreferencesPatch({ sidebarWidth: nextWidth });
  }

  async function persistInstanceTableColumnWidths(nextWidths: InstanceTableColumnWidths) {
    const normalized = normalizeInstanceTableColumnWidths(nextWidths);
    setInstanceTableColumnWidths(normalized);
    await savePreferencesPatch({ instanceTableColumnWidths: normalized });
  }

  async function persistInstanceTableVisibleColumns(nextVisibleColumns: InstanceTableColumnId[]) {
    const normalized = normalizeInstanceTableVisibleColumns(nextVisibleColumns);
    setInstanceTableVisibleColumns(normalized);
    await savePreferencesPatch({ instanceTableVisibleColumns: normalized });
  }

  function updateInstanceTableColumnWidth(columnId: InstanceTableColumnId, width: number) {
    const definition = instanceTableColumns.find((column) => column.id === columnId);
    if (!definition) return;
    setInstanceTableColumnWidths((current) => ({
      ...current,
      [columnId]: Math.max(definition.minWidth, Math.round(width)),
    }));
  }

  function setInstanceColumnVisibility(columnId: InstanceTableColumnId, isVisible: boolean) {
    const nextVisibleColumns = toggleInstanceTableColumn(instanceTableVisibleColumns, columnId, isVisible);
    setInstanceTableVisibleColumns(nextVisibleColumns);
    void savePreferencesPatch({ instanceTableVisibleColumns: nextVisibleColumns });
  }

  async function loadDiagnostics() {
    const events = await invokeCommand<DiagnosticEvent[]>("get_diagnostics");
    setDiagnostics(events);
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(formatDiagnosticsForClipboard(diagnostics));
      setLogsCopyStatus("Copied");
      window.setTimeout(() => setLogsCopyStatus(""), 1800);
    } catch {
      setLogsCopyStatus("Copy failed");
      window.setTimeout(() => setLogsCopyStatus(""), 2400);
    }
  }

  async function loadSessions() {
    const active = await invokeCommand<SessionRecord[]>("list_active_sessions");
    setSessions(active);
  }

  async function loadConsoleSessions() {
    const active = await invokeCommand<ConsoleSessionRecord[]>("list_console_sessions");
    setConsoleSessions(active);
    setActiveConsoleSessionId((current) => {
      if (current && active.some((session) => session.id === current)) return current;
      return active[0]?.id ?? "";
    });
  }

  async function loadCredentialStatus() {
    const status = await invokeCommand<CredentialStoreStatus>("credential_store_status");
    setCredentialStatus(status);
    if (status.unlocked) {
      const summaries = await invokeCommand<CredentialSummary[]>("list_credentials");
      setCredentials(summaries);
      setSelectedSshCredentialId((current) => current || selectDefaultCredentialId(summaries, status, "ssh"));
      setSelectedRdpCredentialId((current) => current || selectDefaultCredentialId(summaries, status, "rdp"));
    } else {
      setCredentials([]);
      setSelectedSshCredentialId("");
      setSelectedRdpCredentialId("");
    }
  }

  async function unlockCredentialStore() {
    try {
      const hadCredentialStore = Boolean(credentialStatus?.exists);
      const status = await invokeCommand<CredentialStoreStatus>("unlock_credentials", { passphrase: credentialPassphrase });
      const summaries = await invokeCommand<CredentialSummary[]>("list_credentials");
      setCredentialStatus(status);
      setCredentials(summaries);
      setSelectedSshCredentialId(selectDefaultCredentialId(summaries, status, "ssh"));
      setSelectedRdpCredentialId(selectDefaultCredentialId(summaries, status, "rdp"));
      setCredentialPassphrase("");
      setCredentialNotice(hadCredentialStore ? "Credentials unlocked." : "Credentials vault created.");
    } catch (error) {
      setCredentialNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function lockCredentialStore() {
    const status = await invokeCommand<CredentialStoreStatus>("lock_credentials");
    setCredentialStatus(status);
    setCredentials([]);
    setCredentialForm(clearCredentialFormSecrets());
    setSelectedSshCredentialId("");
    setSelectedRdpCredentialId("");
    setSshPrivateKeyContent("");
    setSshPassword("");
    setRdpPassword("");
    setCredentialNotice("Credentials locked.");
  }

  async function refreshCredentialSummaries() {
    const [status, summaries] = await Promise.all([
      invokeCommand<CredentialStoreStatus>("credential_store_status"),
      invokeCommand<CredentialSummary[]>("list_credentials"),
    ]);
    setCredentialStatus(status);
    setCredentials(summaries);
    setSelectedSshCredentialId((current) => current || selectDefaultCredentialId(summaries, status, "ssh"));
    setSelectedRdpCredentialId((current) => current || selectDefaultCredentialId(summaries, status, "rdp"));
  }

  function buildCredentialRequest(): UpsertCredentialRequest {
    return {
      id: credentialForm.id || null,
      label: credentialForm.label,
      kind: credentialForm.kind,
      username: credentialForm.username || null,
      password: credentialForm.password || null,
      domain: credentialForm.kind === "rdp" ? credentialForm.domain || null : null,
      sshAuthMode: credentialForm.kind === "ssh" ? credentialForm.sshAuthMode : null,
      sshKeyPath: credentialForm.kind === "ssh" && credentialForm.sshAuthMode === "privateKeyPath" ? credentialForm.sshKeyPath || null : null,
      sshPrivateKeyContent: credentialForm.kind === "ssh" && credentialForm.sshAuthMode === "privateKeyContent" ? credentialForm.sshPrivateKeyContent || null : null,
      rdpSecurityMode: credentialForm.kind === "rdp" ? credentialForm.rdpSecurityMode : null,
    };
  }

  async function saveCredential() {
    try {
      const summary = await invokeCommand<CredentialSummary>("upsert_credential", { request: buildCredentialRequest() });
      await refreshCredentialSummaries();
      setCredentialForm(emptyCredentialForm);
      setCredentialNotice(`Saved ${summary.label}.`);
    } catch (error) {
      setCredentialNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function editCredential(credentialId: string) {
    try {
      const credential = await invokeCommand<CredentialRecord>("get_credential", { credentialId });
      setCredentialForm({
        id: credential.id,
        label: credential.label,
        kind: credential.kind,
        username: credential.username || "",
        password: credential.password || "",
        domain: credential.domain || "",
        sshAuthMode: credential.sshAuthMode || "password",
        sshKeyPath: credential.sshKeyPath || "",
        sshPrivateKeyContent: credential.sshPrivateKeyContent || "",
        rdpSecurityMode: credential.rdpSecurityMode || "auto",
      });
      setCredentialNotice(`Editing ${credential.label}.`);
    } catch (error) {
      setCredentialNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function createConnectionCredential(kind: CredentialKind) {
    setCredentialForm({
      ...emptyCredentialForm,
      kind,
    });
    setCredentialNotice(`Creating ${credentialKindLabel(kind)} credential.`);
    setActiveView("credentials");
  }

  async function editConnectionCredential(credentialId: string) {
    if (!credentialId) return;
    await editCredential(credentialId);
    setActiveView("credentials");
  }

  async function deleteCredential(credentialId: string) {
    try {
      await invokeCommand("delete_credential", { credentialId });
      await refreshCredentialSummaries();
      setCredentialNotice("Credential deleted.");
    } catch (error) {
      setCredentialNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function setDefaultCredential(kind: CredentialKind, credentialId: string) {
    try {
      const status = await invokeCommand<CredentialStoreStatus>("set_default_credential", {
        kind,
        credentialId: credentialId || null,
      });
      setCredentialStatus(status);
      if (kind === "ssh") {
        setSelectedSshCredentialId(credentialId);
      } else {
        setSelectedRdpCredentialId(credentialId);
      }
      await refreshCredentialSummaries();
      setCredentialNotice(credentialId ? `Default ${credentialKindLabel(kind)} credential updated.` : `Default ${credentialKindLabel(kind)} credential cleared.`);
    } catch (error) {
      setCredentialNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function applyCredentialToConnection(kind: CredentialKind, credentialId: string) {
    if (kind === "ssh") {
      setSelectedSshCredentialId(credentialId);
      setSshPassword("");
      setSshPrivateKeyContent("");
      setSshKeyPath("");
    } else {
      setSelectedRdpCredentialId(credentialId);
      setRdpPassword("");
    }
    if (!credentialId) return;

    const credential = credentials.find((candidate) => candidate.id === credentialId);
    if (!credential || credential.kind !== kind) {
      setNotice("Selected credential is unavailable. Unlock credentials and try again.");
      return;
    }

    if (credential.kind === "ssh") {
      setSshUser(credential.username || "ec2-user");
    } else {
      setRdpUsername(credential.username || "");
      setRdpDomain(credential.domain || "");
      setRdpSecurityMode((credential.rdpSecurityMode as RdpSecurityMode | null) || "auto");
    }
  }

  async function checkEnvironment() {
    setNotice("Checking local tools...");
    const state = await invokeCommand<EnvironmentState>("check_environment");
    setEnvironment(state);
    await loadDiagnostics();
    setNotice(state.status === "ready" ? "Environment is ready." : "Environment needs attention.");
  }

  async function loadProfilesAndPreferences() {
    const [prefs, profiles] = await Promise.all([
      invokeCommand<UserPreferences>("load_preferences"),
      invokeCommand<AwsProfile[]>("list_profiles"),
    ]);
    const sanitizedPrefs = { ...prefs };
    delete (sanitizedPrefs as Record<string, unknown>).preferredTerminalPreset;
    delete (sanitizedPrefs as Record<string, unknown>).customTerminalCommand;

    const nextThemeMode = isThemeMode(prefs.themeMode) ? prefs.themeMode : "system";
    const nextSidebarWidth = typeof prefs.sidebarWidth === "number" ? clampSidebarWidth(prefs.sidebarWidth) : DEFAULT_SIDEBAR_WIDTH;
    const initialVisibleColumns = normalizeInitialInstanceTableVisibleColumns(prefs.instanceTableVisibleColumns);
    const nextVisibleColumns = initialVisibleColumns.columns;
    const nextColumnWidths = normalizeInstanceTableColumnWidths(prefs.instanceTableColumnWidths);
    const normalizedSavedProfiles = normalizeSavedProfiles(profiles, prefs.savedProfiles, prefs.lastProfile);
    const nextActiveProfile = resolveActiveProfile(normalizedSavedProfiles, prefs.activeProfile || prefs.lastProfile || "");

    storePreferences({
      ...sanitizedPrefs,
      themeMode: nextThemeMode,
      sidebarWidth: nextSidebarWidth,
      instanceTableVisibleColumns: nextVisibleColumns,
      instanceTableColumnWidths: nextColumnWidths,
      savedProfiles: normalizedSavedProfiles,
      activeProfile: nextActiveProfile || null,
    });

    setDiscoveredProfiles(profiles);
    setSavedProfiles(normalizedSavedProfiles);
    setActiveProfile(nextActiveProfile);
    setSshUser(prefs.defaultSshUser || "ec2-user");
    setSshKeyPath(prefs.sshKeyPath || "");
    setThemeMode(nextThemeMode);
    setSidebarWidth(nextSidebarWidth);
    setInstanceTableVisibleColumns(nextVisibleColumns);
    setInstanceTableColumnWidths(nextColumnWidths);
    setProfileStates((current) => buildInitialProfileStates(current, normalizedSavedProfiles, prefs));

    if (initialVisibleColumns.migrated) {
      await savePreferencesPatch({ instanceTableVisibleColumns: nextVisibleColumns });
    }
  }

  async function browseForSshKeyPath() {
    if (!isTauriRuntime()) {
      setNotice("SSH key browsing is available in the desktop app.");
      return;
    }

    try {
      const selectedPath = await openDialog({
        directory: false,
        multiple: false,
        title: "Choose an SSH key",
      });

      if (typeof selectedPath !== "string") {
        return;
      }

      setSshKeyPath(selectedPath);
      setSshPrivateKeyContent("");
      await savePreferencesPatch(buildConnectionPreferences({ sshKeyPath: selectedPath }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open the SSH key picker.");
    }
  }

  async function browseForCredentialSshKeyPath() {
    if (!isTauriRuntime()) {
      setCredentialNotice("SSH key browsing is available in the desktop app.");
      return;
    }

    try {
      const selectedPath = await openDialog({
        directory: false,
        multiple: false,
        title: "Choose an SSH key",
      });

      if (typeof selectedPath !== "string") {
        return;
      }

      setCredentialForm((current) => ({
        ...current,
        sshKeyPath: selectedPath,
      }));
    } catch (error) {
      setCredentialNotice(error instanceof Error ? error.message : "Could not open the SSH key picker.");
    }
  }

  async function validateSavedProfile(profileName: string, options?: { afterSso?: boolean }) {
    if (!profileName) return;
    const profileRegion = getProfileDefaultRegion(profileName);
    setIsBusy(true);
    updateProfileState(profileName, (current) => ({
      ...current,
      busy: "validating",
      authStatus: "unknown",
      ssoStarted: Boolean(options?.afterSso),
      ssoAttemptId: null,
      isAutoRevalidating: Boolean(options?.afterSso),
      identityAccount: null,
      validationMessage: "",
      capabilities: checkingCapabilities(),
    }));
    setNotice(options?.afterSso ? `AWS SSO login completed for ${profileName}. Re-validating...` : `Checking AWS caller identity for ${profileName}...`);

    try {
      const caller = await invokeCommand<CallerIdentity>("validate_profile", { profile: profileName });
      const report = await invokeCommand<ProfileCapabilityReport>("probe_profile_capabilities", {
        profile: profileName,
        region: profileRegion,
      });
      updateProfileState(profileName, (current) => ({
        ...current,
        busy: null,
        authStatus: "valid",
        ssoStarted: false,
        ssoAttemptId: null,
        isAutoRevalidating: false,
        identityAccount: caller.account,
        validationMessage: `Validated ${caller.account}.`,
        capabilities: report.capabilities,
      }));
      setNotice(`Profile valid for account ${caller.account}.`);
      if (!activeProfile) {
        await makeProfileActive(profileName);
      }
      await savePreferencesPatch({
        ...buildConnectionPreferences({
          activeProfile: activeProfile || profileName,
          lastProfile: activeProfile || profileName,
        }),
        profileValidationCache: {
          ...(preferencesRef.current.profileValidationCache ?? {}),
          [profileName]: {
            account: caller.account,
            message: `Validated ${caller.account}.`,
            validatedAt: new Date().toISOString(),
          },
        },
      });
      if (profileName === activeProfile) {
        resetInstanceContext();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextStatus = isSsoLoginError(message) ? "expired" : "error";
      updateProfileState(profileName, (current) => ({
        ...current,
        busy: null,
        authStatus: nextStatus,
        ssoStarted: false,
        ssoAttemptId: null,
        isAutoRevalidating: false,
        validationMessage: message,
        capabilities: defaultCapabilities(),
      }));
      const remainingCache = { ...(preferencesRef.current.profileValidationCache ?? {}) };
      delete remainingCache[profileName];
      await savePreferencesPatch({ profileValidationCache: remainingCache });
      setNotice(nextStatus === "expired" ? "AWS SSO sign-in is required for this profile." : "Profile validation failed.");
    } finally {
      setIsBusy(false);
      await loadDiagnostics();
    }
  }

  async function startSsoLogin(profileName: string) {
    if (!profileName) return;
    clearSsoPoll(profileName);
    setIsBusy(true);
    updateProfileState(profileName, (current) => ({
      ...current,
      busy: "sso",
      authStatus: "expired",
      ssoStarted: true,
      ssoAttemptId: null,
      isAutoRevalidating: false,
      validationMessage: "Waiting for AWS SSO browser sign-in to finish...",
    }));
    setNotice(`Opening AWS SSO login for ${profileName}...`);

    try {
      const attempt = await invokeCommand<SsoLoginAttempt>("start_sso_login", { profile: profileName });
      updateProfileState(profileName, (current) => ({
        ...current,
        busy: "sso",
        authStatus: "expired",
        ssoStarted: true,
        ssoAttemptId: attempt.id,
        validationMessage: attempt.message,
      }));
      setNotice("AWS SSO login started. The app will re-validate automatically once sign-in finishes.");
      scheduleSsoAttemptPoll(profileName, attempt.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateProfileState(profileName, (current) => ({
        ...current,
        busy: null,
        authStatus: "error",
        ssoStarted: false,
        ssoAttemptId: null,
        isAutoRevalidating: false,
        validationMessage: message,
      }));
      setNotice("Could not start AWS SSO login.");
    } finally {
      setIsBusy(false);
      await loadDiagnostics();
    }
  }

  function scheduleSsoAttemptPoll(profileName: string, attemptId: string, delayMs = 1400) {
    clearSsoPoll(profileName);
    ssoPollTimeoutsRef.current[profileName] = window.setTimeout(() => {
      void pollSsoLoginAttempt(profileName, attemptId);
    }, delayMs);
  }

  async function pollSsoLoginAttempt(profileName: string, attemptId: string) {
    if (!savedProfilesRef.current.includes(profileName)) {
      clearSsoPoll(profileName);
      return;
    }

    try {
      const attempt = await invokeCommand<SsoLoginAttempt>("get_sso_login_attempt", { attemptId });
      if (attempt.status === "starting" || attempt.status === "waiting") {
        updateProfileState(profileName, (current) => {
          if (current.ssoAttemptId && current.ssoAttemptId !== attemptId) {
            return current;
          }
          return {
            ...current,
            busy: "sso",
            authStatus: "expired",
            ssoStarted: true,
            ssoAttemptId: attempt.id,
            validationMessage: attempt.message,
          };
        });
        scheduleSsoAttemptPoll(profileName, attemptId);
        return;
      }

      clearSsoPoll(profileName);

      if (attempt.status === "succeeded") {
        updateProfileState(profileName, (current) => ({
          ...current,
          busy: "validating",
          authStatus: "unknown",
          ssoStarted: false,
          ssoAttemptId: null,
          isAutoRevalidating: true,
          validationMessage: attempt.message,
          capabilities: checkingCapabilities(),
        }));
        setNotice(`AWS SSO login completed for ${profileName}. Re-validating profile access...`);
        await validateSavedProfile(profileName, { afterSso: true });
        return;
      }

      updateProfileState(profileName, (current) => ({
        ...current,
        busy: null,
        authStatus: "expired",
        ssoStarted: false,
        ssoAttemptId: null,
        isAutoRevalidating: false,
        validationMessage: attempt.message,
      }));
      setNotice(`AWS SSO login did not complete for ${profileName}.`);
      await loadDiagnostics();
    } catch (error) {
      clearSsoPoll(profileName);
      const message = error instanceof Error ? error.message : String(error);
      updateProfileState(profileName, (current) => ({
        ...current,
        busy: null,
        authStatus: "error",
        ssoStarted: false,
        ssoAttemptId: null,
        isAutoRevalidating: false,
        validationMessage: message,
      }));
      setNotice(`Could not monitor AWS SSO login for ${profileName}.`);
      await loadDiagnostics();
    }
  }

  async function makeProfileActive(profileName: string) {
    setActiveProfile(profileName);
    resetInstanceContext();
    await savePreferencesPatch(buildConnectionPreferences({
      activeProfile: profileName || null,
      lastProfile: profileName || null,
    }));
  }

  async function addSavedProfile(profileName = profileToAdd) {
    const trimmedProfile = profileName.trim();
    if (!trimmedProfile || !addableProfiles.some((profile) => profile.name === trimmedProfile)) return;
    const nextSavedProfiles = [...savedProfiles, trimmedProfile];
    const nextActiveProfile = activeProfile || trimmedProfile;

    setSavedProfiles(nextSavedProfiles);
    setActiveProfile(nextActiveProfile);
    setProfileStates((current) => ({
      ...current,
      [trimmedProfile]: current[trimmedProfile] ?? createSavedProfileState(trimmedProfile),
    }));
    setProfileToAdd("");
    setIsAddProfileOpen(false);

    await savePreferencesPatch(buildConnectionPreferences({
      savedProfiles: nextSavedProfiles,
      activeProfile: nextActiveProfile || null,
      lastProfile: nextActiveProfile || null,
    }));
    setNotice(`Added ${trimmedProfile} to Initialize.`);
  }

  function handleInstanceColumnSort(columnId: InstanceTableColumnId) {
    setInstanceSort((current) => toggleInstanceTableSort(current, columnId));
  }

  async function removeSavedProfile(profileName: string) {
    clearSsoPoll(profileName);
    const nextSavedProfiles = savedProfiles.filter((savedProfile) => savedProfile !== profileName);
    const nextActiveProfile =
      activeProfile === profileName ? resolveActiveProfile(nextSavedProfiles, "") : activeProfile;

    setSavedProfiles(nextSavedProfiles);
    setActiveProfile(nextActiveProfile);
    removeProfileState(profileName);
    if (activeProfile === profileName) {
      resetInstanceContext();
    }

    await savePreferencesPatch(buildConnectionPreferences({
      savedProfiles: nextSavedProfiles,
      activeProfile: nextActiveProfile || null,
      lastProfile: nextActiveProfile || null,
    }));
    setNotice(`Removed ${profileName} from Initialize.`);
  }

  async function refreshInstances(
    source: "auto" | "manual" = "manual",
    selectionOverride?: {
      selectedInstanceIds: string[];
      primarySelectedInstanceId: string;
      anchorInstanceId: string;
    },
  ) {
    if (!activeProfileReady || !currentAwsContextKey || isInstancesLoading) return;
    const requestId = instancesRequestIdRef.current + 1;
    instancesRequestIdRef.current = requestId;
    setIsInstancesLoading(true);
    setNotice(source === "auto" ? "Loading instances from AWS..." : "Refreshing instances from AWS...");

    try {
      const refreshed = await invokeCommand<InstanceSummary[]>("get_ssm_readiness", {
        profile: activeProfile,
        region: activeProfileRegion,
        instanceIds: [],
      });
      if (instancesRequestIdRef.current !== requestId) return;
      setInstances(refreshed);
      const normalizedSelection = normalizeInstanceSelection(
        refreshed,
        selectionOverride?.selectedInstanceIds ?? selectedInstanceIds,
        selectionOverride?.primarySelectedInstanceId ?? selectedInstanceId,
        selectionOverride?.anchorInstanceId ?? selectionAnchorId,
      );
      setSelectedInstanceIds(normalizedSelection.selectedInstanceIds);
      setSelectedInstanceId(normalizedSelection.primarySelectedInstanceId);
      setSelectionAnchorId(normalizedSelection.anchorInstanceId);
      setLoadedInstanceContext(currentAwsContextKey);
      setAutoLoadAttemptedContext(currentAwsContextKey);
      setNotice(`Loaded ${refreshed.length} instances.`);
    } catch (error) {
      if (instancesRequestIdRef.current !== requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      if (isSsoLoginError(message)) {
        updateProfileState(activeProfile, (current) => ({
          ...current,
          authStatus: "expired",
          validationMessage: message,
        }));
        setNotice("AWS SSO sign-in is required before instances can load.");
      } else {
        setNotice(`Could not load instances: ${message}`);
      }
    } finally {
      if (instancesRequestIdRef.current === requestId) {
        setIsInstancesLoading(false);
      }
      await loadDiagnostics();
    }
  }

  async function runInstancePowerAction(action: "start" | "stop") {
    if (!activeProfileReady) return;
    const selection = action === "start" ? startSelection : stopSelection;
    if (selection.eligibleInstanceIds.length === 0) return;
    setIsPowerActionBusy(true);
    setNotice(`${action === "start" ? "Starting" : "Stopping"} ${selection.eligibleInstanceIds.length} selected instance(s)...`);

    try {
      const results = await invokeCommand<InstancePowerActionResult[]>(
        action === "start" ? "start_instances" : "stop_instances",
        {
          request: {
            profile: activeProfile,
            region: activeProfileRegion,
            instanceIds: selection.eligibleInstanceIds,
          },
        },
      );
      setNotice(
        results.length > 0
          ? `${action === "start" ? "Start" : "Stop"} requested for ${results.length} instance(s).`
          : `No instance state changes were returned for the current selection.`,
      );
      await refreshInstances("manual");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSsoLoginError(message)) {
        updateProfileState(activeProfile, (current) => ({
          ...current,
          authStatus: "expired",
          validationMessage: message,
        }));
      }
      setNotice(`Could not ${action} instance: ${message}`);
    } finally {
      setIsPowerActionBusy(false);
      await loadDiagnostics();
    }
  }

  async function runInstancePowerActionForInstance(action: "start" | "stop", instanceId: string) {
    if (!activeProfileReady || isPowerActionBusy) return;
    const targetInstance = instances.find((instance) => instance.instanceId === instanceId);
    if (!targetInstance) return;
    const isEligible = action === "start" ? targetInstance.state === "stopped" : targetInstance.state === "running";
    if (!isEligible) return;

    setInstanceContextMenu(null);
    setSelectedInstanceIds([instanceId]);
    setSelectedInstanceId(instanceId);
    setSelectionAnchorId(instanceId);
    setIsPowerActionBusy(true);
    setNotice(`${action === "start" ? "Starting" : "Stopping"} ${instanceId}...`);

    try {
      const results = await invokeCommand<InstancePowerActionResult[]>(
        action === "start" ? "start_instances" : "stop_instances",
        {
          request: {
            profile: activeProfile,
            region: activeProfileRegion,
            instanceIds: [instanceId],
          },
        },
      );
      setNotice(
        results.length > 0
          ? `${action === "start" ? "Start" : "Stop"} requested for ${instanceId}.`
          : `No instance state changes were returned for ${instanceId}.`,
      );
      await refreshInstances("manual", {
        selectedInstanceIds: [instanceId],
        primarySelectedInstanceId: instanceId,
        anchorInstanceId: instanceId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSsoLoginError(message)) {
        updateProfileState(activeProfile, (current) => ({
          ...current,
          authStatus: "expired",
          validationMessage: message,
        }));
      }
      setNotice(`Could not ${action} instance: ${message}`);
    } finally {
      setIsPowerActionBusy(false);
      await loadDiagnostics();
    }
  }

  function getInstanceActionsLocalPort(): number | null {
    return isInstancePortMappingEnabled && customLocalPort ? Number(customLocalPort) : null;
  }

  function openTunnelDialog(instanceId: string) {
    setTunnelInstanceId(instanceId);
    setTunnelRemotePort("");
    setTunnelRemoteHost("");
    setTunnelLocalPort("");
    setTunnelDialogError("");
    setIsTunnelDialogOpen(true);
  }

  function cancelTunnelDialog() {
    setIsTunnelDialogOpen(false);
    setTunnelDialogError("");
    setNotice("Tunnel start canceled.");
  }

  async function startPortForward() {
    const trimmedInstanceId = tunnelInstanceId.trim();
    if (!activeProfile || !activeProfileRegion || !trimmedInstanceId) return;

    const validation = validateTunnelForm({
      remotePort: tunnelRemotePort,
      remoteHost: tunnelRemoteHost,
      localPort: tunnelLocalPort,
    });
    if (!validation.ok) {
      setTunnelDialogError(validation.message);
      setNotice(validation.message);
      return;
    }

    setIsTunnelStarting(true);
    setTunnelDialogError("");
    try {
      const session = await invokeCommand<SessionRecord>(
        "start_port_forward",
        buildPortForwardInvokeArgs(
          {
            profile: activeProfile,
            region: activeProfileRegion,
            instanceId: trimmedInstanceId,
          },
          validation.value,
        ),
      );
      const tunnel = session.tunnel;
      const remoteTarget = `${tunnel?.remoteHost || "instance"}:${tunnel?.remotePort ?? validation.value.remotePort}`;
      setNotice(`Tunnel active on localhost:${tunnel?.localPort ?? "auto"} -> ${remoteTarget}.`);
      setIsTunnelDialogOpen(false);
      await loadSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSsoLoginError(message)) {
        updateProfileState(activeProfile, (current) => ({
          ...current,
          authStatus: "expired",
          validationMessage: message,
        }));
      }
      setTunnelDialogError(`Could not start tunnel: ${message}`);
      setNotice(`Could not start tunnel: ${message}`);
    } finally {
      setIsTunnelStarting(false);
      await loadDiagnostics();
    }
  }

  async function startConsoleSession(
    kind: ConsoleSessionKind,
    instanceId = selectedInstance?.instanceId ?? consoleInstanceId,
    localPortOverride?: number | null,
  ) {
    const trimmedInstanceId = instanceId.trim();
    if (!activeProfile || !activeProfileRegion || !trimmedInstanceId) return;
    const session = await invokeCommand<ConsoleSessionRecord>("start_console_session", {
      request: buildConsoleSessionRequest({
        kind,
        profile: activeProfile,
        region: activeProfileRegion,
        instanceId: trimmedInstanceId,
        localPort: kind === "shell"
          ? null
          : localPortOverride === undefined
            ? (customLocalPort ? Number(customLocalPort) : null)
            : localPortOverride,
        sshUser,
        sshPassword,
        sshKeyPath,
        sshPrivateKeyContent,
        sshCredentialId: selectedSshCredentialId,
        rdpUsername,
        rdpDomain,
        rdpPassword,
        rdpCredentialId: selectedRdpCredentialId,
        rdpSecurityMode,
        terminalCols: 100,
        terminalRows: 30,
        width: 1280,
        height: 720,
      }),
    });
    setConsoleSessions((current) => [session, ...current.filter((existing) => existing.id !== session.id)]);
    setActiveConsoleSessionId(session.id);
    setActiveView("console");
    setIsConsoleDialogOpen(false);
    setRdpPassword("");
    setNotice(
      session.status === "failed"
        ? session.message || "Console session could not start."
        : `${consoleKindLabel(kind)} console opened for ${trimmedInstanceId}.`,
    );
    await loadSessions();
    await loadDiagnostics();
  }

  async function stopConsoleSession(sessionId: string, options: { manual?: boolean } = {}) {
    if (options.manual) {
      manuallyClosingConsoleSessionIdsRef.current.add(sessionId);
    }
    await invokeCommand<ConsoleSessionRecord>("stop_console_session", { sessionId });
    setConsoleSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      if (activeConsoleSessionId === sessionId) {
        setActiveConsoleSessionId(next[0]?.id ?? "");
      }
      return next;
    });
    await loadSessions();
    await loadDiagnostics();
  }

  async function stopSession(sessionId: string) {
    await invokeCommand<SessionRecord>("stop_session", { sessionId });
    await loadSessions();
    await loadDiagnostics();
    setNotice("Session stopped.");
  }

  function startSidebarResize(event: ReactMouseEvent<HTMLDivElement>) {
    if (window.matchMedia("(max-width: 860px)").matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsResizingSidebar(true);

    function handleMouseMove(moveEvent: MouseEvent) {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    }

    function handleMouseUp(upEvent: MouseEvent) {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      setIsResizingSidebar(false);
      void persistSidebarWidth(startWidth + upEvent.clientX - startX);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = sidebarWidth - SIDEBAR_KEYBOARD_STEP;
    if (event.key === "ArrowRight") nextWidth = sidebarWidth + SIDEBAR_KEYBOARD_STEP;
    if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    void persistSidebarWidth(nextWidth);
  }

  function startInstanceColumnResize(event: ReactMouseEvent<HTMLSpanElement>, columnId: InstanceTableColumnId) {
    event.preventDefault();
    event.stopPropagation();
    const activeColumn = visibleInstanceTableColumns.find((column) => column.definition.id === columnId);
    if (!activeColumn) return;

    const startX = event.clientX;
    const startWidth = activeColumn.width;
    setIsResizingTableColumn(true);

    function handleMouseMove(moveEvent: MouseEvent) {
      updateInstanceTableColumnWidth(columnId, startWidth + moveEvent.clientX - startX);
    }

    function handleMouseUp(upEvent: MouseEvent) {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      setIsResizingTableColumn(false);
      void persistInstanceTableColumnWidths({
        ...instanceTableColumnWidths,
        [columnId]: startWidth + upEvent.clientX - startX,
      });
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function handleInstanceRowClick(event: ReactMouseEvent<HTMLElement>, instanceId: string) {
    const nextSelection = updateInstanceSelection({
      selectedInstanceIds,
      primarySelectedInstanceId: selectedInstanceId,
      anchorInstanceId: selectionAnchorId,
      orderedInstanceIds: visibleInstances.map((instance) => instance.instanceId),
      targetInstanceId: instanceId,
      toggleSelection: event.metaKey || event.ctrlKey,
      rangeSelection: event.shiftKey,
    });

    setSelectedInstanceIds(nextSelection.selectedInstanceIds);
    setSelectedInstanceId(nextSelection.primarySelectedInstanceId);
    setSelectionAnchorId(nextSelection.anchorInstanceId);
    const nextSelectionKey = buildInstanceActionsSelectionKey(nextSelection.primarySelectedInstanceId, nextSelection.selectedInstanceIds);
    if (nextSelectionKey !== selectedInstanceActionsKey) {
      setActiveInstanceActionsSelectionKey("");
    }
  }

  function handleInstanceDetailsToggle(event: ReactMouseEvent<HTMLButtonElement>, instanceId: string) {
    event.stopPropagation();
    setExpandedInstanceDetailId((current) => current === instanceId ? "" : instanceId);
  }

  function handleInstanceRowContextMenu(event: ReactMouseEvent<HTMLElement>, instanceId: string) {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 190));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 130));

    setSelectedInstanceIds([instanceId]);
    setSelectedInstanceId(instanceId);
    setSelectionAnchorId(instanceId);
    setExpandedInstanceDetailId((current) => current === instanceId ? current : "");
    if (buildInstanceActionsSelectionKey(instanceId, [instanceId]) !== selectedInstanceActionsKey) {
      setActiveInstanceActionsSelectionKey("");
    }
    setInstanceContextMenu({ instanceId, x, y });
  }

  function showInstanceActionsOverlay() {
    if (!selectedInstance || !selectedInstanceActionsKey) return;
    const defaultKind = defaultConnectionKindForInstance(selectedInstance);
    const defaultCredentialId = selectDefaultCredentialId(credentials, credentialStatus, defaultKind === "ssh" ? "ssh" : "rdp");
    setInstanceConnectionKind(defaultKind);
    setActiveInstanceActionsSelectionKey(selectedInstanceActionsKey);
    if (defaultCredentialId) {
      void applyCredentialToConnection(defaultKind === "ssh" ? "ssh" : "rdp", defaultCredentialId);
    }
  }

  function dismissInstanceActionsOverlay() {
    setActiveInstanceActionsSelectionKey("");
  }

  useEffect(() => {
    savedProfilesRef.current = savedProfiles;
  }, [savedProfiles]);

  useEffect(() => {
    activeConsoleSessionIdRef.current = activeConsoleSessionId;
  }, [activeConsoleSessionId]);

  useEffect(() => {
    if (instanceSort && !instanceTableVisibleColumns.includes(instanceSort.columnId)) {
      setInstanceSort(null);
    }
  }, [instanceSort, instanceTableVisibleColumns]);

  useEffect(() => {
    if (
      expandedInstanceDetailId
      && (
        !selectedInstanceIds.includes(expandedInstanceDetailId)
        || !visibleInstances.some((instance) => instance.instanceId === expandedInstanceDetailId)
      )
    ) {
      setExpandedInstanceDetailId("");
    }
  }, [expandedInstanceDetailId, selectedInstanceIds, visibleInstances]);

  useEffect(() => {
    if (!instanceContextMenu) return;

    function closeInstanceContextMenu() {
      setInstanceContextMenu(null);
    }

    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest(".instance-context-menu")) return;
      closeInstanceContextMenu();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeInstanceContextMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", closeInstanceContextMenu, true);
    window.addEventListener("resize", closeInstanceContextMenu);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", closeInstanceContextMenu, true);
      window.removeEventListener("resize", closeInstanceContextMenu);
    };
  }, [instanceContextMenu]);

  useEffect(() => {
    if (!shouldShowInstanceActionsOverlay) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismissInstanceActionsOverlay();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shouldShowInstanceActionsOverlay, selectedInstanceActionsKey]);

  useEffect(() => {
    if (activeView !== "instances" && instanceContextMenu) {
      setInstanceContextMenu(null);
    }
  }, [activeView, instanceContextMenu]);

  useEffect(() => {
    if (activeView !== "home") {
      setIsHomeAsciiArmed(false);
      return;
    }

    setIsHomeAsciiArmed(false);
    let secondFrameId = 0;
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        setIsHomeAsciiArmed(true);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrameId);
      if (secondFrameId) {
        window.cancelAnimationFrame(secondFrameId);
      }
    };
  }, [activeView]);

  useEffect(() => {
    if (instanceContextMenu && !instances.some((instance) => instance.instanceId === instanceContextMenu.instanceId)) {
      setInstanceContextMenu(null);
    }
  }, [instanceContextMenu, instances]);

  useEffect(() => {
    return () => {
      clearAllSsoPolls();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme() {
      const nextTheme = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
      setResolvedTheme(nextTheme);
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
    }

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode]);

  useEffect(() => {
    if (previewConfig.designVariant === "default") {
      delete document.documentElement.dataset.designVariant;
      return;
    }

    document.documentElement.dataset.designVariant = previewConfig.designVariant;
    return () => {
      delete document.documentElement.dataset.designVariant;
    };
  }, [previewConfig.designVariant]);

  useEffect(() => {
    void (async () => {
      try {
        await checkEnvironment();
        await loadProfilesAndPreferences();
        await loadCredentialStatus();
        await loadSessions();
        await loadConsoleSessions();
        await loadDiagnostics();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  useEffect(() => {
    if (isTauriRuntime() || !previewConfig.demoMode) return;
    const previewProfile = "demo-profile";
    setSavedProfiles([previewProfile]);
    setActiveProfile(previewProfile);
    setProfileStates({
      [previewProfile]: {
        profileName: previewProfile,
        authStatus: "valid",
        busy: null,
        ssoStarted: false,
        ssoAttemptId: null,
        isAutoRevalidating: false,
        identityAccount: "demo-account",
        validationMessage: "Preview environment ready.",
        capabilities: [
          {
            id: "auth",
            label: "Authenticated identity",
            status: "available",
            message: "Demo identity verified.",
            account: "demo-account",
          },
          {
            id: "regions",
            label: "Region discovery",
            status: "available",
            message: "3 region(s) available.",
            regions: ["us-west-2", "us-east-1", "eu-west-1"],
          },
          {
            id: "ec2",
            label: "EC2 discovery",
            status: "available",
            message: "4 EC2 instance(s) visible in us-west-2.",
            regionName: "us-west-2",
            visibleInstanceCount: 4,
          },
          {
            id: "ssm",
            label: "SSM managed nodes",
            status: "available",
            message: "4 SSM managed node(s) visible in us-west-2.",
            regionName: "us-west-2",
            managedNodeCount: 4,
          },
        ],
      },
    });
    setNotice("Loaded browser preview scene for design capture.");
    setActiveView(previewConfig.initialView);
  }, [previewConfig.demoMode, previewConfig.initialView]);

  useEffect(() => {
    if (!activeProfileRegion) {
      resetInstanceContext();
    }
  }, [activeProfileRegion]);

  useEffect(() => {
    if (activeProfile && !activeProfileRegion) {
      setNotice(`Profile ${activeProfile} has no configured AWS region. Add one in ~/.aws/config before using instances or console sessions.`);
    }
  }, [activeProfile, activeProfileRegion]);

  useEffect(() => {
    if (isInitializationGatedView(activeView) && !activeProfileReady) {
      setActiveView("initialize");
    }
  }, [activeProfileReady, activeView]);

  useEffect(() => {
    if (activeView !== "credentials") {
      setCredentialForm(clearCredentialFormSecrets());
    }
  }, [activeView]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | null = null;
    void listen<ConsoleSessionEndedEvent>("console-session-ended", (event) => {
      const endedSession = event.payload;
      if (!shouldAutoCloseEndedConsoleSession(endedSession, manuallyClosingConsoleSessionIdsRef.current)) {
        return;
      }

      void (async () => {
        try {
          await dialogMessage(endedSession.message, {
            kind: "info",
            title: "SSH disconnected",
          });
        } catch {
          window.alert(endedSession.message);
        }

        try {
          await invokeCommand<ConsoleSessionRecord>("stop_console_session", { sessionId: endedSession.sessionId });
        } catch {
          // The session may already be gone if the user closed it while the dialog was open.
        }

        setConsoleSessions((current) => {
          const next = current.filter((session) => session.id !== endedSession.sessionId);
          if (activeConsoleSessionIdRef.current === endedSession.sessionId) {
            const nextActiveSessionId = next[0]?.id ?? "";
            activeConsoleSessionIdRef.current = nextActiveSessionId;
            setActiveConsoleSessionId(nextActiveSessionId);
          }
          return next;
        });
        await loadSessions();
        await loadDiagnostics();
      })();
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (activeView !== "instances" || !activeProfileReady || isInstancesLoading || !currentAwsContextKey) return;
    if (loadedInstanceContext === currentAwsContextKey || autoLoadAttemptedContext === currentAwsContextKey) return;
    setAutoLoadAttemptedContext(currentAwsContextKey);
    void refreshInstances("auto");
  }, [activeView, activeProfileReady, autoLoadAttemptedContext, currentAwsContextKey, isInstancesLoading, loadedInstanceContext]);

  useEffect(() => {
    if (!isColumnMenuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (columnMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setIsColumnMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsColumnMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isColumnMenuOpen]);

  return (
    <div
      className={`app-shell ${isMenuSelectionRetained ? "app-shell--resource-focused" : ""} ${isResizingSidebar || isResizingTableColumn ? "app-shell--resizing" : ""}`.trim()}
      style={appShellStyle}
    >
      <aside className="sidebar" aria-label="Primary navigation">
        <nav className="side-nav" aria-label="Workspace sections">
          {navItems.map((item) => {
            const isDisabled = isInitializationGatedView(item.view) && !activeProfileReady;
            return (
              <button
                aria-current={activeView === item.view ? "page" : undefined}
                className={`${activeView === item.view ? "active" : ""} ${isDisabled ? "side-nav__button--disabled" : ""}`.trim()}
                disabled={isDisabled}
                key={item.view}
                onClick={() => setActiveView(item.view)}
                title={isDisabled ? "Validate an active AWS profile in Initialize to open this section." : undefined}
                type="button"
              >
                <NavIcon view={item.view} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <section className="theme-dock" aria-label="Theme">
          <button
            aria-label={themeMode === "system" ? `Using system ${resolvedTheme} theme` : `Switch to ${themeMode === "dark" ? "light" : "dark"} theme`}
            className="theme-icon-button"
            disabled={themeMode === "system"}
            onClick={() => void toggleManualTheme()}
            type="button"
          >
            {resolvedTheme === "dark" ? <MoonIcon /> : <SunIcon />}
          </button>
          <span>{themeMode === "system" ? `${resolvedTheme} by system` : `${themeMode} mode`}</span>
          <label className="system-theme-toggle">
            <input
              checked={themeMode === "system"}
              onChange={(event) => void setSystemThemePreference(event.target.checked)}
              type="checkbox"
            />
            System (Auto)
          </label>
        </section>

        <div
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className="sidebar-resize-handle"
          onKeyDown={handleSidebarResizeKeyDown}
          onMouseDown={startSidebarResize}
          role="separator"
          tabIndex={0}
        />
      </aside>

      <main className="app-main">

        {activeView === "home" && (
          <section className="view view--home-brand" aria-labelledby="home-title">
            <h2 className="visually-hidden" id="home-title">SSM Commander</h2>
            <div className={`ascii-banner ${isHomeAsciiArmed ? "ascii-banner--armed" : ""}`.trim()} aria-label="SSM Commander">
              {SSM_COMMANDER_ASCII.map((line, index) => (
                <pre key={line} style={{ "--line-index": index } as CSSProperties}>{line}</pre>
              ))}
            </div>
          </section>
        )}

        {activeView === "initialize" && (
          <section className="view view--initialize" aria-labelledby="initialize-title">
            <header className="topbar">
              <div>
                <p className="eyebrow">Initialize</p>
                <h2 id="initialize-title">Profiles and environment</h2>
              </div>
            </header>

            {shouldShowHomeNotice && (
              <div
                className={`notice notice--compact ${
                  savedProfiles.some((profileName) => getProfileState(profileName).authStatus === "error") ? "notice--error" : ""
                } ${
                  savedProfiles.some((profileName) => getProfileState(profileName).authStatus === "expired") ? "notice--warning" : ""
                }`}
              >
                {notice}
              </div>
            )}

            <section className="panel environment-panel environment-panel--initialize">
              <div className="section-heading">
                <h2>Environment</h2>
                <button className="button-secondary environment-panel__check-button" onClick={() => void checkEnvironment()} type="button">
                  Check
                </button>
              </div>
              <StatusPill label={environment?.status ?? "unchecked"} tone={environment?.status === "ready" ? "good" : "warn"} />
              <div className="check-list">
                {environment?.checks.map((check) => {
                  const detail = formatDependencyDetail(check);
                  const showInstallHelp = check.status === "missing" && Boolean(check.remediation || check.installUrl);

                  return (
                    <div className="check-row" key={check.name}>
                      <div className="check-row__details">
                        <strong>{check.name}</strong>
                        <div className="check-row__secondary">
                          <span className="check-row__message">{detail}</span>
                          {showInstallHelp && (
                            <HelpTooltip align="end" label={`Installation help for ${check.name}`}>
                              <div className="tooltip__body">
                                {check.remediation && <p>{check.remediation}</p>}
                                {check.installUrl && (
                                  <button className="tooltip__link" onClick={() => void openInstallGuide(check.installUrl!)} type="button">
                                    {check.installLabel || "View instructions"}
                                  </button>
                                )}
                              </div>
                            </HelpTooltip>
                          )}
                        </div>
                      </div>
                      <StatusPill label={check.status} tone={dependencyTone(check)} />
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="profile-panel" aria-label="AWS profiles">
              <div className="profile-panel__header">
                <div className="profile-panel__title">
                  <div>
                    <h2>AWS profiles</h2>
                  </div>
                  {hasSavedProfiles && (
                    <div className="profile-panel__add-row">
                      <button
                        aria-expanded={isAddProfileOpen}
                        className="profile-panel__add-button"
                        onClick={() => setIsAddProfileOpen((current) => !current)}
                        type="button"
                      >
                        <PlusIcon />
                        <span>Add additional profile...</span>
                      </button>
                      <HelpTooltip label="How saved profiles work">
                        <div className="tooltip__body">
                          <p>{SAVED_PROFILE_WORKSPACE_HELP}</p>
                        </div>
                      </HelpTooltip>
                    </div>
                  )}
                </div>
                <div className={`validation-state ${hasSavedProfiles ? "" : "validation-state--empty"}`.trim()}>
                  {hasSavedProfiles && <StatusPill label={activeProfile ? "saved" : "empty"} tone={activeProfile ? "good" : "neutral"} />}
                  <p>
                    {hasSavedProfiles
                      ? "Pin the AWS CLI profiles you use most often, validate them on demand, and keep one active profile for console and instance access."
                      : "No profile selected."}
                  </p>
                </div>
              </div>

              <div className="profile-fields">
                <div className="field-group">
                  <span className="field-group__label profile-fields__label-row">
                    <span>Region</span>
                    <HelpTooltip label="How the active profile region is used">
                      <div className="tooltip__body">
                        <p>
                          {activeProfileRegion
                            ? "The active profile region powers instance discovery, EC2 start/stop, and SSM-based connections."
                            : "Add a region to this AWS CLI profile in ~/.aws/config before using instances or console sessions."}
                        </p>
                      </div>
                    </HelpTooltip>
                  </span>
                  <div className={`profile-fields__value ${activeProfileRegion ? "" : "profile-fields__value--warning"}`.trim()}>
                    {activeProfileRegion || "No region configured in this AWS profile"}
                  </div>
                </div>
              </div>

              {isAddProfileOpen && hasSavedProfiles && renderProfilePicker("Add profile")}

              {!hasSavedProfiles ? (
                <div className="empty-home-state">
                  <h3>No profile selected</h3>
                  <div className="empty-home-state__selector">
                    <div className="empty-home-state__selector-row">
                      <button
                        aria-expanded={isAddProfileOpen}
                        className={`profile-panel__add-button profile-panel__add-button--empty profile-panel__selector-button ${
                          isAddProfileOpen ? "profile-panel__selector-button--open" : ""
                        }`.trim()}
                        onClick={() => setIsAddProfileOpen((current) => !current)}
                        type="button"
                      >
                        <span>Select a profile</span>
                        <ChevronDownIcon />
                      </button>
                      <HelpTooltip label="How saved profiles work">
                        <div className="tooltip__body">
                          <p>{EMPTY_STATE_PROFILE_HELP}</p>
                        </div>
                      </HelpTooltip>
                    </div>
                    <p
                      className={`empty-home-state__availability ${
                        discoveredProfiles.length > 0 ? "" : "empty-home-state__availability--muted"
                      }`.trim()}
                    >
                      {discoveredProfiles.length > 0
                        ? `${discoveredProfiles.length} discovered profile(s) available to add.`
                        : "No AWS CLI profiles were discovered yet."}
                    </p>
                    {isAddProfileOpen && (
                      addableProfiles.length > 0 ? (
                        <div className="empty-home-state__profile-list" role="list" aria-label="Profiles available to add">
                          {addableProfiles.map((profile) => (
                            <div className="empty-home-state__profile-row" key={profile.name} role="listitem">
                              <div className="empty-home-state__profile-copy">
                                <strong>{profile.name}</strong>
                                {profile.defaultRegion ? (
                                  <span>{profile.defaultRegion}</span>
                                ) : (
                                  <span>No default region in profile</span>
                                )}
                              </div>
                              <button
                                className="button-secondary"
                                onClick={() => void addSavedProfile(profile.name)}
                                type="button"
                              >
                                Add
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="empty-home-state__empty-list">No additional profiles are available to add.</p>
                      )
                    )}
                  </div>
                </div>
              ) : (
                <div className="profile-card-grid">
                  {savedProfiles.map((profileName) => {
                    const profileState = getProfileState(profileName);
                    const isActive = activeProfile === profileName;
                    const detailsExpanded = expandedProfileDetails[profileName] ?? shouldAutoExpandProfileDetails(profileState);
                    const overviewItems = buildProfileOverview(profileState);
                    const authCapability = getProfileCapability(profileState, "auth");
                    const regionsCapability = getProfileCapability(profileState, "regions");
                    const ec2Capability = getProfileCapability(profileState, "ec2");
                    const ssmCapability = getProfileCapability(profileState, "ssm");
                    const regionChipSummary = summarizeRegionChips(regionsCapability?.regions);

                    return (
                      <section className="profile-card" key={profileName}>
                        <button
                          aria-label={`Remove ${profileName}`}
                          className="profile-card__remove"
                          onClick={() => void removeSavedProfile(profileName)}
                          type="button"
                        >
                          <CloseIcon />
                        </button>
                        <div className="profile-card__header">
                          <div>
                            <h3>{profileName}</h3>
                          </div>
                          <div className="profile-card__badges">
                            {isActive && <StatusPill label="active" tone="good" />}
                          </div>
                        </div>

                        <div className={`validation-state validation-state--${profileStateClass(profileState)}`}>
                          <StatusPill label={buildProfileStatusLabel(profileState)} tone={authTone(profileState)} />
                          <p>{buildProfileStatusMessage(profileState)}</p>
                        </div>

                        {overviewItems.length > 0 && (
                          <div className="profile-card__overview">
                            {overviewItems.map((item) => (
                              <span className="profile-card__overview-item" key={`${profileName}-${item}`}>{item}</span>
                            ))}
                          </div>
                        )}

                        <div className="profile-card__actions">
                          {(profileState.authStatus === "expired" || profileState.busy === "sso" || Boolean(profileState.ssoAttemptId)) ? (
                            <button className="button-secondary" disabled={isBusy || profileState.busy === "validating" || profileState.busy === "sso"} onClick={() => void startSsoLogin(profileName)}>
                              {profileState.busy === "sso" ? "Waiting for SSO..." : "Sign in"}
                            </button>
                          ) : (
                            <button className="button-primary" disabled={isBusy || profileState.busy !== null} onClick={() => void validateSavedProfile(profileName)}>
                              {profileState.busy === "validating" ? "Validating..." : profileState.authStatus === "valid" ? "Revalidate" : "Validate"}
                            </button>
                          )}
                          {!isActive && <button onClick={() => void makeProfileActive(profileName)}>Make active</button>}
                          <button className="button-ghost" onClick={() => setExpandedProfileDetails((current) => ({ ...current, [profileName]: !detailsExpanded }))} type="button">
                            {detailsExpanded ? "Hide details" : "Details"}
                          </button>
                        </div>

                        {detailsExpanded && (
                          <div className="profile-capabilities">
                            <div className="profile-capability profile-capability--compact">
                              <div className="profile-capability__heading">
                                <div className="profile-capability__title">
                                  <span className={`profile-capability__indicator profile-capability__indicator--${authCapability?.status ?? "unknown"}`} title={capabilityIndicatorTitle(authCapability?.status ?? "unknown")} />
                                  <span>{authCapability?.label ?? "Authenticated identity"}</span>
                                </div>
                              </div>
                              {!authCapability?.account && <p>{authCapability?.message ?? "Not checked yet."}</p>}
                            </div>

                            <div className="profile-capability profile-capability--compact">
                              <div className="profile-capability__heading">
                                <div className="profile-capability__title">
                                  <span className={`profile-capability__indicator profile-capability__indicator--${regionsCapability?.status ?? "unknown"}`} title={capabilityIndicatorTitle(regionsCapability?.status ?? "unknown")} />
                                  <span>{regionsCapability?.label ?? "Region discovery"}</span>
                                </div>
                              </div>
                              {regionChipSummary.visibleRegions.length > 0 ? (
                                <div className="profile-capability__chips">
                                  {regionChipSummary.visibleRegions.map((region) => (
                                    <span className="profile-capability__chip" key={`${profileName}-${region}`}>{region}</span>
                                  ))}
                                  {regionChipSummary.hiddenCount > 0 && (
                                    <span className="profile-capability__chip profile-capability__chip--muted">+{regionChipSummary.hiddenCount} more</span>
                                  )}
                                </div>
                              ) : (
                                <p>{regionsCapability?.message ?? "Not checked yet."}</p>
                              )}
                            </div>

                            <div className="profile-capability profile-capability--compact">
                              <div className="profile-capability__heading">
                                <div className="profile-capability__title">
                                  <span className={`profile-capability__indicator profile-capability__indicator--${ec2Capability?.status ?? "unknown"}`} title={capabilityIndicatorTitle(ec2Capability?.status ?? "unknown")} />
                                  <span>{ec2Capability?.label ?? "EC2 discovery"}</span>
                                </div>
                              </div>
                              <p>
                                {typeof ec2Capability?.visibleInstanceCount === "number" && ec2Capability.regionName
                                  ? `${ec2Capability.visibleInstanceCount} instance(s) visible in ${ec2Capability.regionName}.`
                                  : ec2Capability?.message ?? "Not checked yet."}
                              </p>
                            </div>

                            <div className="profile-capability profile-capability--compact">
                              <div className="profile-capability__heading">
                                <div className="profile-capability__title">
                                  <span className={`profile-capability__indicator profile-capability__indicator--${ssmCapability?.status ?? "unknown"}`} title={capabilityIndicatorTitle(ssmCapability?.status ?? "unknown")} />
                                  <span>{ssmCapability?.label ?? "SSM managed nodes"}</span>
                                </div>
                              </div>
                              <p>
                                {typeof ssmCapability?.managedNodeCount === "number" && ssmCapability.regionName
                                  ? `${ssmCapability.managedNodeCount} managed node(s) visible in ${ssmCapability.regionName}.`
                                  : ssmCapability?.message ?? "Not checked yet."}
                              </p>
                            </div>
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="panel readiness-panel" aria-label="Readiness summary">
              <div className={`readiness-item readiness-item--${environmentReadinessState}`}>
                <span>Environment</span>
                <StatusPill label={environment?.status ?? "unchecked"} tone={environment?.status === "ready" ? "good" : "warn"} />
              </div>
              <div className={`readiness-item readiness-item--${activeProfileReadinessState}`}>
                <span>Active profile</span>
                <strong className="readiness-item__value readiness-item__value--profile">{activeProfile || "None"}</strong>
              </div>
              <div className={`readiness-item readiness-item--${instancesReadinessState}`}>
                <span>Instances</span>
                <strong>{instances.length}</strong>
              </div>
              <div className={`readiness-item readiness-item--${sessionsReadinessState}`}>
                <span>SSM Activity</span>
                <strong>{sessions.length}</strong>
              </div>
            </section>
          </section>
        )}

        {activeView === "credentials" && (
          <section className="view view--credentials" aria-labelledby="credentials-title">
            <header className="topbar">
              <div>
                <p className="eyebrow">Credentials</p>
                <h2 id="credentials-title">Connection credentials</h2>
              </div>
              {credentialStatus?.unlocked && (
                <button className="button-ghost" onClick={() => void lockCredentialStore()} type="button">
                  Lock
                </button>
              )}
            </header>

            {credentialNotice && (
              <div className={`notice notice--compact ${credentialNotice.toLowerCase().includes("could not") || credentialNotice.toLowerCase().includes("required") ? "notice--error" : ""}`}>
                {credentialNotice}
              </div>
            )}

            {!credentialStatus?.unlocked ? (
              <section className="panel credential-unlock-panel" aria-label="Unlock credentials">
                <div className="section-heading">
                  <h2>{credentialStatus?.exists ? "Unlock credentials" : "Create credentials vault"}</h2>
                  <StatusPill label={credentialStatus?.exists ? "locked" : "new"} tone="warn" />
                </div>
                <label>
                  Master passphrase
                  <input
                    {...technicalInputProps}
                    onChange={(event) => setCredentialPassphrase(event.target.value)}
                    type="password"
                    value={credentialPassphrase}
                  />
                </label>
                <div className="button-row">
                  <button className="button-primary" onClick={() => void unlockCredentialStore()} type="button">
                    {credentialStatus?.exists ? "Unlock" : "Create vault"}
                  </button>
                </div>
              </section>
            ) : (
              <div className="credentials-layout">
                <section className="panel credential-editor" aria-label="Credential editor">
                  <div className="section-heading">
                    <h2>{credentialForm.id ? "Edit credential" : "New credential"}</h2>
                    {credentialForm.id && (
                      <button className="button-ghost" onClick={() => setCredentialForm(emptyCredentialForm)} type="button">
                        New
                      </button>
                    )}
                  </div>
                  <label>
                    Label
                    <input
                      onChange={(event) => setCredentialForm((current) => ({ ...current, label: event.target.value }))}
                      value={credentialForm.label}
                    />
                  </label>
                  <label>
                    Type
                    <select
                      onChange={(event) => setCredentialForm((current) => ({ ...current, kind: event.target.value as CredentialKind }))}
                      value={credentialForm.kind}
                    >
                      <option value="ssh">SSH</option>
                      <option value="rdp">RDP</option>
                    </select>
                  </label>
                  <label>
                    Username
                    <input
                      {...technicalInputProps}
                      onChange={(event) => setCredentialForm((current) => ({ ...current, username: event.target.value }))}
                      value={credentialForm.username}
                    />
                  </label>

                  {credentialForm.kind === "ssh" ? (
                    <>
                      <label>
                        SSH auth
                        <select
                          onChange={(event) => setCredentialForm((current) => ({ ...current, sshAuthMode: event.target.value as SshAuthMode }))}
                          value={credentialForm.sshAuthMode}
                        >
                          <option value="password">Password</option>
                          <option value="privateKeyPath">Private key path</option>
                          <option value="privateKeyContent">Pasted private key</option>
                        </select>
                      </label>
                      {credentialForm.sshAuthMode === "password" && (
                        <label>
                          SSH password
                          <input
                            {...technicalInputProps}
                            onChange={(event) => setCredentialForm((current) => ({ ...current, password: event.target.value }))}
                            type="password"
                            value={credentialForm.password}
                          />
                        </label>
                      )}
                      {credentialForm.sshAuthMode === "privateKeyPath" && (
                        <div className="field-group">
                          <span className="field-group__label">SSH key path</span>
                          <div className="path-input-row">
                            <input
                              {...technicalInputProps}
                              onChange={(event) => setCredentialForm((current) => ({ ...current, sshKeyPath: event.target.value }))}
                              value={credentialForm.sshKeyPath}
                            />
                            <button onClick={() => void browseForCredentialSshKeyPath()} type="button">Browse</button>
                          </div>
                        </div>
                      )}
                      {credentialForm.sshAuthMode === "privateKeyContent" && (
                        <label>
                          SSH private key
                          <textarea
                            onChange={(event) => setCredentialForm((current) => ({ ...current, sshPrivateKeyContent: event.target.value }))}
                            value={credentialForm.sshPrivateKeyContent}
                          />
                        </label>
                      )}
                    </>
                  ) : (
                    <>
                      <label>
                        Domain
                        <input
                          {...technicalInputProps}
                          onChange={(event) => setCredentialForm((current) => ({ ...current, domain: event.target.value }))}
                          value={credentialForm.domain}
                        />
                      </label>
                      <label>
                        RDP password
                        <input
                          {...technicalInputProps}
                          onChange={(event) => setCredentialForm((current) => ({ ...current, password: event.target.value }))}
                          type="password"
                          value={credentialForm.password}
                        />
                      </label>
                      <label>
                        RDP security
                        <select
                          onChange={(event) => setCredentialForm((current) => ({ ...current, rdpSecurityMode: event.target.value as RdpSecurityMode }))}
                          value={credentialForm.rdpSecurityMode}
                        >
                          {RDP_SECURITY_MODE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <div className="button-row">
                    <button className="button-primary" onClick={() => void saveCredential()} type="button">Save credential</button>
                  </div>
                </section>

                <section className="panel credential-list-panel" aria-label="Saved credentials">
                  <div className="section-heading">
                    <h2>Saved credentials</h2>
                    <StatusPill label={`${credentials.length}`} tone={credentials.length > 0 ? "good" : "neutral"} />
                  </div>
                  {credentials.length === 0 ? (
                    <p className="muted">No credentials saved yet.</p>
                  ) : (
                    <div className="credential-list">
                      {credentials.map((credential) => (
                        <div className="credential-row" key={credential.id}>
                          <div>
                            <strong>{credential.label}</strong>
                            <span>{credentialKindLabel(credential.kind)}{credential.username ? ` - ${credential.username}` : ""}</span>
                          </div>
                          <StatusPill label={credential.isDefault ? "default" : credential.kind} tone={credential.isDefault ? "good" : "neutral"} />
                          <button onClick={() => void editCredential(credential.id)} type="button">Edit</button>
                          <button onClick={() => void setDefaultCredential(credential.kind, credential.isDefault ? "" : credential.id)} type="button">
                            {credential.isDefault ? "Clear default" : "Make default"}
                          </button>
                          <button className="button-ghost" onClick={() => void deleteCredential(credential.id)} type="button">Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </section>
        )}

        {activeView === "instances" && (
          <section className="view view--instances resource-workspace" aria-labelledby="instances-title">
            <section className="resource-pane resource-pane--browser" aria-label="Instances browser">
              <header className="resource-pane__header">
                <div>
                  <h2 id="instances-title">Instances</h2>
                  <p>{visibleInstances.length} shown · {instances.length} total</p>
                </div>
                <button
                  aria-label="Refresh instances from AWS"
                  className="button-secondary icon-button glass-icon-button"
                  disabled={!activeProfileReady || isInstancesLoading}
                  onClick={() => void refreshInstances("manual")}
                  title="Refresh instances from AWS"
                  type="button"
                >
                  <RefreshIcon />
                  <span className="visually-hidden">Refresh instances from AWS</span>
                </button>
              </header>

              <div className="resource-pane__tools">
                <input onChange={(event) => setQuery(event.target.value)} placeholder="Search name, id, tag, IP, VPC..." value={query} />
                <button
                  className="button-ghost resource-sort-button"
                  onClick={() => handleInstanceColumnSort("name")}
                  type="button"
                >
                  <SortIcon direction={instanceSort?.columnId === "name" ? instanceSort.direction : "none"} />
                  <span>Name</span>
                </button>
              </div>

              <div className={instancesNoticeClassName}>
                {notice}
              </div>

              <div className="resource-list" aria-busy={isInstancesLoading} role="listbox" aria-label="Instances">
                {showInstancesRefreshing && (
                  <div className="resource-list__loading">
                    <LoadingIndicator label="Loading instances from AWS..." />
                  </div>
                )}
                {showInitialInstancesLoader && (
                  <div className="resource-empty resource-empty--loading">
                    <LoadingIndicator label="Loading instances from AWS..." />
                  </div>
                )}
                {!showInitialInstancesLoader && visibleInstances.map((instance) => {
                  const isSelected = selectedInstanceIdSet.has(instance.instanceId);
                  const isPrimary = instance.instanceId === selectedInstanceId;
                  const platformLabel = instance.platform || "Unknown";
                  const isRunning = instance.state.toLowerCase() === "running";

                  return (
                    <button
                      aria-selected={isSelected}
                      className={`resource-row ${isSelected ? "resource-row--selected" : ""} ${isPrimary ? "resource-row--primary" : ""}`.trim()}
                      key={instance.instanceId}
                      onClick={(event) => handleInstanceRowClick(event, instance.instanceId)}
                      onContextMenu={(event) => handleInstanceRowContextMenu(event, instance.instanceId)}
                      role="option"
                      type="button"
                    >
                      <span className={`resource-row__icon ${isRunning ? "resource-row__icon--running" : "resource-row__icon--stopped"}`}>
                        <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                          <rect height="6" rx="1.5" width="14" x="5" y="5" />
                          <rect height="6" rx="1.5" width="14" x="5" y="13" />
                          <path d="M8 8h.01M8 16h.01M12 8h4M12 16h4" />
                        </svg>
                      </span>
                      <span className="resource-row__copy">
                        <strong>{instance.name || instance.instanceId}</strong>
                        <span>{instance.instanceId}</span>
                      </span>
                      <span className="resource-row__meta">
                        <StatusPill label={instance.state} tone={isRunning ? "good" : instance.state === "stopped" ? "neutral" : "warn"} />
                        <span>{platformLabel}</span>
                        <span>{instance.privateIp || "No private IP"}</span>
                      </span>
                    </button>
                  );
                })}
                {!showInitialInstancesLoader && visibleInstances.length === 0 && (
                  <div className="resource-empty">
                    <strong>No instances found</strong>
                    <span>{query ? "Adjust the search query or refresh AWS." : "Refresh AWS to load resources."}</span>
                  </div>
                )}
              </div>
            </section>

            <aside className="resource-pane resource-pane--inspector" aria-label="Instance actions and configuration">
              {selectedInstance ? (
                <>
                  <header className="inspector-hero">
                    <div className={`inspector-hero__icon ${selectedInstance.state === "running" ? "inspector-hero__icon--running" : ""}`}>
                      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                        <rect height="6" rx="1.5" width="14" x="5" y="5" />
                        <rect height="6" rx="1.5" width="14" x="5" y="13" />
                        <path d="M8 8h.01M8 16h.01M12 8h4M12 16h4" />
                      </svg>
                    </div>
                    <div>
                      <h2>{selectedInstance.name || selectedInstance.instanceId}</h2>
                      <p>{selectedInstance.instanceId}</p>
                    </div>
                  </header>

                  <section className="inspector-section inspector-section--power">
                    <h3>Power</h3>
                    {selectedInstanceIds.length > 1 && <p className="muted">{selectedInstanceIds.length} selected</p>}
                    <div className="action-stack action-stack--inline">
                      <button
                        className="button-primary"
                        disabled={!activeProfileReady || isPowerActionBusy || startSelection.eligibleInstanceIds.length === 0}
                        onClick={() => void runInstancePowerAction("start")}
                        title={!activeProfileReady ? "Validate the active profile first." : startSelection.eligibleInstanceIds.length === 0 ? "No selected instances can be started." : undefined}
                      >
                        {isPowerActionBusy ? "Working..." : selectedInstanceIds.length > 1 ? `Start (${startSelection.eligibleInstanceIds.length})` : "Start"}
                      </button>
                      <button
                        disabled={!activeProfileReady || isPowerActionBusy || stopSelection.eligibleInstanceIds.length === 0}
                        onClick={() => void runInstancePowerAction("stop")}
                        title={!activeProfileReady ? "Validate the active profile first." : stopSelection.eligibleInstanceIds.length === 0 ? "No selected instances can be stopped." : undefined}
                      >
                        {isPowerActionBusy ? "Working..." : selectedInstanceIds.length > 1 ? `Stop (${stopSelection.eligibleInstanceIds.length})` : "Stop"}
                      </button>
                    </div>
                  </section>

                  <div className="inspector-card detail-stack">
                    <div><span>Name</span><strong>{selectedInstance.name || "Unnamed"}</strong></div>
                    <div><span>Profile</span><strong>{activeProfile || "Not selected"}</strong></div>
                    <div><span>Region</span><strong>{activeProfileRegion || "No region"}</strong></div>
                    <div><span>SSM</span><StatusPill label={selectedInstance.ssmStatus} tone={ssmTone(selectedInstance.ssmStatus)} /></div>
                    <div><span>Private IP</span><strong>{selectedInstance.privateIp || "No private IP"}</strong></div>
                    {selectedInstance.publicIp && <div><span>Public IP</span><strong>{selectedInstance.publicIp}</strong></div>}
                    {selectedInstance.vpcId && <div><span>VPC</span><strong>{selectedInstance.vpcId}</strong></div>}
                    {selectedInstance.subnetId && <div><span>Subnet</span><strong>{selectedInstance.subnetId}</strong></div>}
                  </div>

                  {selectedInstance.tags.length > 0 && (
                    <details className="inspector-section inspector-section--tags" key={`tags-${selectedInstance.instanceId}`}>
                      <summary>
                        <span>Tags</span>
                        <span>{selectedInstance.tags.length}</span>
                      </summary>
                      <div className="inspector-table">
                        {selectedInstance.tags.slice(0, 5).map((tag) => (
                          <div key={`${selectedInstance.instanceId}-${tag.key}`}>
                            <span>{tag.key}</span>
                            <strong>{tag.value}</strong>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <section className="inspector-section connection-actions">
                    <h3>Connection</h3>
                    {selectedInstance.state !== "running" ? (
                      <p className="resource-offline">Resource offline</p>
                    ) : (
                      <>
                        <div className="segmented-control segmented-control--connection" role="group" aria-label="Connection type">
                          <button className={instanceConnectionKind === "rdp" ? "active" : ""} onClick={() => setInstanceConnectionKind("rdp")} type="button">RDP</button>
                          <button className={instanceConnectionKind === "ssh" ? "active" : ""} onClick={() => setInstanceConnectionKind("ssh")} type="button">SSH</button>
                          <button className={instanceConnectionKind === "shell" ? "active" : ""} onClick={() => setInstanceConnectionKind("shell")} type="button">Shell</button>
                        </div>

                        {instanceCredentialKind && (
                          credentialStatus?.unlocked ? (
                            <div className="connection-credential-control">
                              <label>
                                Saved credential
                                <select onChange={(event) => void applyCredentialToConnection(instanceCredentialKind, event.target.value)} value={selectedInstanceCredentialId}>
                                  <option value="">Manual entry</option>
                                  {instanceCredentialOptions.map((credential) => (
                                    <option key={credential.id} value={credential.id}>
                                      {credential.isDefault ? `${credential.label} (default)` : credential.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <button
                                aria-label={`Create ${credentialKindLabel(instanceCredentialKind)} credential`}
                                className="button-secondary connection-credential-control__add"
                                onClick={() => createConnectionCredential(instanceCredentialKind)}
                                title={`Create ${credentialKindLabel(instanceCredentialKind)} credential`}
                                type="button"
                              >
                                +
                              </button>
                              <button
                                className="button-secondary connection-credential-control__edit"
                                disabled={!selectedInstanceCredentialId}
                                onClick={() => void editConnectionCredential(selectedInstanceCredentialId)}
                                type="button"
                              >
                                Edit selected credential
                              </button>
                            </div>
                          ) : (
                            <button className="button-secondary" onClick={() => createConnectionCredential(instanceCredentialKind)} type="button">
                              Create {credentialKindLabel(instanceCredentialKind)} credential
                            </button>
                          )
                        )}

                        {instanceConnectionKind === "ssh" && (
                          <>
                            <label>
                              SSH user
                              <input {...technicalInputProps} onChange={(event) => setSshUser(event.target.value)} value={sshUser} />
                            </label>
                            <label>
                              SSH password
                              <input {...technicalInputProps} onChange={(event) => setSshPassword(event.target.value)} placeholder="Optional" type="password" value={sshPassword} />
                            </label>
                            <div className="field-group">
                              <span className="field-group__label">SSH key path</span>
                              <div className="path-input-row">
                                <input {...technicalInputProps} onChange={(event) => {
                                  setSshKeyPath(event.target.value);
                                  setSshPrivateKeyContent("");
                                }} placeholder="Optional" value={sshKeyPath} />
                                <button onClick={() => void browseForSshKeyPath()} type="button">Browse</button>
                              </div>
                            </div>
                          </>
                        )}

                        {instanceConnectionKind === "rdp" && (
                          <>
                            <label>
                              RDP username
                              <input {...technicalInputProps} onChange={(event) => setRdpUsername(event.target.value)} placeholder="Optional" value={rdpUsername} />
                            </label>
                            <label>
                              RDP domain
                              <input {...technicalInputProps} onChange={(event) => setRdpDomain(event.target.value)} placeholder="Optional" value={rdpDomain} />
                            </label>
                            <label>
                              RDP password
                              <input {...technicalInputProps} onChange={(event) => setRdpPassword(event.target.value)} placeholder="Kept in memory only" type="password" value={rdpPassword} />
                            </label>
                            <label>
                              RDP security
                              <select {...technicalInputProps} onChange={(event) => setRdpSecurityMode(event.target.value as RdpSecurityMode)} value={rdpSecurityMode}>
                                {RDP_SECURITY_MODE_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                            </label>
                          </>
                        )}

                        {instanceConnectionKind !== "shell" && (
                          <>
                            <label className="instance-port-toggle">
                              <input checked={isInstancePortMappingEnabled} onChange={(event) => setIsInstancePortMappingEnabled(event.target.checked)} type="checkbox" />
                              <span>User-defined port mapping</span>
                            </label>
                            {isInstancePortMappingEnabled && (
                              <label>
                                Local port
                                <input {...technicalInputProps} onChange={(event) => setCustomLocalPort(event.target.value)} placeholder="49152" value={customLocalPort} />
                              </label>
                            )}
                          </>
                        )}

                        <div className="action-stack connection-actions__buttons">
                          <button
                            className="button-primary"
                            disabled={!canConnectToInstance}
                            onClick={() => void startConsoleSession(instanceConnectionKind, selectedInstance.instanceId, getInstanceActionsLocalPort())}
                            title={connectionDisabledTitle}
                            type="button"
                          >
                            {consoleOpenLabel(instanceConnectionKind)}
                          </button>
                          <button disabled={!canConnectToInstance} onClick={() => openTunnelDialog(selectedInstance.instanceId)} title={connectionDisabledTitle} type="button">
                            Start Tunnel
                          </button>
                        </div>
                      </>
                    )}
                  </section>
                </>
              ) : (
                <div className="inspector-empty">
                  <h2>Select an instance</h2>
                  <p>Choose a resource in the middle pane to view details, actions, and connection settings.</p>
                </div>
              )}
            </aside>

            {contextMenuInstance && instanceContextMenu && (
              <div
                aria-label={`Instance actions for ${contextMenuInstance.instanceId}`}
                className="instance-context-menu"
                role="menu"
                style={{ left: instanceContextMenu.x, top: instanceContextMenu.y }}
              >
                <div className="instance-context-menu__heading">
                  <strong>{contextMenuInstance.name || contextMenuInstance.instanceId}</strong>
                  {contextMenuInstance.name && <code>{contextMenuInstance.instanceId}</code>}
                </div>
                <button disabled={!activeProfileReady || isPowerActionBusy || contextMenuInstance.state !== "stopped"} onClick={() => void runInstancePowerActionForInstance("start", contextMenuInstance.instanceId)} role="menuitem" type="button">
                  <PlusIcon />
                  <span>Start</span>
                </button>
                <button disabled={!activeProfileReady || isPowerActionBusy || contextMenuInstance.state !== "running"} onClick={() => void runInstancePowerActionForInstance("stop", contextMenuInstance.instanceId)} role="menuitem" type="button">
                  <CloseIcon />
                  <span>Stop</span>
                </button>
              </div>
            )}
          </section>
        )}

        {isTunnelDialogOpen && (
          <div className="console-dialog tunnel-dialog" role="dialog" aria-modal="true" aria-labelledby="tunnel-dialog-title">
            <form
              className="console-dialog__panel tunnel-dialog__panel"
              onSubmit={(event) => {
                event.preventDefault();
                void startPortForward();
              }}
            >
              <div className="section-heading">
                <div>
                  <h2 id="tunnel-dialog-title">Start tunnel</h2>
                  <p className="muted">Instance <code>{tunnelInstanceId}</code></p>
                </div>
                <button className="button-ghost icon-button" disabled={isTunnelStarting} onClick={cancelTunnelDialog} type="button">
                  <CloseIcon />
                </button>
              </div>
              {tunnelDialogError && <div className="notice notice--compact notice--error">{tunnelDialogError}</div>}
              <label>
                Remote port
                <input
                  {...technicalInputProps}
                  autoFocus
                  inputMode="numeric"
                  onChange={(event) => setTunnelRemotePort(event.target.value)}
                  placeholder="3389"
                  value={tunnelRemotePort}
                />
              </label>
              <label>
                Remote host
                <input
                  {...technicalInputProps}
                  onChange={(event) => setTunnelRemoteHost(event.target.value)}
                  placeholder="Leave blank to use the instance"
                  value={tunnelRemoteHost}
                />
              </label>
              <label>
                Local port
                <input
                  {...technicalInputProps}
                  inputMode="numeric"
                  onChange={(event) => setTunnelLocalPort(event.target.value)}
                  placeholder="Auto"
                  value={tunnelLocalPort}
                />
              </label>
              <div className="button-row">
                <button className="button-ghost" disabled={isTunnelStarting} onClick={cancelTunnelDialog} type="button">Cancel</button>
                <button className="button-primary" disabled={isTunnelStarting} type="submit">
                  {isTunnelStarting ? "Starting..." : "Start Tunnel"}
                </button>
              </div>
            </form>
          </div>
        )}

        {(activeView === "console" || consoleSessions.length > 0) && (
          <section
            aria-label="Console"
            aria-hidden={activeView !== "console"}
            className={`view view--console ${activeView !== "console" ? "view--background-console" : ""}`.trim()}
          >
            <div className="console-tabs" role="tablist" aria-label="Console sessions">
              {consoleSessions.map((session) => (
                <button
                  aria-selected={activeConsoleSession?.id === session.id}
                  className={`console-tab ${activeConsoleSession?.id === session.id ? "console-tab--active" : ""}`.trim()}
                  key={session.id}
                  onClick={() => setActiveConsoleSessionId(session.id)}
                  role="tab"
                  type="button"
                >
                  <span>{session.title}</span>
                  <StatusPill label={session.status} tone={session.status === "active" ? "good" : session.status === "failed" ? "bad" : "warn"} />
                  <span
                    aria-label={`Close ${session.title}`}
                    className="console-tab__close"
                    onClick={(event) => {
                      event.stopPropagation();
                      void stopConsoleSession(session.id, { manual: true });
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <CloseIcon />
                  </span>
                </button>
              ))}
              <button
                aria-label="Add console tab"
                className="console-tabs__add"
                onClick={() => {
                  setConsoleInstanceId(selectedInstance?.state === "running" ? selectedInstance.instanceId : "");
                  setIsConsoleDialogOpen(true);
                }}
                title="Add console tab"
                type="button"
              >
                <PlusIcon />
              </button>
            </div>

            {isConsoleDialogOpen && (
              <div className="console-dialog" role="dialog" aria-modal="true" aria-labelledby="console-dialog-title">
                <div className="console-dialog__panel">
                  <div className="section-heading">
                    <h2 id="console-dialog-title">New console tab</h2>
                    <button className="button-ghost icon-button" onClick={() => setIsConsoleDialogOpen(false)} type="button">
                      <CloseIcon />
                    </button>
                  </div>
                  <div className="segmented-control" role="group" aria-label="Console type">
                    <button
                      className={consoleSessionKind === "shell" ? "active" : ""}
                      onClick={() => setConsoleSessionKind("shell")}
                      type="button"
                    >
                      Direct SSM (Shell)
                    </button>
                    <button
                      className={consoleSessionKind === "ssh" ? "active" : ""}
                      onClick={() => setConsoleSessionKind("ssh")}
                      type="button"
                    >
                      SSH
                    </button>
                    <button
                      className={consoleSessionKind === "rdp" ? "active" : ""}
                      onClick={() => setConsoleSessionKind("rdp")}
                      type="button"
                    >
                      RDP
                    </button>
                  </div>
                  <label>
                    Instance ID
                    <input
                      {...technicalInputProps}
                      onChange={(event) => setConsoleInstanceId(event.target.value)}
                      placeholder="i-..."
                      value={consoleInstanceId}
                    />
                  </label>
                  {runningInstances.length > 0 && (
                    <label>
                      Select instance
                      <select onChange={(event) => setConsoleInstanceId(event.target.value)} value={consoleInstanceId}>
                        <option value="">Choose an instance</option>
                        {runningInstances.map((instance) => (
                          <option key={instance.instanceId} value={instance.instanceId}>
                            {instance.name ? `${instance.name} - ${instance.instanceId}` : instance.instanceId}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {consoleSessionKind === "ssh" ? (
                    <>
                      <label>
                        SSH user
                        <input {...technicalInputProps} onChange={(event) => setSshUser(event.target.value)} value={sshUser} />
                      </label>
                      <label>
                        SSH password
                        <input {...technicalInputProps} onChange={(event) => setSshPassword(event.target.value)} placeholder="Optional" type="password" value={sshPassword} />
                      </label>
                      <div className="field-group">
                        <span className="field-group__label">SSH key path</span>
                        <div className="path-input-row">
                          <input {...technicalInputProps} onChange={(event) => setSshKeyPath(event.target.value)} placeholder="Optional" value={sshKeyPath} />
                          <button onClick={() => void browseForSshKeyPath()} type="button">Browse</button>
                        </div>
                      </div>
                    </>
                  ) : consoleSessionKind === "rdp" ? (
                    <>
                      <label>
                        RDP username
                        <input {...technicalInputProps} onChange={(event) => setRdpUsername(event.target.value)} placeholder="Optional" value={rdpUsername} />
                      </label>
                      <label>
                        RDP domain
                        <input {...technicalInputProps} onChange={(event) => setRdpDomain(event.target.value)} placeholder="Optional" value={rdpDomain} />
                      </label>
                      <label>
                        RDP password
                        <input {...technicalInputProps} onChange={(event) => setRdpPassword(event.target.value)} placeholder="Kept in memory only" type="password" value={rdpPassword} />
                      </label>
                      <label>
                        RDP security
                        <select {...technicalInputProps} onChange={(event) => setRdpSecurityMode(event.target.value as RdpSecurityMode)} value={rdpSecurityMode}>
                          {RDP_SECURITY_MODE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : (
                    null
                  )}
                  {consoleSessionKind !== "shell" && (
                    <label>
                      Local port
                      <input {...technicalInputProps} onChange={(event) => setCustomLocalPort(event.target.value)} placeholder="Auto" value={customLocalPort} />
                    </label>
                  )}
                  <div className="button-row">
                    <button className="button-ghost" onClick={() => setIsConsoleDialogOpen(false)} type="button">Cancel</button>
                    <button
                      className="button-primary"
                      disabled={!canOpenConsoleDialog}
                      onClick={() => void startConsoleSession(consoleSessionKind, consoleInstanceId)}
                      title={consoleDialogDisabledTitle}
                      type="button"
                    >
                      {consoleOpenLabel(consoleSessionKind)}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeConsoleSession && (
              <section className="console-workspace" role="tabpanel">
                {activeConsoleSession.renderer === "xterm" ? (
                  <XtermConsole session={activeConsoleSession} />
                ) : (
                  <GuacamoleConsole isVisible={activeView === "console"} session={activeConsoleSession} />
                )}
              </section>
            )}
          </section>
        )}

        {activeView === "activity" && (
          <section className="view" aria-labelledby="activity-title">
            <header className="topbar">
              <div>
                <p className="eyebrow">SSM Activity</p>
                <h2 id="activity-title">Active SSM activity</h2>
              </div>
              <button onClick={() => void loadSessions()}>Refresh</button>
            </header>

            <div className={`notice ${activeProfileState?.authStatus === "error" ? "notice--error" : ""} ${activeProfileState?.authStatus === "expired" ? "notice--warning" : ""}`}>
              {notice}
            </div>

            <section className="panel session-panel">
              <div className="session-list">
                {sessions.map((session) => (
                  <div className="session-row" key={session.id}>
                    <div>
                      <strong>{session.kind.toUpperCase()} - {session.instanceId}</strong>
                      <span>{session.tunnel ? `localhost:${session.tunnel.localPort} -> ${session.tunnel.remoteHost || "instance"}:${session.tunnel.remotePort}` : session.note}</span>
                    </div>
                    <StatusPill label={session.status} tone={session.status === "active" ? "good" : "warn"} />
                    <button onClick={() => void stopSession(session.id)}>Stop</button>
                  </div>
                ))}
                {sessions.length === 0 && <p className="muted">No active SSM activity.</p>}
              </div>
            </section>
          </section>
        )}

        {activeView === "logs" && (
          <section className="view" aria-labelledby="logs-title">
            <header className="topbar">
              <div>
                <p className="eyebrow">Logs</p>
                <h2 id="logs-title">Logs</h2>
              </div>
              <div className="logs-actions">
                <span>{logsCopyStatus || `Showing ${Math.min(diagnostics.length, 80)} of ${diagnostics.length}`}</span>
                <button
                  aria-label="Copy logs to clipboard"
                  className="button-secondary icon-button glass-icon-button"
                  disabled={diagnostics.length === 0}
                  onClick={() => void copyDiagnostics()}
                  title="Copy logs to clipboard"
                  type="button"
                >
                  <CopyIcon />
                  <span className="visually-hidden">Copy logs</span>
                </button>
                <button onClick={() => void loadDiagnostics()}>Refresh</button>
              </div>
            </header>

            <section className="panel logs-panel">
              <div className="diagnostics">
                {diagnostics.slice(0, 80).map((event) => (
                  <div className={`diagnostic diagnostic--${event.severity}`} key={event.id}>
                    <span>{new Date(event.timestamp).toLocaleTimeString()} - {event.area}</span>
                    <p>{event.message}</p>
                  </div>
                ))}
                {diagnostics.length === 0 && <p className="muted">No logs yet.</p>}
              </div>
            </section>
          </section>
        )}
      </main>
    </div>
  );
}

function XtermConsole({ session }: { session: ConsoleSessionRecord }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#0d1117",
        foreground: "#d6deeb",
        cursor: "#7aa7ff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;

    const resize = () => {
      fitAddon.fit();
      const { cols, rows } = terminal;
      if (isTauriRuntime()) {
        void invokeCommand("resize_console_terminal", { sessionId: session.id, cols, rows });
      }
    };

    const inputDisposable = terminal.onData((data) => {
      if (isTauriRuntime()) {
        void invokeCommand("write_console_input", { sessionId: session.id, data });
      } else {
        terminal.write(data);
      }
    });

    let unlisten: (() => void) | null = null;
    if (isTauriRuntime()) {
      void listen<ConsoleOutputEvent>("console-output", (event) => {
        if (event.payload.sessionId === session.id) {
          terminal.write(event.payload.data);
        }
      }).then((cleanup) => {
        unlisten = cleanup;
      });
    } else {
      terminal.writeln("SSM Commander preview console");
      terminal.writeln(`Connected to ${session.instanceId}`);
      terminal.write("$ ");
    }

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.requestAnimationFrame(resize);

    return () => {
      observer.disconnect();
      inputDisposable.dispose();
      unlisten?.();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [session.id, session.instanceId]);

  return <div className="xterm-console" ref={containerRef} />;
}

function recordRdpFrontendDiagnostic(session: ConsoleSessionRecord, message: string) {
  void invokeCommand<void>("record_frontend_diagnostic", {
    area: "launcher",
    message: `Embedded RDP frontend: sessionId=${session.id}, instanceId=${session.instanceId}, ${message}`,
  }).catch(() => {});
}

function guacamoleStateName(states: Record<string, number> | undefined, state: number): string {
  const match = Object.entries(states ?? {}).find(([, value]) => value === state);
  return match ? `${match[0]}(${state})` : `${state}`;
}

function sampleCanvasPixels(canvas: HTMLCanvasElement): string {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return "empty";
  }

  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return "no-context";
    }

    const sampleColumns = Math.min(8, canvas.width);
    const sampleRows = Math.min(8, canvas.height);
    let samples = 0;
    let nonTransparent = 0;
    let nonBlack = 0;
    let nonDark = 0;
    let luminanceTotal = 0;
    let maxLuminance = 0;
    for (let row = 0; row < sampleRows; row += 1) {
      const y = Math.min(canvas.height - 1, Math.floor((row * canvas.height) / sampleRows));
      for (let column = 0; column < sampleColumns; column += 1) {
        const x = Math.min(canvas.width - 1, Math.floor((column * canvas.width) / sampleColumns));
        const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
        const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
        samples += 1;
        luminanceTotal += luminance;
        maxLuminance = Math.max(maxLuminance, luminance);
        if (alpha > 0) {
          nonTransparent += 1;
        }
        if (alpha > 0 && (red > 8 || green > 8 || blue > 8)) {
          nonBlack += 1;
        }
        if (alpha > 0 && luminance > 48) {
          nonDark += 1;
        }
      }
    }
    const avgLuminance = samples > 0 ? Math.round(luminanceTotal / samples) : 0;

    return `nonBlack=${nonBlack}/${samples},nonDark=${nonDark}/${samples},avgLum=${avgLuminance},maxLum=${maxLuminance},nonTransparent=${nonTransparent}/${samples}`;
  } catch (error) {
    return `sampleError=${error instanceof Error ? error.message : String(error)}`;
  }
}

function sampleGuacamoleDisplay(guacDisplay: {
  flatten: () => HTMLCanvasElement;
}): string {
  try {
    const canvas = guacDisplay.flatten();
    return `${canvas.width}x${canvas.height}:${sampleCanvasPixels(canvas)}`;
  } catch (error) {
    return `sampleError=${error instanceof Error ? error.message : String(error)}`;
  }
}

function GuacamoleConsole({ isVisible, session }: { isVisible: boolean; session: ConsoleSessionRecord }) {
  const displayRef = useRef<HTMLDivElement | null>(null);
  const isVisibleRef = useRef(isVisible);
  const scheduleDisplaySizeRef = useRef<() => void>(() => {});
  const [error, setError] = useState("");

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      scheduleDisplaySizeRef.current();
    }
  }, [isVisible]);

  useEffect(() => {
    const display = displayRef.current;
    if (!display || !session.bridgeUrl || !session.connectionToken) {
      return;
    }

    display.replaceChildren();
    setError("");
    const tunnel = new Guacamole.WebSocketTunnel(session.bridgeUrl);
    const client = new Guacamole.Client(tunnel);
    const guacDisplay = client.getDisplay();
    const element = guacDisplay.getElement();
    element.classList.add("guacamole-console__display-element");
    display.appendChild(element);
    let lastSize = "";
    let lastScale = 1;
    let resizeFrame = 0;
    let tunnelStateLogs = 0;
    let clientStateLogs = 0;
    let syncDiagnostics = 0;
    const diagnosticTimers: number[] = [];
    const recordDiagnostic = (message: string) => {
      recordRdpFrontendDiagnostic(session, message);
    };
    const applyDisplayScale = () => {
      const remoteWidth = Math.max(1, Number(guacDisplay.getWidth?.() ?? 0));
      const remoteHeight = Math.max(1, Number(guacDisplay.getHeight?.() ?? 0));
      const containerWidth = Math.max(1, display.clientWidth);
      const containerHeight = Math.max(1, display.clientHeight);
      if (remoteWidth <= 1 || remoteHeight <= 1) {
        return;
      }
      const nextScale = Math.min(containerWidth / remoteWidth, containerHeight / remoteHeight);
      const clampedScale = Math.min(3, Math.max(0.1, Number.isFinite(nextScale) ? nextScale : 1));
      if (Math.abs(clampedScale - lastScale) < 0.005) {
        return;
      }
      guacDisplay.scale(clampedScale);
      lastScale = clampedScale;
    };
    const describeDisplay = (reason: string) => {
      applyDisplayScale();
      const containerRect = display.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const canvases = Array.from(element.querySelectorAll("canvas") as NodeListOf<HTMLCanvasElement>);
      const canvasSummary =
        canvases
          .map((canvas, index) => `#${index}:${canvas.width}x${canvas.height}:${sampleCanvasPixels(canvas)}`)
          .join(",") || "none";
      const compositeSummary = sampleGuacamoleDisplay(guacDisplay);
      recordDiagnostic(
        `displaySample reason=${reason}, visible=${isVisibleRef.current}, scale=${lastScale.toFixed(3)}, container=${display.clientWidth}x${display.clientHeight}, containerRect=${Math.round(containerRect.width)}x${Math.round(containerRect.height)}, displayElement=${Math.round(elementRect.width)}x${Math.round(elementRect.height)}, childCount=${element.childElementCount}, composite=${compositeSummary}, canvases=${canvases.length} ${canvasSummary}`,
      );
    };
    const scheduleDiagnostic = (reason: string, delayMs: number) => {
      const timer = window.setTimeout(() => describeDisplay(reason), delayMs);
      diagnosticTimers.push(timer);
    };
    const sendDisplaySize = () => {
      resizeFrame = 0;
      if (!isVisibleRef.current) {
        return;
      }
      const width = Math.max(1, Math.floor(display.clientWidth));
      const height = Math.max(1, Math.floor(display.clientHeight));
      const nextSize = `${width}x${height}`;
      if (nextSize === lastSize) {
        applyDisplayScale();
        return;
      }
      lastSize = nextSize;
      applyDisplayScale();
      client.sendSize(width, height);
    };
    const scheduleDisplaySize = () => {
      if (resizeFrame) {
        return;
      }
      resizeFrame = window.requestAnimationFrame(sendDisplaySize);
    };
    scheduleDisplaySizeRef.current = scheduleDisplaySize;
    const resizeObserver = new ResizeObserver(() => {
      applyDisplayScale();
      scheduleDisplaySize();
    });
    resizeObserver.observe(display);
    window.addEventListener("resize", scheduleDisplaySize);
    guacDisplay.onresize = (width: number, height: number) => {
      applyDisplayScale();
      scheduleDiagnostic(`display-resize-${width}x${height}`, 0);
    };

    tunnel.onerror = (status: { message?: string }) => {
      recordDiagnostic(`tunnelError=${status.message || "unknown"}`);
      setError(status.message || "RDP tunnel disconnected.");
    };
    client.onerror = (status: { message?: string }) => {
      recordDiagnostic(`clientError=${status.message || "unknown"}`);
      setError(status.message || "RDP console disconnected.");
    };
    tunnel.onstatechange = (state: number) => {
      if (tunnelStateLogs < 8) {
        tunnelStateLogs += 1;
        recordDiagnostic(`tunnelState=${guacamoleStateName(Guacamole.Tunnel.State, state)}`);
      }
      if (state === Guacamole.Tunnel.State.OPEN) {
        lastSize = "";
        scheduleDisplaySize();
        scheduleDiagnostic("tunnel-open", 250);
      }
    };
    client.onstatechange = (state: number) => {
      if (clientStateLogs < 8) {
        clientStateLogs += 1;
        recordDiagnostic(`clientState=${guacamoleStateName(Guacamole.Client.State, state)}`);
      }
      if (state === Guacamole.Client.State.CONNECTED) {
        scheduleDiagnostic("client-connected", 250);
      }
    };
    client.onsync = (timestamp: number, frames: number) => {
      if (syncDiagnostics >= 3) {
        return;
      }
      syncDiagnostics += 1;
      scheduleDiagnostic(`sync-${syncDiagnostics}-timestamp-${timestamp}-frames-${frames}`, 0);
    };
    client.connect(`token=${encodeURIComponent(session.connectionToken)}`);
    scheduleDisplaySize();
    scheduleDiagnostic("after-connect", 1_000);
    scheduleDiagnostic("after-connect-3s", 3_000);
    scheduleDiagnostic("after-connect-10s", 10_000);

    const mouse = new Guacamole.Mouse(element);
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState: unknown) => {
      client.sendMouseState(mouseState, true);
    };
    const keyboard = new Guacamole.Keyboard(document);
    keyboard.onkeydown = (keysym: number) => {
      client.sendKeyEvent(1, keysym);
    };
    keyboard.onkeyup = (keysym: number) => {
      client.sendKeyEvent(0, keysym);
    };

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleDisplaySize);
      diagnosticTimers.forEach((timer) => window.clearTimeout(timer));
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      keyboard.onkeydown = null;
      keyboard.onkeyup = null;
      client.onsync = null;
      guacDisplay.onresize = null;
      client.onstatechange = null;
      client.onerror = null;
      tunnel.onstatechange = null;
      tunnel.onerror = null;
      client.disconnect();
      scheduleDisplaySizeRef.current = () => {};
      display.replaceChildren();
    };
  }, [session.bridgeUrl, session.connectionToken, session.id, session.instanceId]);

  if (!session.bridgeUrl || !session.connectionToken) {
    return (
      <div className="console-placeholder">
        <strong>Embedded RDP is not ready.</strong>
        <span>{session.message || "Install or bundle guacd to use the embedded RDP renderer."}</span>
      </div>
    );
  }

  return (
    <div className="guacamole-console">
      <div className="guacamole-console__display" ref={displayRef} />
      {error && <div className="guacamole-console__status">{error}</div>}
    </div>
  );
}

function buildInitialProfileStates(
  current: ProfileStateMap,
  savedProfiles: string[],
  prefs: UserPreferences,
): ProfileStateMap {
  const next: ProfileStateMap = {};
  for (const profileName of savedProfiles) {
    next[profileName] = current[profileName] ?? cachedProfileState(profileName, prefs) ?? createSavedProfileState(profileName);
  }
  return next;
}
