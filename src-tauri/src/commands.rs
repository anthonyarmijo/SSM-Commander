use crate::models::{
    AwsProfile, CallerIdentity, ConnectRequest, ConsoleSessionRecord, ConsoleSessionRequest,
    DiagnosticArea, DiagnosticEvent, EnvironmentState, InstancePowerActionResult,
    InstancePowerRequest, InstanceSummary, PortAllocationSource, PortForwardRequest,
    ProfileCapabilityReport, RdpSessionRequest, RegionOption, SessionKind, SessionRecord,
    SshSessionRequest, SsoLoginAttempt, SsoLoginAttemptStatus, TunnelListenerStatus,
    UserPreferences,
};
use crate::{aws_cli, console, dependencies, platform, ports, preferences, sessions, AppState};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{async_runtime, AppHandle, Manager, State};
use uuid::Uuid;

const CONSOLE_TUNNEL_READY_TIMEOUT: Duration = Duration::from_secs(8);
const CONSOLE_TUNNEL_SETTLE_DELAY: Duration = Duration::from_millis(1_200);

#[tauri::command]
pub fn check_environment(state: State<'_, AppState>) -> Result<EnvironmentState, String> {
    let environment = dependencies::check_environment();
    match environment.status {
        crate::models::EnvironmentStatus::Ready => {
            state
                .diagnostics
                .info(DiagnosticArea::Dependency, "Environment check passed");
        }
        crate::models::EnvironmentStatus::Warning => {
            state.diagnostics.warning(
                DiagnosticArea::Dependency,
                "Environment check completed with warnings",
            );
        }
        crate::models::EnvironmentStatus::Blocked => {
            state.diagnostics.error(
                DiagnosticArea::Dependency,
                "Environment is missing required dependencies",
            );
        }
        _ => {}
    }
    Ok(environment)
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<Vec<AwsProfile>, String> {
    aws_cli::list_profiles().map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Aws,
            format!("Could not list AWS profiles: {error}"),
        );
        error
    })
}

#[tauri::command]
pub fn validate_profile(
    state: State<'_, AppState>,
    profile: String,
    _region: Option<String>,
) -> Result<CallerIdentity, String> {
    aws_cli::validate_profile(&profile, None).map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Aws,
            format!("Profile validation failed: {error}"),
        );
        error
    })
}

#[tauri::command]
pub fn probe_profile_capabilities(
    state: State<'_, AppState>,
    profile: String,
    region: Option<String>,
) -> Result<ProfileCapabilityReport, String> {
    let report = aws_cli::probe_profile_capabilities(&profile, region.as_deref());
    let has_unavailable = report.capabilities.iter().any(|capability| {
        matches!(
            capability.status,
            crate::models::CapabilityStatus::Unavailable
        )
    });

    if has_unavailable {
        state.diagnostics.warning(
            DiagnosticArea::Aws,
            "Completed capability probes with warnings",
        );
    } else {
        state.diagnostics.info(
            DiagnosticArea::Aws,
            "Completed capability probes",
        );
    }

    Ok(report)
}

#[tauri::command]
pub fn list_regions(
    state: State<'_, AppState>,
    profile: String,
) -> Result<Vec<RegionOption>, String> {
    aws_cli::list_regions(&profile).map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Aws,
            format!("Could not list regions: {error}"),
        );
        error
    })
}

#[tauri::command]
pub fn start_sso_login(
    state: State<'_, AppState>,
    app: AppHandle,
    profile: String,
) -> Result<SsoLoginAttempt, String> {
    let attempt = SsoLoginAttempt {
        id: Uuid::new_v4().to_string(),
        profile: profile.clone(),
        status: SsoLoginAttemptStatus::Starting,
        message: "Starting AWS SSO login...".to_string(),
    };

    state
        .sso_login_attempts
        .lock()
        .map_err(|_| "SSO login attempt registry is unavailable".to_string())?
        .insert(attempt.id.clone(), attempt.clone());

    state.diagnostics.info(
        DiagnosticArea::Aws,
        "Started AWS SSO login",
    );

    let attempt_id = attempt.id.clone();
    thread::spawn(move || {
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut attempts) = state.sso_login_attempts.lock() {
                if let Some(entry) = attempts.get_mut(&attempt_id) {
                    entry.status = SsoLoginAttemptStatus::Waiting;
                    entry.message = "Waiting for AWS SSO browser sign-in to finish...".to_string();
                }
            }
        }

        let outcome = aws_cli::run_sso_login(&profile);

        if let Some(state) = app.try_state::<AppState>() {
            match outcome {
                Ok(result) => {
                    state.diagnostics.info(
                        DiagnosticArea::Aws,
                        format!("AWS SSO login completed: {}", result.message),
                    );
                    if let Ok(mut attempts) = state.sso_login_attempts.lock() {
                        if let Some(entry) = attempts.get_mut(&attempt_id) {
                            entry.status = result.status;
                            entry.message = result.message;
                        }
                    }
                }
                Err(error) => {
                    state.diagnostics.error(
                        DiagnosticArea::Aws,
                        format!("Could not complete AWS SSO login: {error}"),
                    );
                    if let Ok(mut attempts) = state.sso_login_attempts.lock() {
                        if let Some(entry) = attempts.get_mut(&attempt_id) {
                            entry.status = SsoLoginAttemptStatus::Failed;
                            entry.message = error;
                        }
                    }
                }
            }
        }
    });

    Ok(attempt)
}

