export type EnvironmentStatus = "unchecked" | "checking" | "ready" | "warning" | "blocked";
export type DependencyStatus = "present" | "missing" | "warning";
export type AuthStatus = "unknown" | "valid" | "expired" | "error";
export type SsmStatus = "unknown" | "ready" | "notManaged" | "offline" | "accessDenied" | "error";
export type SessionKind = "shell" | "tunnel" | "rdp" | "ssh";
export type SessionStatus = "starting" | "active" | "stopping" | "stopped" | "failed";
export type ConsoleSessionKind = "shell" | "ssh" | "rdp";
export type ConsoleRenderer = "xterm" | "guacamole";
export type DiagnosticSeverity = "info" | "warning" | "error";
export type DiagnosticArea = "dependency" | "aws" | "process" | "launcher" | "security";
export type ThemeMode = "system" | "light" | "dark";
export type InstancePowerAction = "start" | "stop";
export type CapabilityStatus = "unknown" | "checking" | "available" | "unavailable";
export type ProfileCapabilityId = "auth" | "regions" | "ec2" | "ssm";
export type SsoLoginAttemptStatus = "starting" | "waiting" | "succeeded" | "failed";
export interface DependencyCheck {
  name: string;
  command: string;
  status: DependencyStatus;
  version?: string | null;
  required: boolean;
  message: string;
  remediation?: string | null;
  installUrl?: string | null;
  installLabel?: string | null;
}

export interface EnvironmentState {
  status: EnvironmentStatus;
  platform: string;
  checks: DependencyCheck[];
}

export interface AwsProfile {
  name: string;
  source: "awsCli" | "configFile" | "unknown";
  defaultRegion?: string | null;
}

export interface ProfileCapability {
  id: ProfileCapabilityId;
  label: string;
  status: CapabilityStatus;
  message: string;
  account?: string | null;
  regions?: string[] | null;
  regionName?: string | null;
  visibleInstanceCount?: number | null;
  managedNodeCount?: number | null;
}

export interface ProfileCapabilityReport {
  profile: string;
  region?: string | null;
  capabilities: ProfileCapability[];
}

export interface SsoLoginAttempt {
  id: string;
  profile: string;
  status: SsoLoginAttemptStatus;
  message: string;
}

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

export interface RegionOption {
  name: string;
}

export interface TagPair {
  key: string;
  value: string;
}

export interface InstanceSummary {
  instanceId: string;
  name?: string | null;
  state: string;
  platform: string;
  privateIp?: string | null;
  publicIp?: string | null;
  vpcId?: string | null;
  subnetId?: string | null;
  launchTime?: string | null;
  tags: TagPair[];
  ssmStatus: SsmStatus;
  ssmPingStatus?: string | null;
  agentVersion?: string | null;
}

export interface InstancePowerActionResult {
  instanceId: string;
  previousState: string;
  currentState: string;
  requestedAction: InstancePowerAction;
}

export interface TunnelRecord {
  localPort: number;
  remoteHost?: string | null;
  remotePort: number;
  allocation: "requested" | "auto";
  listenerStatus: "unknown" | "starting" | "active" | "failed";
  sessionId: string;
}

export interface SessionRecord {
  id: string;
  kind: SessionKind;
  profile: string;
  region: string;
  instanceId: string;
  processId?: number | null;
  startedAt: string;
  status: SessionStatus;
  tunnel?: TunnelRecord | null;
  note?: string | null;
}

export interface ConsoleSessionRecord {
  id: string;
  kind: ConsoleSessionKind;
  renderer: ConsoleRenderer;
  profile: string;
  region: string;
  instanceId: string;
  startedAt: string;
  status: SessionStatus;
  title: string;
  tunnel?: TunnelRecord | null;
  bridgeUrl?: string | null;
  connectionToken?: string | null;
  message?: string | null;
}

export interface ConsoleSessionRequest {
  kind: ConsoleSessionKind;
  profile: string;
  region: string;
  instanceId: string;
  localPort?: number | null;
  username?: string | null;
  sshKeyPath?: string | null;
  rdpUsername?: string | null;
  rdpPassword?: string | null;
  terminalCols?: number | null;
  terminalRows?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface ConsoleOutputEvent {
  sessionId: string;
  data: string;
}

export interface DiagnosticEvent {
  id: string;
  timestamp: string;
  severity: DiagnosticSeverity;
  area: DiagnosticArea;
  message: string;
  command?: string[] | null;
}

export interface UserPreferences {
  lastProfile?: string | null;
  lastRegion?: string | null;
  savedProfiles?: string[] | null;
  activeProfile?: string | null;
  defaultSshUser?: string | null;
  sshKeyPath?: string | null;
  preferredRdpClient?: string | null;
  themeMode?: ThemeMode | null;
  sidebarWidth?: number | null;
  instanceTableVisibleColumns?: string[] | null;
  instanceTableColumnWidths?: Record<string, number> | null;
}

export interface ConnectRequest {
  profile: string;
  region: string;
  instanceId: string;
}

export interface PortForwardRequest extends ConnectRequest {
  remotePort: number;
  localPort?: number | null;
  remoteHost?: string | null;
}

export interface RdpSessionRequest extends ConnectRequest {
  localPort?: number | null;
  username?: string | null;
}

export interface SshSessionRequest extends ConnectRequest {
  localPort?: number | null;
  username?: string | null;
  keyPath?: string | null;
}
