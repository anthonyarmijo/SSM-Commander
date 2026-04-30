import {
  type CSSProperties,
  Fragment,
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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Guacamole from "guacamole-common-js";
import "@xterm/xterm/css/xterm.css";
import { StatusPill } from "../components/StatusPill";
import { filterInstances } from "../features/instances/filters";
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
import { getBrowserPreviewConfig, invokeCommand, isTauriRuntime, openExternalUrl } from "../lib/tauri";
import { navItems, SSM_COMMANDER_ASCII, type ActiveView } from "./navigation";
import type {
  AwsProfile,
  CapabilityStatus,
  CallerIdentity,
  ConsoleOutputEvent,
  ConsoleSessionKind,
  ConsoleSessionRecord,
  DependencyCheck,
  DiagnosticEvent,
  EnvironmentState,
  InstancePowerActionResult,
  InstanceSummary,
  ProfileCapability,
  ProfileCapabilityReport,
  SessionRecord,
  SsoLoginAttempt,
  ThemeMode,
  UserPreferences,
} from "../types/models";

const DEFAULT_SIDEBAR_WIDTH = 270;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_KEYBOARD_STEP = 16;
const INSTANCE_ACTION_COLUMN_WIDTH = 104;
const INSTANCE_COLUMN_MENU_ID = "instances-column-menu";
const EMPTY_STATE_PROFILE_HELP =
  "The app will discover AWS CLI profiles already configured on your machine. Add one to validate access and unlock the Instances and Console views.";
const SAVED_PROFILE_WORKSPACE_HELP =
  "The active profile powers instance discovery, power actions, and console sessions. Keep additional profiles pinned here so you can switch into them quickly when needed.";
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

function isLoadedInstancesNotice(message: string): boolean {
  return /^Loaded \d+ instances using .+\.$/.test(message.trim());
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
  const [consoleSessionKind, setConsoleSessionKind] = useState<ConsoleSessionKind>("shell");
  const [instanceConnectionKind, setInstanceConnectionKind] = useState<ConsoleSessionKind>("shell");
  const [consoleInstanceId, setConsoleInstanceId] = useState("");
  const [rdpUsername, setRdpUsername] = useState("");
  const [rdpPassword, setRdpPassword] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const [query, setQuery] = useState("");
  const [sshUser, setSshUser] = useState("ec2-user");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [customLocalPort, setCustomLocalPort] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isPowerActionBusy, setIsPowerActionBusy] = useState(false);
  const [notice, setNotice] = useState("Ready.");
  const [activeView, setActiveView] = useState<ActiveView>("home");
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => getSystemTheme());
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [instanceTableVisibleColumns, setInstanceTableVisibleColumns] = useState<InstanceTableColumnId[]>(defaultInstanceTableVisibleColumns);
  const [instanceTableColumnWidths, setInstanceTableColumnWidths] = useState<InstanceTableColumnWidths>({});
  const [instanceSort, setInstanceSort] = useState<InstanceTableSort | null>(null);
  const [expandedInstanceDetailId, setExpandedInstanceDetailId] = useState("");
  const [instanceContextMenu, setInstanceContextMenu] = useState<InstanceContextMenuState>(null);
  const [isColumnMenuOpen, setIsColumnMenuOpen] = useState(false);
  const [isResizingTableColumn, setIsResizingTableColumn] = useState(false);
  const [isAddProfileOpen, setIsAddProfileOpen] = useState(false);
  const [profileToAdd, setProfileToAdd] = useState("");
  const [expandedProfileDetails, setExpandedProfileDetails] = useState<Record<string, boolean>>({});
  const preferencesRef = useRef<UserPreferences>({});
  const instancesRequestIdRef = useRef(0);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const ssoPollTimeoutsRef = useRef<Record<string, number>>({});
  const savedProfilesRef = useRef<string[]>([]);

  const activeProfileState = activeProfile ? profileStates[activeProfile] ?? createSavedProfileState(activeProfile) : null;
  const activeProfileRegion = resolveActiveProfileRegion(discoveredProfiles, activeProfile);
  const activeProfileReady = Boolean(activeProfile && activeProfileState?.authStatus === "valid" && activeProfileRegion);
  const currentAwsContextKey = buildAwsContextKey(activeProfile, activeProfileRegion);
  const selectedInstance = instances.find((instance) => instance.instanceId === selectedInstanceId) ?? null;
  const activeConsoleSession =
    consoleSessions.find((session) => session.id === activeConsoleSessionId) ?? consoleSessions[0] ?? null;
  const selectedInstanceIdSet = useMemo(() => new Set(selectedInstanceIds), [selectedInstanceIds]);
  const filteredInstances = useMemo(() => filterInstances(instances, query), [instances, query]);
  const visibleInstances = useMemo(() => sortInstances(filteredInstances, instanceSort), [filteredInstances, instanceSort]);
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
    () => visibleInstanceTableColumns.reduce((sum, column) => sum + column.width, INSTANCE_ACTION_COLUMN_WIDTH),
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
    setProfileStates((current) => buildInitialProfileStates(current, normalizedSavedProfiles));

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
      await savePreferencesPatch(buildConnectionPreferences({ sshKeyPath: selectedPath }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not open the SSH key picker.");
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
      } else {
        await savePreferencesPatch(buildConnectionPreferences());
      }
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
      setNotice(`Loaded ${refreshed.length} instances using ${activeProfile}.`);
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

  async function startPortForward() {
    if (!selectedInstance || !activeProfile || !activeProfileRegion) return;
    const requestedRemotePort = window.prompt("Remote port for this tunnel", "");
    if (!requestedRemotePort) return;
    const remotePortValue = Number(requestedRemotePort);
    if (!Number.isInteger(remotePortValue) || remotePortValue < 1 || remotePortValue > 65535) {
      setNotice("Enter a valid remote port between 1 and 65535.");
      return;
    }
    const requestedRemoteHost = window.prompt("Optional remote host (leave blank to use the instance)", "") || null;

    const session = await invokeCommand<SessionRecord>("start_port_forward", {
      request: {
        profile: activeProfile,
        region: activeProfileRegion,
        instanceId: selectedInstance.instanceId,
        remotePort: remotePortValue,
        localPort: customLocalPort ? Number(customLocalPort) : null,
        remoteHost: requestedRemoteHost && requestedRemoteHost.trim().length > 0 ? requestedRemoteHost.trim() : null,
      },
    });
    setNotice(`Tunnel active on localhost:${session.tunnel?.localPort ?? "auto"}.`);
    await loadSessions();
    await loadDiagnostics();
  }

  async function startConsoleSession(kind: ConsoleSessionKind, instanceId = selectedInstance?.instanceId ?? consoleInstanceId) {
    const trimmedInstanceId = instanceId.trim();
    if (!activeProfile || !activeProfileRegion || !trimmedInstanceId) return;
    const session = await invokeCommand<ConsoleSessionRecord>("start_console_session", {
      request: {
        kind,
        profile: activeProfile,
        region: activeProfileRegion,
        instanceId: trimmedInstanceId,
        localPort: kind === "shell" ? null : customLocalPort ? Number(customLocalPort) : null,
        username: kind === "ssh" ? sshUser || null : null,
        sshKeyPath: kind === "ssh" ? sshKeyPath || null : null,
        rdpUsername: kind === "rdp" ? rdpUsername || null : null,
        rdpPassword: kind === "rdp" ? rdpPassword || null : null,
        terminalCols: 100,
        terminalRows: 30,
        width: 1280,
        height: 720,
      },
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

  async function stopConsoleSession(sessionId: string) {
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

  function handleInstanceRowClick(event: ReactMouseEvent<HTMLTableRowElement>, instanceId: string) {
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
  }

  function handleInstanceDetailsToggle(event: ReactMouseEvent<HTMLButtonElement>, instanceId: string) {
    event.stopPropagation();
    setExpandedInstanceDetailId((current) => current === instanceId ? "" : instanceId);
  }

  function handleInstanceRowContextMenu(event: ReactMouseEvent<HTMLTableRowElement>, instanceId: string) {
    event.preventDefault();
    event.stopPropagation();
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 190));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 130));

    setSelectedInstanceIds([instanceId]);
    setSelectedInstanceId(instanceId);
    setSelectionAnchorId(instanceId);
    setExpandedInstanceDetailId((current) => current === instanceId ? current : "");
    setInstanceContextMenu({ instanceId, x, y });
  }

  useEffect(() => {
    savedProfilesRef.current = savedProfiles;
  }, [savedProfiles]);

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
    if (activeView !== "instances" && instanceContextMenu) {
      setInstanceContextMenu(null);
    }
  }, [activeView, instanceContextMenu]);

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
    if (activeView === "instances" && !activeProfileReady) {
      setActiveView("initialize");
    }
  }, [activeProfileReady, activeView]);

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
    <div className={`app-shell ${isResizingSidebar || isResizingTableColumn ? "app-shell--resizing" : ""}`} style={appShellStyle}>
      <aside className="sidebar" aria-label="Primary navigation">
        <nav className="side-nav" aria-label="Workspace sections">
          {navItems.map((item) => {
            const isDisabled = item.view === "instances" && !activeProfileReady;
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
                {item.label}
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
            <div className="ascii-banner" aria-label="SSM Commander">
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

        {activeView === "instances" && (
          <section className="view" aria-labelledby="instances-title">
            <header className="topbar">
              <div>
                <p className="eyebrow">Instances</p>
                <h2 id="instances-title">Browse instances and manage EC2 power</h2>
              </div>
              <div className="topbar-actions">
                <button
                  aria-label="Refresh instances from AWS"
                  className="button-primary icon-button"
                  disabled={!activeProfileReady || isInstancesLoading}
                  onClick={() => void refreshInstances("manual")}
                  title="Refresh instances from AWS"
                  type="button"
                >
                  <RefreshIcon />
                  <span className="visually-hidden">Refresh instances from AWS</span>
                </button>
              </div>
            </header>

            <div className={instancesNoticeClassName}>
              {notice}
            </div>

            <div className="content-grid">
              <section className="instance-area">
                <div className="table-tools">
                  <input onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, id, tag, IP, VPC..." value={query} />
                  <div className="table-tools__actions">
                    <div className="column-menu" ref={columnMenuRef}>
                      <button
                        aria-controls={INSTANCE_COLUMN_MENU_ID}
                        aria-expanded={isColumnMenuOpen}
                        className="button-secondary"
                        onClick={() => setIsColumnMenuOpen((current) => !current)}
                        type="button"
                      >
                        Columns
                      </button>
                      {isColumnMenuOpen && (
                        <div className="column-menu__popover" id={INSTANCE_COLUMN_MENU_ID} role="menu" aria-label="Choose visible instance columns">
                          {instanceTableColumns.map((column) => {
                            const checked = instanceTableVisibleColumns.includes(column.id);
                            const disableToggle = checked && instanceTableVisibleColumns.length === 1;
                            return (
                              <label className={`column-menu__option ${disableToggle ? "column-menu__option--disabled" : ""}`} key={column.id}>
                                <input
                                  checked={checked}
                                  disabled={disableToggle}
                                  onChange={(event) => setInstanceColumnVisibility(column.id, event.target.checked)}
                                  type="checkbox"
                                />
                                <span>{column.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <span>{visibleInstances.length} instances</span>
                    {selectedInstanceIds.length > 1 && <span>{selectedInstanceIds.length} selected</span>}
                  </div>
                </div>
                <div className="table-frame" aria-busy={isInstancesLoading}>
                  {showInstancesRefreshing && (
                    <div className="table-frame__loading-overlay">
                      <LoadingIndicator label="Loading instances from AWS..." />
                    </div>
                  )}
                  <table style={{ minWidth: `${instanceTableMinWidth}px` }}>
	                    <colgroup>
	                      {visibleInstanceTableColumns.map((column) => (
	                        <col key={column.definition.id} style={{ width: `${column.width}px` }} />
	                      ))}
	                      <col style={{ width: `${INSTANCE_ACTION_COLUMN_WIDTH}px` }} />
	                    </colgroup>
	                    <thead>
	                      <tr>
                        {visibleInstanceTableColumns.map((column) => (
                          <th
                            aria-sort={ariaSortValue(column.definition.id)}
                            key={column.definition.id}
                            style={{ width: `${column.width}px`, minWidth: `${column.definition.minWidth}px` }}
                          >
                            <div className="table-header-cell">
                              <button
                                className="table-header-button"
                                onClick={() => handleInstanceColumnSort(column.definition.id)}
                                type="button"
                              >
                                <span>{column.definition.label}</span>
                                <SortIcon
                                  direction={instanceSort?.columnId === column.definition.id ? instanceSort.direction : "none"}
                                />
                              </button>
                              {column.definition.resizable && (
                                <span
                                  aria-hidden="true"
                                  className="column-resize-handle"
                                  title={`Resize ${column.definition.label} column`}
                                  onMouseDown={(event) => startInstanceColumnResize(event, column.definition.id)}
                                />
                              )}
                            </div>
	                          </th>
	                        ))}
	                        <th className="instance-row-actions-header" scope="col" style={{ width: `${INSTANCE_ACTION_COLUMN_WIDTH}px` }}>
	                          <span className="visually-hidden">Actions</span>
	                        </th>
	                      </tr>
	                    </thead>
                    <tbody>
                      {showInitialInstancesLoader && (
                        <tr>
                          <td className="empty-cell empty-cell--loading" colSpan={visibleInstanceColumnCount}>
                            <LoadingIndicator label="Loading instances from AWS..." />
                          </td>
                        </tr>
                      )}
	                      {visibleInstances.map((instance) => {
	                        const isSelected = selectedInstanceIdSet.has(instance.instanceId);
	                        const isExpanded = isSelected && expandedInstanceDetailId === instance.instanceId;
	                        const detailId = `instance-details-${instance.instanceId}`;
	
	                        return (
	                          <Fragment key={instance.instanceId}>
	                            <tr
	                              aria-selected={isSelected}
	                              className={`${isSelected ? "selected" : ""} ${instance.instanceId === selectedInstanceId ? "selected selected--primary" : ""}`.trim()}
	                              onClick={(event) => handleInstanceRowClick(event, instance.instanceId)}
	                              onContextMenu={(event) => handleInstanceRowContextMenu(event, instance.instanceId)}
	                            >
	                              {visibleInstanceTableColumns.map((column) => (
	                                <td key={`${instance.instanceId}-${column.definition.id}`}>{column.definition.renderCell(instance)}</td>
	                              ))}
	                              <td className="instance-row-actions">
	                                {isSelected && (
	                                  <button
	                                    aria-controls={detailId}
	                                    aria-expanded={isExpanded}
	                                    className="button-ghost instance-details-toggle"
	                                    onClick={(event) => handleInstanceDetailsToggle(event, instance.instanceId)}
	                                    type="button"
	                                  >
	                                    {isExpanded ? "Hide" : "Details"}
	                                  </button>
	                                )}
	                              </td>
	                            </tr>
	                            {isExpanded && (
	                              <tr className="instance-detail-row">
	                                <td className="instance-detail-cell" colSpan={visibleInstanceColumnCount}>
	                                  <div className="instance-detail-panel detail-stack" id={detailId}>
	                                    <div><span>Name</span><strong>{instance.name || "Unnamed"}</strong></div>
	                                    <div><span>Instance ID</span><code>{instance.instanceId}</code></div>
	                                    <div><span>State</span><strong>{instance.state}</strong></div>
	                                    <div><span>Network</span><strong>{instance.privateIp || "No private IP"}</strong></div>
	                                    <div><span>SSM</span><StatusPill label={instance.ssmStatus} tone={ssmTone(instance.ssmStatus)} /></div>
	                                  </div>
	                                </td>
	                              </tr>
	                            )}
	                          </Fragment>
	                        );
	                      })}
                      {!showInitialInstancesLoader && visibleInstances.length === 0 && (
                        <tr>
                          <td className="empty-cell" colSpan={visibleInstanceColumnCount}>No instances loaded yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

	              <aside className="inspector">
	                <h2>{selectedInstanceIds.length > 1 ? "Primary Instance Actions" : "Instance Actions"}</h2>
	                {selectedInstance ? (
	                  <>
	                    <div className="inspector-section">
	                      <h3>Power actions</h3>
                      <p className="muted">
                        Active profile: <code>{activeProfile || "Not selected"}</code>
                        {selectedInstanceIds.length > 1 ? ` · ${selectedInstanceIds.length} selected` : ""}
                      </p>
                      <div className="action-stack action-stack--inline">
                        <button
                          className="button-primary"
                          disabled={!activeProfileReady || isPowerActionBusy || startSelection.eligibleInstanceIds.length === 0}
                          onClick={() => void runInstancePowerAction("start")}
                          title={!activeProfileReady ? "Validate the active profile first." : startSelection.eligibleInstanceIds.length === 0 ? "No selected instances can be started." : undefined}
                        >
                          {isPowerActionBusy ? "Working..." : selectedInstanceIds.length > 1 ? `Start selected (${startSelection.eligibleInstanceIds.length})` : "Start instance"}
                        </button>
                        <button
                          disabled={!activeProfileReady || isPowerActionBusy || stopSelection.eligibleInstanceIds.length === 0}
                          onClick={() => void runInstancePowerAction("stop")}
                          title={!activeProfileReady ? "Validate the active profile first." : stopSelection.eligibleInstanceIds.length === 0 ? "No selected instances can be stopped." : undefined}
                        >
                          {isPowerActionBusy ? "Working..." : selectedInstanceIds.length > 1 ? `Stop selected (${stopSelection.eligibleInstanceIds.length})` : "Stop instance"}
                        </button>
                      </div>
                    </div>

                    <div className="inspector-section connection-actions">
                      <h3>Connection actions</h3>
                      {selectedInstance.state !== "running" ? (
                        <p className="resource-offline">Resource offline</p>
                      ) : (
                        <>
                          <p className="muted">These launch through the active validated profile and use the primary selected instance.</p>
                          <div className="segmented-control segmented-control--connection" role="group" aria-label="Connection type">
                            <button
                              className={instanceConnectionKind === "shell" ? "active" : ""}
                              onClick={() => setInstanceConnectionKind("shell")}
                              type="button"
                            >
                              Direct SSM (Shell)
                            </button>
                            <button
                              className={instanceConnectionKind === "ssh" ? "active" : ""}
                              onClick={() => setInstanceConnectionKind("ssh")}
                              type="button"
                            >
                              SSH
                            </button>
                            <button
                              className={instanceConnectionKind === "rdp" ? "active" : ""}
                              onClick={() => setInstanceConnectionKind("rdp")}
                              type="button"
                            >
                              RDP
                            </button>
                          </div>

                          {instanceConnectionKind === "ssh" && (
                            <>
                              <label>
                                SSH user
                                <input {...technicalInputProps} onChange={(event) => setSshUser(event.target.value)} value={sshUser} />
                              </label>
                              <div className="field-group">
                                <span className="field-group__label">SSH key path</span>
                                <div className="path-input-row">
                                  <input {...technicalInputProps} onChange={(event) => setSshKeyPath(event.target.value)} placeholder="Optional" value={sshKeyPath} />
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
                                RDP password
                                <input {...technicalInputProps} onChange={(event) => setRdpPassword(event.target.value)} placeholder="Kept in memory only" type="password" value={rdpPassword} />
                              </label>
                            </>
                          )}

                          {instanceConnectionKind !== "shell" && (
                            <label>
                              Local port
                              <input {...technicalInputProps} onChange={(event) => setCustomLocalPort(event.target.value)} placeholder="Auto" value={customLocalPort} />
                            </label>
                          )}

                          <div className="action-stack connection-actions__buttons">
                            <button
                              className="button-primary"
                              disabled={!canConnectToInstance}
                              onClick={() => void startConsoleSession(instanceConnectionKind)}
                              title={connectionDisabledTitle}
                              type="button"
                            >
                              {consoleOpenLabel(instanceConnectionKind)}
                            </button>
                            <button
                              disabled={!canConnectToInstance}
                              onClick={() => void startPortForward()}
                              title={connectionDisabledTitle}
                              type="button"
                            >
                              Start Tunnel
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="muted">Select an EC2 instance to see power and connection actions.</p>
	                )}
	              </aside>
	            </div>
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
	                <button
	                  disabled={!activeProfileReady || isPowerActionBusy || contextMenuInstance.state !== "stopped"}
	                  onClick={() => void runInstancePowerActionForInstance("start", contextMenuInstance.instanceId)}
	                  role="menuitem"
	                  type="button"
	                >
	                  Start
	                </button>
	                <button
	                  disabled={!activeProfileReady || isPowerActionBusy || contextMenuInstance.state !== "running"}
	                  onClick={() => void runInstancePowerActionForInstance("stop", contextMenuInstance.instanceId)}
	                  role="menuitem"
	                  type="button"
	                >
	                  Stop
	                </button>
	              </div>
	            )}
	          </section>
	        )}

        {activeView === "console" && (
          <section className="view view--console" aria-label="Console">
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
                      void stopConsoleSession(session.id);
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
                        RDP password
                        <input {...technicalInputProps} onChange={(event) => setRdpPassword(event.target.value)} placeholder="Kept in memory only" type="password" value={rdpPassword} />
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
                  <GuacamoleConsole session={activeConsoleSession} />
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
              <button onClick={() => void loadDiagnostics()}>Refresh</button>
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

function GuacamoleConsole({ session }: { session: ConsoleSessionRecord }) {
  const displayRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState(session.message ?? "");

  useEffect(() => {
    const display = displayRef.current;
    if (!display || !session.bridgeUrl || !session.connectionToken) {
      return;
    }

    display.replaceChildren();
    const tunnel = new Guacamole.WebSocketTunnel(session.bridgeUrl);
    const client = new Guacamole.Client(tunnel);
    const element = client.getDisplay().getElement();
    display.appendChild(element);

    client.onerror = (status: { message?: string }) => {
      setError(status.message || "RDP console disconnected.");
    };
    client.connect(`token=${encodeURIComponent(session.connectionToken)}`);

    const mouse = new Guacamole.Mouse(element);
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState: unknown) => {
      client.sendMouseState(mouseState);
    };
    const keyboard = new Guacamole.Keyboard(document);
    keyboard.onkeydown = (keysym: number) => {
      client.sendKeyEvent(1, keysym);
    };
    keyboard.onkeyup = (keysym: number) => {
      client.sendKeyEvent(0, keysym);
    };

    return () => {
      keyboard.onkeydown = null;
      keyboard.onkeyup = null;
      client.disconnect();
      display.replaceChildren();
    };
  }, [session.bridgeUrl, session.connectionToken]);

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
): ProfileStateMap {
  const next: ProfileStateMap = {};
  for (const profileName of savedProfiles) {
    next[profileName] = current[profileName] ?? createSavedProfileState(profileName);
  }
  return next;
}