#[tauri::command]
pub fn get_sso_login_attempt(
    state: State<'_, AppState>,
    attempt_id: String,
) -> Result<SsoLoginAttempt, String> {
    let attempts = state
        .sso_login_attempts
        .lock()
        .map_err(|_| "SSO login attempt registry is unavailable".to_string())?;

    attempts
        .get(&attempt_id)
        .cloned()
        .ok_or_else(|| format!("No AWS SSO login attempt was found for id {attempt_id}."))
}

#[tauri::command]
pub fn load_preferences() -> Result<UserPreferences, String> {
    preferences::load_preferences()
}

#[tauri::command]
pub fn save_preferences(preferences: UserPreferences) -> Result<(), String> {
    preferences::save_preferences(&preferences)
}

#[tauri::command]
pub async fn discover_instances(
    state: State<'_, AppState>,
    profile: String,
    region: String,
) -> Result<Vec<InstanceSummary>, String> {
    let result = async_runtime::spawn_blocking({
        let profile = profile.clone();
        let region = region.clone();
        move || aws_cli::discover_instances(&profile, &region)
    })
    .await
    .map_err(|error| format!("Could not join EC2 discovery task: {error}"))?;

    result.map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Aws,
            format!("Could not discover EC2 instances: {error}"),
        );
        error
    })
}

#[tauri::command]
pub async fn get_ssm_readiness(
    state: State<'_, AppState>,
    profile: String,
    region: String,
    instance_ids: Vec<String>,
) -> Result<Vec<InstanceSummary>, String> {
    let result = async_runtime::spawn_blocking({
        let profile = profile.clone();
        let region = region.clone();
        move || aws_cli::discover_instances_with_ssm(&profile, &region, &instance_ids)
    })
    .await
    .map_err(|error| format!("Could not join SSM readiness task: {error}"))?;

    result.map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Aws,
            format!("Could not check SSM readiness: {error}"),
        );
        error
    })
}

#[tauri::command]
pub async fn start_instances(
    state: State<'_, AppState>,
    request: InstancePowerRequest,
) -> Result<Vec<InstancePowerActionResult>, String> {
    let result = async_runtime::spawn_blocking(move || {
        aws_cli::start_instances(&request.profile, &request.region, &request.instance_ids)
    })
    .await
    .map_err(|error| format!("Could not join start instances task: {error}"))?;

    result.map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Aws,
            format!("Could not start instances: {error}"),
        );
        error
    })
}

#[tauri::command]
pub async fn stop_instances(
    state: State<'_, AppState>,
    request: InstancePowerRequest,
) -> Result<Vec<InstancePowerActionResult>, String> {
    let result = async_runtime::spawn_blocking(move || {
        aws_cli::stop_instances(&request.profile, &request.region, &request.instance_ids)
    })
    .await
    .map_err(|error| format!("Could not join stop instances task: {error}"))?;

    result.map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Aws,
            format!("Could not stop instances: {error}"),
        );
        error
    })
}

