use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCheck {
    pub name: String,
    pub command: String,
    pub status: DependencyStatus,
    pub version: Option<String>,
    pub required: bool,
    pub message: String,
    pub remediation: Option<String>,
    pub install_url: Option<String>,
    pub install_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DependencyStatus {
    Present,
    Missing,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentState {
    pub status: EnvironmentStatus,
    pub platform: String,
    pub checks: Vec<DependencyCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentStatus {
    Unchecked,
    Checking,
    Ready,
    Warning,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsProfile {
    pub name: String,
    pub source: ProfileSource,
    pub default_region: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCapability {
    pub id: ProfileCapabilityId,
    pub label: String,
    pub status: CapabilityStatus,
    pub message: String,
    pub account: Option<String>,
    pub regions: Option<Vec<String>>,
    pub region_name: Option<String>,
    pub visible_instance_count: Option<u32>,
    pub managed_node_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCapabilityReport {
    pub profile: String,
    pub region: Option<String>,
    pub capabilities: Vec<ProfileCapability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileCapabilityId {
    Auth,
    Regions,
    Ec2,
    Ssm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityStatus {
    Unknown,
    Checking,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SsoLoginAttemptStatus {
    Starting,
    Waiting,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoLoginAttempt {
    pub id: String,
    pub profile: String,
    pub status: SsoLoginAttemptStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileSource {
    AwsCli,
    ConfigFile,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct CallerIdentityRaw {
    pub user_id: String,
    pub account: String,
    pub arn: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub user_id: String,
    pub account: String,
    pub arn: String,
}

impl From<CallerIdentityRaw> for CallerIdentity {
    fn from(raw: CallerIdentityRaw) -> Self {
        Self {
            user_id: raw.user_id,
            account: raw.account,
            arn: raw.arn,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionOption {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagPair {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSummary {
    pub instance_id: String,
    pub name: Option<String>,
    pub state: String,
    pub platform: String,
    pub private_ip: Option<String>,
    pub public_ip: Option<String>,
    pub vpc_id: Option<String>,
    pub subnet_id: Option<String>,
    pub launch_time: Option<String>,
    pub tags: Vec<TagPair>,
    pub ssm_status: SsmStatus,
    pub ssm_ping_status: Option<String>,
    pub agent_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancePowerActionResult {
    pub instance_id: String,
    pub previous_state: String,
    pub current_state: String,
    pub requested_action: InstancePowerAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstancePowerAction {
    Start,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SsmStatus {
    Unknown,
    Ready,
    NotManaged,
    Offline,
    AccessDenied,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRecord {
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: u16,
    pub allocation: PortAllocationSource,
    pub listener_status: TunnelListenerStatus,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PortAllocationSource {
    Requested,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TunnelListenerStatus {
    Unknown,
    Starting,
    Active,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub kind: SessionKind,
    pub profile: String,
    pub region: String,
    pub instance_id: String,
    pub process_id: Option<u32>,
    pub started_at: String,
    pub status: SessionStatus,
    pub tunnel: Option<TunnelRecord>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    Shell,
    Tunnel,
    Rdp,
    Ssh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Starting,
    Active,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsoleSessionKind {
    Shell,
    Ssh,
    Rdp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsoleRenderer {
    Xterm,
    Guacamole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleSessionRecord {
    pub id: String,
    pub kind: ConsoleSessionKind,
    pub renderer: ConsoleRenderer,
    pub profile: String,
    pub region: String,
    pub instance_id: String,
    pub started_at: String,
    pub status: SessionStatus,
    pub title: String,
    pub tunnel: Option<TunnelRecord>,
    pub bridge_url: Option<String>,
    pub connection_token: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleSessionRequest {
    pub kind: ConsoleSessionKind,
    pub profile: String,
    pub region: String,
    pub instance_id: String,
    pub local_port: Option<u16>,
    pub username: Option<String>,
    pub ssh_key_path: Option<String>,
    pub rdp_username: Option<String>,
    pub rdp_password: Option<String>,
    pub terminal_cols: Option<u16>,
    pub terminal_rows: Option<u16>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleOutputEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub id: String,
    pub timestamp: String,
    pub severity: DiagnosticSeverity,
    pub area: DiagnosticArea,
    pub message: String,
    pub command: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticArea {
    Dependency,
    Aws,
    Process,
    Launcher,
    Security,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreferences {
    pub last_profile: Option<String>,
    pub last_region: Option<String>,
    pub saved_profiles: Option<Vec<String>>,
    pub active_profile: Option<String>,
    pub default_ssh_user: Option<String>,
    pub ssh_key_path: Option<String>,
    pub preferred_terminal_preset: Option<String>,
    pub custom_terminal_command: Option<String>,
    pub preferred_rdp_client: Option<String>,
    pub theme_mode: Option<String>,
    pub sidebar_width: Option<u16>,
    pub instance_table_visible_columns: Option<Vec<String>>,
    pub instance_table_column_widths: Option<std::collections::HashMap<String, u16>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub profile: String,
    pub region: String,
    pub instance_id: String,
    pub terminal_preset: Option<String>,
    pub custom_terminal_command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRequest {
    pub profile: String,
    pub region: String,
    pub instance_id: String,
    pub remote_port: u16,
    pub local_port: Option<u16>,
    pub remote_host: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpSessionRequest {
    pub profile: String,
    pub region: String,
    pub instance_id: String,
    pub local_port: Option<u16>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionRequest {
    pub profile: String,
    pub region: String,
    pub instance_id: String,
    pub local_port: Option<u16>,
    pub username: Option<String>,
    pub key_path: Option<String>,
    pub terminal_preset: Option<String>,
    pub custom_terminal_command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancePowerRequest {
    pub profile: String,
    pub region: String,
    pub instance_ids: Vec<String>,
}