#[tauri::command]
pub fn start_shell_session(
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> Result<SessionRecord, String> {
    let args =
        sessions::ssm::build_shell_args(&request.profile, &request.region, &request.instance_id);
    platform::launch_terminal_command(
        "SSM Shell",
        &args,
        request.terminal_preset.as_deref(),
        request.custom_terminal_command.as_deref(),
    )
    .map_err(|error| {
        state.diagnostics.error(
            DiagnosticArea::Launcher,
            format!("Could not launch shell session: {error}"),
        );
        error
    })?;

    let record = sessions::ssm::external_shell_record(
        &request.profile,
        &request.region,
        &request.instance_id,
    );
    let mut registry = state
        .processes
        .lock()
        .map_err(|_| "Process registry is unavailable".to_string())?;
    Ok(registry.record_external(record, &state.diagnostics))
}

#[tauri::command]
pub fn start_port_forward(
    state: State<'_, AppState>,
    request: PortForwardRequest,
) -> Result<SessionRecord, String> {
    start_tunnel(&state, request, SessionKind::Tunnel)
}

#[tauri::command]
pub fn start_rdp_session(
    state: State<'_, AppState>,
    request: RdpSessionRequest,
) -> Result<SessionRecord, String> {
    let tunnel_request = sessions::rdp::request(
        &request.profile,
        &request.region,
        &request.instance_id,
        request.local_port,
    );
    let record = start_tunnel(&state, tunnel_request, SessionKind::Rdp)?;
    let port = record
        .tunnel
        .as_ref()
        .map(|tunnel| tunnel.local_port)
        .ok_or_else(|| "RDP tunnel was not created".to_string())?;

    thread::sleep(Duration::from_millis(900));
    platform::launch_rdp(port, request.username.as_deref())?;
    Ok(record)
}

#[tauri::command]
pub fn start_ssh_session(
    state: State<'_, AppState>,
    request: SshSessionRequest,
) -> Result<SessionRecord, String> {
    let tunnel_request = sessions::ssh::request(
        &request.profile,
        &request.region,
        &request.instance_id,
        request.local_port,
    );
    let record = start_tunnel(&state, tunnel_request, SessionKind::Ssh)?;
    let port = record
        .tunnel
        .as_ref()
        .map(|tunnel| tunnel.local_port)
        .ok_or_else(|| "SSH tunnel was not created".to_string())?;
    let username = request.username.as_deref().unwrap_or("ec2-user");

    thread::sleep(Duration::from_millis(900));
    platform::launch_ssh_terminal(
        port,
        username,
        request.key_path.as_deref(),
        request.terminal_preset.as_deref(),
        request.custom_terminal_command.as_deref(),
    )?;
    Ok(record)
}

#[tauri::command]
pub fn start_console_session(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ConsoleSessionRequest,
) -> Result<ConsoleSessionRecord, String> {
    if matches!(request.kind, crate::models::ConsoleSessionKind::Shell) {
        let managed_session = console::shell_console_session(app, &request)?;
        let mut registry = state
            .consoles
            .lock()
            .map_err(|_| "Console registry is unavailable".to_string())?;
        return Ok(registry.insert(managed_session));
    }

    if matches!(request.kind, crate::models::ConsoleSessionKind::Rdp)
        && !console::guacd_is_available()
    {
        state.diagnostics.push(
            crate::models::DiagnosticSeverity::Warning,
            DiagnosticArea::Dependency,
            "Embedded RDP requires guacd on 127.0.0.1:4822 or a bundled guacd sidecar.".to_string(),
            None,
        );
        let managed_session = console::failed_rdp_console_session(
            &request,
            "Embedded RDP requires guacd on 127.0.0.1:4822 or a bundled guacd sidecar.".to_string(),
        );
        let mut registry = state
            .consoles
            .lock()
            .map_err(|_| "Console registry is unavailable".to_string())?;
        return Ok(registry.insert(managed_session));
    }

    let tunnel_request = match request.kind {
        crate::models::ConsoleSessionKind::Shell => unreachable!("Shell console sessions do not use tunnels"),
        crate::models::ConsoleSessionKind::Ssh => sessions::ssh::request(
            &request.profile,
            &request.region,
            &request.instance_id,
            request.local_port,
        ),
        crate::models::ConsoleSessionKind::Rdp => sessions::rdp::request(
            &request.profile,
            &request.region,
            &request.instance_id,
            request.local_port,
        ),
    };
    let tunnel_kind = match request.kind {
        crate::models::ConsoleSessionKind::Shell => unreachable!("Shell console sessions do not use tunnels"),
        crate::models::ConsoleSessionKind::Ssh => SessionKind::Ssh,
        crate::models::ConsoleSessionKind::Rdp => SessionKind::Rdp,
    };
    let tunnel_record = start_tunnel(&state, tunnel_request, tunnel_kind)?;
    let tunnel_port = tunnel_record
        .tunnel
        .as_ref()
        .map(|tunnel| tunnel.local_port)
        .ok_or_else(|| "Console tunnel was not created".to_string())?;
    wait_for_console_tunnel(&state, tunnel_port)?;

    let managed_session = match request.kind {
        crate::models::ConsoleSessionKind::Shell => unreachable!("Shell console sessions are created before tunnel setup"),
        crate::models::ConsoleSessionKind::Ssh => {
            console::ssh_console_session(app, &request, tunnel_record)
        }
        crate::models::ConsoleSessionKind::Rdp => console::rdp_console_session(
            &request,
            tunnel_record,
            &state.guacamole_bridge,
            &state.diagnostics,
        ),
    }?;

    let mut registry = state
        .consoles
        .lock()
        .map_err(|_| "Console registry is unavailable".to_string())?;
    Ok(registry.insert(managed_session))
}

#[tauri::command]
pub fn stop_console_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ConsoleSessionRecord, String> {
    let (record, tunnel_session_id) = {
        let mut registry = state
            .consoles
            .lock()
            .map_err(|_| "Console registry is unavailable".to_string())?;
        registry.stop(&session_id)?
    };

    if let Some(tunnel_session_id) = tunnel_session_id {
        if let Ok(mut registry) = state.processes.lock() {
            let _ = registry.stop_session(&tunnel_session_id, &state.diagnostics);
        }
    }
    if let Some(token) = record.connection_token.as_deref() {
        state.guacamole_bridge.remove_connection(token);
    }

    Ok(record)
}

#[tauri::command]
pub fn list_console_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<ConsoleSessionRecord>, String> {
    let registry = state
        .consoles
        .lock()
        .map_err(|_| "Console registry is unavailable".to_string())?;
    Ok(registry.list())
}

#[tauri::command]
pub fn write_console_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut registry = state
        .consoles
        .lock()
        .map_err(|_| "Console registry is unavailable".to_string())?;
    registry.write_input(&session_id, &data)
}

#[tauri::command]
pub fn resize_console_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut registry = state
        .consoles
        .lock()
        .map_err(|_| "Console registry is unavailable".to_string())?;
    registry.resize_terminal(&session_id, cols, rows)
}

#[tauri::command]
pub fn stop_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let mut registry = state
        .processes
        .lock()
        .map_err(|_| "Process registry is unavailable".to_string())?;
    registry.stop_session(&session_id, &state.diagnostics)
}

#[tauri::command]
pub fn list_active_sessions(state: State<'_, AppState>) -> Result<Vec<SessionRecord>, String> {
    let mut registry = state
        .processes
        .lock()
        .map_err(|_| "Process registry is unavailable".to_string())?;
    Ok(registry.list_active_sessions())
}

#[tauri::command]
pub fn get_diagnostics(state: State<'_, AppState>) -> Result<Vec<DiagnosticEvent>, String> {
    Ok(state.diagnostics.list())
}

#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    let path = preferences::logs_dir()?;
    platform::open_path(&path)
}

fn wait_for_console_tunnel(state: &State<'_, AppState>, local_port: u16) -> Result<(), String> {
    let started_at = Instant::now();
    while started_at.elapsed() < CONSOLE_TUNNEL_READY_TIMEOUT {
        if !ports::is_port_available(local_port) {
            state.diagnostics.info(
                DiagnosticArea::Process,
                format!("SSM tunnel listener is ready on local port {local_port}"),
            );
            thread::sleep(CONSOLE_TUNNEL_SETTLE_DELAY);
            return Ok(());
        }

        thread::sleep(Duration::from_millis(100));
    }

    let message = format!("Timed out waiting for SSM tunnel listener on local port {local_port}");
    state
        .diagnostics
        .error(DiagnosticArea::Process, message.clone());
    Err(message)
}

fn start_tunnel(
    state: &State<'_, AppState>,
    request: PortForwardRequest,
    kind: SessionKind,
) -> Result<SessionRecord, String> {
    let (local_port, requested) = ports::choose_local_port(request.local_port)?;
    let mut record = sessions::ssm::session_record(kind, &request, local_port, requested);
    if let Some(tunnel) = &mut record.tunnel {
        tunnel.allocation = if requested {
            PortAllocationSource::Requested
        } else {
            PortAllocationSource::Auto
        };
        tunnel.listener_status = TunnelListenerStatus::Active;
    }

    let args = sessions::ssm::build_port_forward_args(&request, local_port);
    state.diagnostics.push(
        crate::models::DiagnosticSeverity::Info,
        DiagnosticArea::Process,
        format!("Starting SSM tunnel on local port {local_port}"),
        None,
    );

    let mut registry = state
        .processes
        .lock()
        .map_err(|_| "Process registry is unavailable".to_string())?;
    registry.start_process("aws", &args, record, &state.diagnostics)
}
