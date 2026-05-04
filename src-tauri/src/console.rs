use crate::diagnostics::Diagnostics;
use crate::models::{
    ConsoleOutputEvent, ConsoleRenderer, ConsoleSessionKind, ConsoleSessionRecord,
    ConsoleSessionRequest, DiagnosticArea, DiagnosticSeverity, SessionRecord, SessionStatus,
};
use chrono::Utc;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::{HeaderValue, StatusCode};
use tungstenite::{accept_hdr, Message};
use uuid::Uuid;

const CONSOLE_OUTPUT_EVENT: &str = "console-output";
const GUACD_HOST: &str = "127.0.0.1";
const GUACD_PORT: u16 = 4822;
const DEFAULT_RDP_TARGET_HOST: &str = "127.0.0.1";
const RDP_TARGET_HOST_ENV: &str = "SSM_COMMANDER_GUACD_RDP_HOST";
const RDP_BRIDGE_TOKEN_TTL: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct ConsoleRegistry {
    sessions: HashMap<String, ManagedConsoleSession>,
}

pub struct ManagedConsoleSession {
    record: ConsoleSessionRecord,
    tunnel_session_id: Option<String>,
    pty_child: Option<Box<dyn Child + Send>>,
    pty_master: Option<Box<dyn MasterPty + Send>>,
    pty_writer: Option<Box<dyn Write + Send>>,
}

impl ConsoleRegistry {
    pub fn insert(&mut self, session: ManagedConsoleSession) -> ConsoleSessionRecord {
        let record = session.record.clone();
        self.sessions.insert(record.id.clone(), session);
        record
    }

    pub fn list(&self) -> Vec<ConsoleSessionRecord> {
        let mut records = self
            .sessions
            .values()
            .map(|session| session.record.clone())
            .collect::<Vec<_>>();
        records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        records
    }

    pub fn write_input(&mut self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("No console session found for {session_id}"))?;
        let writer = session
            .pty_writer
            .as_mut()
            .ok_or_else(|| "This console session does not accept terminal input.".to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not write to console session: {error}"))
    }

    pub fn resize_terminal(
        &mut self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("No console session found for {session_id}"))?;
        let master = session
            .pty_master
            .as_mut()
            .ok_or_else(|| "This console session does not have a terminal renderer.".to_string())?;
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Could not resize console session: {error}"))
    }

    pub fn stop(
        &mut self,
        session_id: &str,
    ) -> Result<(ConsoleSessionRecord, Option<String>), String> {
        let mut session = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| format!("No console session found for {session_id}"))?;

        if let Some(mut child) = session.pty_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        session.record.status = SessionStatus::Stopped;
        Ok((session.record, session.tunnel_session_id))
    }

    pub fn stop_all(&mut self) -> Vec<String> {
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        let mut tunnel_ids = Vec::new();
        for id in ids {
            if let Ok((_, tunnel_id)) = self.stop(&id) {
                if let Some(tunnel_id) = tunnel_id {
                    tunnel_ids.push(tunnel_id);
                }
            }
        }
        tunnel_ids
    }
}

#[derive(Default, Clone)]
pub struct GuacamoleBridge {
    state: Arc<Mutex<GuacamoleBridgeState>>,
}

#[derive(Default)]
struct GuacamoleBridgeState {
    port: Option<u16>,
    connections: HashMap<String, RdpBridgeConfig>,
}

#[derive(Clone)]
struct RdpBridgeConfig {
    session_id: String,
    instance_id: String,
    hostname: String,
    local_port: u16,
    username: Option<String>,
    domain: Option<String>,
    password: Option<String>,
    security_mode: RdpSecurityMode,
    width: u32,
    height: u32,
    guacd_version: Option<String>,
    expires_at: Instant,
    diagnostics: Diagnostics,
}

#[derive(Debug, PartialEq, Eq)]
struct RdpCredentials {
    username: Option<String>,
    domain: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RdpSecurityMode {
    Auto,
    Nla,
    NlaExt,
    Tls,
    Rdp,
}

impl GuacamoleBridge {
    pub fn register_rdp_connection(
        &self,
        session_id: String,
        instance_id: String,
        local_port: u16,
        username: Option<String>,
        password: Option<String>,
        security_mode: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
        diagnostics: Diagnostics,
    ) -> Result<(String, String), String> {
        let listener_port = self.ensure_listener()?;
        let token = Uuid::new_v4().to_string();
        let credentials = normalize_rdp_credentials(username);
        let security_mode = normalize_rdp_security_mode(security_mode);
        let config = RdpBridgeConfig {
            session_id,
            instance_id,
            hostname: configured_rdp_target_host(),
            local_port,
            username: credentials.username,
            domain: credentials.domain,
            password,
            security_mode,
            width: width.unwrap_or(1280).max(640),
            height: height.unwrap_or(720).max(480),
            guacd_version: guacd_version(),
            expires_at: Instant::now() + RDP_BRIDGE_TOKEN_TTL,
            diagnostics,
        };

        config.diagnostics.info(
            DiagnosticArea::Launcher,
            rdp_bridge_diagnostic_message(&config),
        );

        let mut state = self
            .state
            .lock()
            .map_err(|_| "Guacamole bridge state is unavailable".to_string())?;
        prune_expired_connections(&mut state);
        state.connections.insert(token.clone(), config);

        Ok((format!("ws://127.0.0.1:{listener_port}/rdp"), token))
    }

    pub fn remove_connection(&self, token: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.connections.remove(token);
        }
    }

    pub fn clear_connections(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.connections.clear();
        }
    }

    fn ensure_listener(&self) -> Result<u16, String> {
        if let Some(port) = self
            .state
            .lock()
            .map_err(|_| "Guacamole bridge state is unavailable".to_string())?
            .port
        {
            return Ok(port);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("Could not start local Guacamole bridge: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Could not resolve Guacamole bridge address: {error}"))?
            .port();
        let state = self.state.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = state.clone();
                thread::spawn(move || {
                    let _ = handle_guacamole_websocket(stream, state);
                });
            }
        });

        let mut state = self
            .state
            .lock()
            .map_err(|_| "Guacamole bridge state is unavailable".to_string())?;
        state.port = Some(port);
        Ok(port)
    }
}

pub fn guacd_is_available() -> bool {
    guacd_version().is_some() || TcpStream::connect((GUACD_HOST, GUACD_PORT)).is_ok()
}

fn guacd_version() -> Option<String> {
    let output = std::process::Command::new("guacd")
        .arg("-v")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        Some("available".to_string())
    } else {
        Some(version)
    }
}

pub fn ssh_command_args(username: &str, port: u16, key_path: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        port.to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=no".to_string(),
        "-o".to_string(),
        "UserKnownHostsFile=/dev/null".to_string(),
    ];

    if let Some(key_path) = key_path.filter(|value| !value.trim().is_empty()) {
        args.push("-i".to_string());
        args.push(key_path.to_string());
    }

    args.push(format!("{username}@127.0.0.1"));
    args
}

pub fn ssh_console_session(
    app: AppHandle,
    request: &ConsoleSessionRequest,
    tunnel_record: SessionRecord,
) -> Result<ManagedConsoleSession, String> {
    let id = Uuid::new_v4().to_string();
    let port = tunnel_record
        .tunnel
        .as_ref()
        .map(|tunnel| tunnel.local_port)
        .ok_or_else(|| "SSH tunnel was not created".to_string())?;
    let username = request.username.as_deref().unwrap_or("ec2-user");
    let rows = request.terminal_rows.unwrap_or(28).max(1);
    let cols = request.terminal_cols.unwrap_or(100).max(1);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open embedded terminal: {error}"))?;

    let mut command = CommandBuilder::new("ssh");
    for arg in ssh_command_args(username, port, request.ssh_key_path.as_deref()) {
        command.arg(arg);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start embedded SSH: {error}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not read embedded SSH output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not write embedded SSH input: {error}"))?;
    drop(pair.slave);

    let event_session_id = id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let _ = app.emit(
                        CONSOLE_OUTPUT_EVENT,
                        ConsoleOutputEvent {
                            session_id: event_session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    let record = ConsoleSessionRecord {
        id,
        kind: ConsoleSessionKind::Ssh,
        renderer: ConsoleRenderer::Xterm,
        profile: request.profile.clone(),
        region: request.region.clone(),
        instance_id: request.instance_id.clone(),
        started_at: Utc::now().to_rfc3339(),
        status: SessionStatus::Active,
        title: format!("SSH {}", request.instance_id),
        tunnel: tunnel_record.tunnel.clone(),
        bridge_url: None,
        connection_token: None,
        message: None,
    };

    Ok(ManagedConsoleSession {
        record,
        tunnel_session_id: Some(tunnel_record.id),
        pty_child: Some(child),
        pty_master: Some(pair.master),
        pty_writer: Some(writer),
    })
}

pub fn shell_console_session(
    app: AppHandle,
    request: &ConsoleSessionRequest,
) -> Result<ManagedConsoleSession, String> {
    let id = Uuid::new_v4().to_string();
    let rows = request.terminal_rows.unwrap_or(28).max(1);
    let cols = request.terminal_cols.unwrap_or(100).max(1);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open embedded terminal: {error}"))?;

    let mut command = CommandBuilder::new("aws");
    for arg in ssm_shell_command_args(&request.profile, &request.region, &request.instance_id) {
        command.arg(arg);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start embedded SSM shell: {error}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not read embedded SSM shell output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not write embedded SSM shell input: {error}"))?;
    drop(pair.slave);

    let event_session_id = id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let _ = app.emit(
                        CONSOLE_OUTPUT_EVENT,
                        ConsoleOutputEvent {
                            session_id: event_session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    let record = ConsoleSessionRecord {
        id,
        kind: ConsoleSessionKind::Shell,
        renderer: ConsoleRenderer::Xterm,
        profile: request.profile.clone(),
        region: request.region.clone(),
        instance_id: request.instance_id.clone(),
        started_at: Utc::now().to_rfc3339(),
        status: SessionStatus::Active,
        title: format!("SSM {}", request.instance_id),
        tunnel: None,
        bridge_url: None,
        connection_token: None,
        message: None,
    };

    Ok(ManagedConsoleSession {
        record,
        tunnel_session_id: None,
        pty_child: Some(child),
        pty_master: Some(pair.master),
        pty_writer: Some(writer),
    })
}

fn ssm_shell_command_args(profile: &str, region: &str, instance_id: &str) -> Vec<String> {
    vec![
        "ssm".to_string(),
        "start-session".to_string(),
        "--target".to_string(),
        instance_id.to_string(),
        "--profile".to_string(),
        profile.to_string(),
        "--region".to_string(),
        region.to_string(),
    ]
}

pub fn rdp_console_session(
    request: &ConsoleSessionRequest,
    tunnel_record: SessionRecord,
    bridge: &GuacamoleBridge,
    diagnostics: &Diagnostics,
) -> Result<ManagedConsoleSession, String> {
    let id = Uuid::new_v4().to_string();
    let port = tunnel_record
        .tunnel
        .as_ref()
        .map(|tunnel| tunnel.local_port)
        .ok_or_else(|| "RDP tunnel was not created".to_string())?;

    let (status, bridge_url, connection_token, message) = if guacd_is_available() {
        match bridge.register_rdp_connection(
            id.clone(),
            request.instance_id.clone(),
            port,
            request
                .rdp_username
                .clone()
                .or_else(|| request.username.clone()),
            request.rdp_password.clone(),
            request.rdp_security_mode.clone(),
            request.width,
            request.height,
            diagnostics.clone(),
        ) {
            Ok((url, token)) => (
                SessionStatus::Active,
                Some(url),
                Some(token),
                Some("Embedded RDP bridge connected to local guacd.".to_string()),
            ),
            Err(error) => (SessionStatus::Failed, None, None, Some(error)),
        }
    } else {
        diagnostics.push(
            DiagnosticSeverity::Warning,
            DiagnosticArea::Dependency,
            "Embedded RDP requires guacd on 127.0.0.1:4822 or a bundled guacd sidecar.".to_string(),
            None,
        );
        (
            SessionStatus::Failed,
            None,
            None,
            Some(
                "Embedded RDP requires guacd on 127.0.0.1:4822 or a bundled guacd sidecar."
                    .to_string(),
            ),
        )
    };

    let record = ConsoleSessionRecord {
        id,
        kind: ConsoleSessionKind::Rdp,
        renderer: ConsoleRenderer::Guacamole,
        profile: request.profile.clone(),
        region: request.region.clone(),
        instance_id: request.instance_id.clone(),
        started_at: Utc::now().to_rfc3339(),
        status,
        title: format!("RDP {}", request.instance_id),
        tunnel: tunnel_record.tunnel.clone(),
        bridge_url,
        connection_token,
        message,
    };

    Ok(ManagedConsoleSession {
        record,
        tunnel_session_id: Some(tunnel_record.id),
        pty_child: None,
        pty_master: None,
        pty_writer: None,
    })
}

pub fn failed_rdp_console_session(
    request: &ConsoleSessionRequest,
    message: String,
) -> ManagedConsoleSession {
    let record = ConsoleSessionRecord {
        id: Uuid::new_v4().to_string(),
        kind: ConsoleSessionKind::Rdp,
        renderer: ConsoleRenderer::Guacamole,
        profile: request.profile.clone(),
        region: request.region.clone(),
        instance_id: request.instance_id.clone(),
        started_at: Utc::now().to_rfc3339(),
        status: SessionStatus::Failed,
        title: format!("RDP {}", request.instance_id),
        tunnel: None,
        bridge_url: None,
        connection_token: None,
        message: Some(message),
    };

    ManagedConsoleSession {
        record,
        tunnel_session_id: None,
        pty_child: None,
        pty_master: None,
        pty_writer: None,
    }
}

fn handle_guacamole_websocket(
    stream: TcpStream,
    state: Arc<Mutex<GuacamoleBridgeState>>,
) -> Result<(), String> {
    let selected_token = Arc::new(Mutex::new(None::<String>));
    let callback_token = selected_token.clone();
    let mut websocket = accept_hdr(stream, |request: &Request, mut response: Response| {
        let token = validate_guacamole_request(request).map_err(forbidden_response)?;
        if let Ok(mut selected) = callback_token.lock() {
            *selected = Some(token);
        }
        response.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static("guacamole"),
        );
        Ok(response)
    })
    .map_err(|error| format!("Could not accept Guacamole WebSocket: {error}"))?;

    let token = selected_token
        .lock()
        .map_err(|_| "Guacamole bridge token lock failed".to_string())?
        .clone()
        .ok_or_else(|| "Guacamole bridge request did not include a token".to_string())?;

    let config = {
        let mut bridge_state = state
            .lock()
            .map_err(|_| "Guacamole bridge state is unavailable".to_string())?;
        prune_expired_connections(&mut bridge_state);
        let config = bridge_state
            .connections
            .remove(&token)
            .ok_or_else(|| "Guacamole bridge token is not active".to_string())?;
        if config.expires_at < Instant::now() {
            return Err("Guacamole bridge token expired".to_string());
        }
        config
    };

    let mut guacd = TcpStream::connect((GUACD_HOST, GUACD_PORT))
        .map_err(|error| format!("Could not connect to guacd: {error}"))?;
    if let Err(error) = start_guacd_rdp(&mut guacd, &config) {
        config.diagnostics.warning(
            DiagnosticArea::Launcher,
            format!(
                "Embedded RDP guacd connection failed: {}: {}",
                rdp_bridge_diagnostic_message(&config),
                error,
            ),
        );
        return Err(error);
    }

    let uuid_instruction = encode_instruction("", &[Uuid::new_v4().to_string()]);
    websocket
        .send(Message::Text(uuid_instruction.into()))
        .map_err(|error| format!("Could not initialize Guacamole tunnel: {error}"))?;

    guacd
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure guacd stream: {error}"))?;
    websocket
        .get_mut()
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure Guacamole WebSocket: {error}"))?;

    let mut buffer = [0_u8; 8192];
    loop {
        match guacd.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let payload = String::from_utf8_lossy(&buffer[..read]).to_string();
                if payload.contains(".error") || payload.to_lowercase().contains("wrong security") {
                    config.diagnostics.warning(
                        DiagnosticArea::Launcher,
                        format!(
                            "Embedded RDP guacd reported: {}: {}",
                            rdp_bridge_diagnostic_message(&config),
                            payload
                        ),
                    );
                }
                if websocket.send(Message::Text(payload.into())).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => {
                config.diagnostics.warning(
                    DiagnosticArea::Launcher,
                    format!(
                        "Embedded RDP guacd stream ended for sessionId={}, instanceId={}: {}",
                        config.session_id, config.instance_id, error
                    ),
                );
                break;
            }
        }

        match websocket.read() {
            Ok(Message::Text(text)) => {
                for instruction in split_instruction_stream(text.as_ref()) {
                    if should_forward_client_instruction(instruction) {
                        let _ = guacd.write_all(instruction.as_bytes());
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => {
                config.diagnostics.warning(
                    DiagnosticArea::Launcher,
                    format!(
                        "Embedded RDP WebSocket stream ended for sessionId={}, instanceId={}: {}",
                        config.session_id, config.instance_id, error
                    ),
                );
                break;
            }
        }

        thread::sleep(Duration::from_millis(8));
    }

    let _ = guacd.write_all(encode_instruction("disconnect", &[]).as_bytes());
    Ok(())
}

fn validate_guacamole_request(request: &Request) -> Result<String, String> {
    if request.uri().path() != "/rdp" {
        return Err("Unsupported Guacamole bridge path".to_string());
    }

    let token = request
        .uri()
        .query()
        .and_then(|query| query_value(query, "token"))
        .filter(|token| {
            (16..=128).contains(&token.len())
                && token
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        })
        .ok_or_else(|| "Guacamole bridge request did not include a valid token".to_string())?;

    let requested_protocol = request
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|header| header.to_str().ok())
        .unwrap_or_default();
    if !requested_protocol
        .split(',')
        .any(|protocol| protocol.trim().eq_ignore_ascii_case("guacamole"))
    {
        return Err("Guacamole bridge request did not request the guacamole protocol".to_string());
    }

    if let Some(origin) = request
        .headers()
        .get("Origin")
        .and_then(|header| header.to_str().ok())
    {
        if !is_allowed_local_origin(origin) {
            return Err("Guacamole bridge origin is not allowed".to_string());
        }
    }

    Ok(token)
}

fn forbidden_response(message: String) -> ErrorResponse {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(Some(message))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Some("Forbidden".to_string()))
                .expect("static forbidden response should be valid")
        })
}

fn is_allowed_local_origin(origin: &str) -> bool {
    origin == "null"
        || origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || origin.starts_with("http://localhost:")
        || origin.starts_with("https://localhost:")
        || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("https://127.0.0.1:")
        || origin.starts_with("http://[::1]:")
        || origin.starts_with("https://[::1]:")
}

fn prune_expired_connections(state: &mut GuacamoleBridgeState) {
    let now = Instant::now();
    state
        .connections
        .retain(|_, config| config.expires_at >= now);
}

fn normalize_rdp_credentials(username: Option<String>) -> RdpCredentials {
    let Some(raw_username) = username else {
        return RdpCredentials {
            username: None,
            domain: None,
        };
    };
    let trimmed = raw_username.trim();
    if trimmed.is_empty() {
        return RdpCredentials {
            username: None,
            domain: None,
        };
    }

    if let Some((domain, user)) = trimmed.split_once('\\') {
        let domain = domain.trim();
        let user = user.trim();
        if !domain.is_empty() && !user.is_empty() {
            return RdpCredentials {
                username: Some(user.to_string()),
                domain: Some(domain.to_string()),
            };
        }
    }

    RdpCredentials {
        username: Some(trimmed.to_string()),
        domain: None,
    }
}

fn normalize_rdp_security_mode(value: Option<String>) -> RdpSecurityMode {
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("nla") => RdpSecurityMode::Nla,
        Some("nla-ext") | Some("nla_ext") | Some("nlaext") => RdpSecurityMode::NlaExt,
        Some("tls") => RdpSecurityMode::Tls,
        Some("rdp") => RdpSecurityMode::Rdp,
        _ => RdpSecurityMode::Auto,
    }
}

fn rdp_security_value(mode: RdpSecurityMode) -> &'static str {
    match mode {
        RdpSecurityMode::Auto => "any",
        RdpSecurityMode::Nla => "nla",
        RdpSecurityMode::NlaExt => "nla-ext",
        RdpSecurityMode::Tls => "tls",
        RdpSecurityMode::Rdp => "rdp",
    }
}

fn rdp_security_label(mode: RdpSecurityMode) -> &'static str {
    match mode {
        RdpSecurityMode::Auto => "auto",
        RdpSecurityMode::Nla => "nla",
        RdpSecurityMode::NlaExt => "nla-ext",
        RdpSecurityMode::Tls => "tls",
        RdpSecurityMode::Rdp => "rdp",
    }
}

fn normalize_rdp_target_host(value: Option<String>) -> String {
    value
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_RDP_TARGET_HOST)
        .to_string()
}

fn configured_rdp_target_host() -> String {
    normalize_rdp_target_host(std::env::var(RDP_TARGET_HOST_ENV).ok())
}

fn rdp_bridge_diagnostic_message(config: &RdpBridgeConfig) -> String {
    format!(
        "Embedded RDP bridge parameters: sessionId={}, instanceId={}, rdpHost={}, rdpPort={}, username={}, domain={}, securityMode={}, guacd={}.",
        config.session_id,
        config.instance_id,
        config.hostname,
        config.local_port,
        if config.username.as_deref().is_some_and(|value| !value.trim().is_empty()) {
            "provided"
        } else {
            "missing"
        },
        if config.domain.as_deref().is_some_and(|value| !value.trim().is_empty()) {
            "provided"
        } else {
            "missing"
        },
        rdp_security_label(config.security_mode),
        config.guacd_version.as_deref().unwrap_or("unavailable"),
    )
}

fn guacd_rdp_parameter_value(arg: &str, config: &RdpBridgeConfig) -> String {
    match arg {
        "hostname" => config.hostname.clone(),
        "port" => config.local_port.to_string(),
        "username" => config.username.clone().unwrap_or_default(),
        "domain" => config.domain.clone().unwrap_or_default(),
        "password" => config.password.clone().unwrap_or_default(),
        "ignore-cert" => "true".to_string(),
        "security" => rdp_security_value(config.security_mode).to_string(),
        "resize-method" => "display-update".to_string(),
        "enable-wallpaper" => "false".to_string(),
        "enable-theming" => "false".to_string(),
        _ => String::new(),
    }
}

fn start_guacd_rdp(stream: &mut TcpStream, config: &RdpBridgeConfig) -> Result<(), String> {
    stream
        .write_all(encode_instruction("select", &["rdp".to_string()]).as_bytes())
        .map_err(|error| format!("Could not select RDP protocol: {error}"))?;
    let (opcode, args) = read_instruction(stream)?;
    if opcode != "args" {
        return Err(format!(
            "Expected guacd args instruction, received {opcode}"
        ));
    }

    stream
        .write_all(
            encode_instruction(
                "size",
                &[
                    config.width.to_string(),
                    config.height.to_string(),
                    "96".to_string(),
                ],
            )
            .as_bytes(),
        )
        .map_err(|error| format!("Could not send RDP display size: {error}"))?;
    stream
        .write_all(encode_instruction("audio", &[]).as_bytes())
        .map_err(|error| format!("Could not send RDP audio capabilities: {error}"))?;
    stream
        .write_all(encode_instruction("video", &[]).as_bytes())
        .map_err(|error| format!("Could not send RDP video capabilities: {error}"))?;
    stream
        .write_all(
            encode_instruction(
                "image",
                &["image/png".to_string(), "image/jpeg".to_string()],
            )
            .as_bytes(),
        )
        .map_err(|error| format!("Could not send RDP image capabilities: {error}"))?;

    let values = args
        .iter()
        .map(|arg| guacd_rdp_parameter_value(arg, config))
        .collect::<Vec<_>>();

    stream
        .write_all(encode_instruction("connect", &values).as_bytes())
        .map_err(|error| format!("Could not connect guacd RDP session: {error}"))?;
    Ok(())
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn should_forward_client_instruction(instruction: &str) -> bool {
    !instruction.starts_with("0.,") && !instruction.is_empty()
}

fn split_instruction_stream(input: &str) -> Vec<&str> {
    let mut instructions = Vec::new();
    let mut start = 0;
    for (index, character) in input.char_indices() {
        if character == ';' {
            instructions.push(&input[start..=index]);
            start = index + 1;
        }
    }
    instructions
}

fn encode_instruction(opcode: &str, args: &[String]) -> String {
    let mut elements = Vec::with_capacity(args.len() + 1);
    elements.push(opcode.to_string());
    elements.extend(args.iter().cloned());
    let encoded = elements
        .iter()
        .map(|element| format!("{}.{}", element.len(), element))
        .collect::<Vec<_>>()
        .join(",");
    format!("{encoded};")
}

fn read_instruction(stream: &mut TcpStream) -> Result<(String, Vec<String>), String> {
    let mut data = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        stream
            .read_exact(&mut byte)
            .map_err(|error| format!("Could not read guacd instruction: {error}"))?;
        data.push(byte[0]);
        if byte[0] == b';' {
            break;
        }
    }
    parse_instruction(&String::from_utf8_lossy(&data))
}

fn parse_instruction(input: &str) -> Result<(String, Vec<String>), String> {
    let mut elements = Vec::new();
    let mut index = 0;
    let bytes = input.as_bytes();
    while index < bytes.len() {
        let dot_offset = input[index..]
            .find('.')
            .ok_or_else(|| "Malformed Guacamole instruction length".to_string())?;
        let dot = index + dot_offset;
        let length = input[index..dot]
            .parse::<usize>()
            .map_err(|error| format!("Malformed Guacamole element length: {error}"))?;
        let value_start = dot + 1;
        let value_end = value_start + length;
        if value_end > input.len() {
            return Err("Guacamole instruction element is truncated".to_string());
        }
        elements.push(input[value_start..value_end].to_string());
        let delimiter = input.as_bytes().get(value_end).copied().unwrap_or(b';');
        index = value_end + 1;
        if delimiter == b';' {
            break;
        }
    }

    let opcode = elements
        .first()
        .cloned()
        .ok_or_else(|| "Guacamole instruction was empty".to_string())?;
    Ok((opcode, elements.into_iter().skip(1).collect()))
}

#[cfg(test)]
mod tests {
    use super::{
        encode_instruction, guacd_rdp_parameter_value, normalize_rdp_credentials,
        normalize_rdp_security_mode, normalize_rdp_target_host, parse_instruction,
        rdp_bridge_diagnostic_message, rdp_security_value, ssh_command_args,
        validate_guacamole_request, GuacamoleBridge, RdpBridgeConfig, RdpCredentials,
        RdpSecurityMode,
    };
    use crate::diagnostics::Diagnostics;
    use std::time::{Duration, Instant};
    use tungstenite::handshake::server::Request;

    #[test]
    fn builds_ssh_args_without_credentials_in_logs() {
        let args = ssh_command_args("ec2-user", 22022, Some("/tmp/key.pem"));

        assert_eq!(args[0], "-p");
        assert!(args.contains(&"22022".to_string()));
        assert!(args.contains(&"/tmp/key.pem".to_string()));
        assert!(args.contains(&"ec2-user@127.0.0.1".to_string()));
    }

    #[test]
    fn encodes_and_parses_guacamole_instruction() {
        let encoded = encode_instruction("select", &["rdp".to_string()]);
        assert_eq!(encoded, "6.select,3.rdp;");
        assert_eq!(
            parse_instruction(&encoded).unwrap(),
            ("select".to_string(), vec!["rdp".to_string()])
        );
    }

    #[test]
    fn splits_windows_domain_qualified_rdp_username() {
        assert_eq!(
            normalize_rdp_credentials(Some("cyber\\pkiadmin".to_string())),
            RdpCredentials {
                username: Some("pkiadmin".to_string()),
                domain: Some("cyber".to_string()),
            }
        );
    }

    #[test]
    fn leaves_plain_rdp_username_without_domain() {
        assert_eq!(
            normalize_rdp_credentials(Some("pkiadmin".to_string())),
            RdpCredentials {
                username: Some("pkiadmin".to_string()),
                domain: None,
            }
        );
    }

    #[test]
    fn passes_guacd_any_security_for_auto_rdp_mode() {
        let config = rdp_config(
            Some("pkiadmin"),
            Some("cyber"),
            Some("secret"),
            RdpSecurityMode::Auto,
        );

        assert_eq!(guacd_rdp_parameter_value("domain", &config), "cyber");
        assert_eq!(guacd_rdp_parameter_value("security", &config), "any");
    }

    #[test]
    fn passes_explicit_rdp_security_modes_to_guacd() {
        for (mode, expected) in [
            (RdpSecurityMode::Nla, "nla"),
            (RdpSecurityMode::NlaExt, "nla-ext"),
            (RdpSecurityMode::Tls, "tls"),
            (RdpSecurityMode::Rdp, "rdp"),
        ] {
            let config = rdp_config(Some("pkiadmin"), Some("cyber"), Some("secret"), mode);

            assert_eq!(rdp_security_value(mode), expected);
            assert_eq!(guacd_rdp_parameter_value("security", &config), expected);
        }
    }

    #[test]
    fn normalizes_unknown_rdp_security_mode_to_auto() {
        assert_eq!(
            normalize_rdp_security_mode(Some("surprise".to_string())),
            RdpSecurityMode::Auto
        );
    }

    #[test]
    fn omits_password_from_rdp_diagnostics() {
        let config = rdp_config(
            Some("pkiadmin"),
            Some("cyber"),
            Some("super-secret-password"),
            RdpSecurityMode::Tls,
        );
        let message = rdp_bridge_diagnostic_message(&config);

        assert!(message.contains("username=provided"));
        assert!(message.contains("domain=provided"));
        assert!(message.contains("rdpHost=127.0.0.1"));
        assert!(message.contains("rdpPort=3390"));
        assert!(message.contains("securityMode=tls"));
        assert!(message.contains("guacd=guacd 1.6.0"));
        assert!(!message.contains("super-secret-password"));
    }

    #[test]
    fn uses_configured_rdp_target_host_for_docker_guacd() {
        assert_eq!(
            normalize_rdp_target_host(Some(" host.docker.internal ".to_string())),
            "host.docker.internal"
        );
        assert_eq!(
            normalize_rdp_target_host(Some(" ".to_string())),
            "127.0.0.1"
        );
        let config = rdp_config_with_host(
            "host.docker.internal",
            Some("pkiadmin"),
            Some("cyber"),
            Some("secret"),
            RdpSecurityMode::Auto,
        );

        assert_eq!(
            guacd_rdp_parameter_value("hostname", &config),
            "host.docker.internal"
        );
    }

    #[test]
    fn validates_local_guacamole_websocket_requests() {
        let token = "demo-token-bridge";
        let request = guacamole_request(&format!("/rdp?token={token}"), "http://127.0.0.1:1420");

        assert_eq!(validate_guacamole_request(&request).unwrap(), token);
    }

    #[test]
    fn rejects_non_local_guacamole_websocket_origins() {
        let request = guacamole_request("/rdp?token=demo-token-bridge", "https://example.com");

        assert!(validate_guacamole_request(&request).is_err());
    }

    #[test]
    fn removes_rdp_bridge_config_after_session_cleanup() {
        let bridge = GuacamoleBridge::default();
        let (_, token) = bridge
            .register_rdp_connection(
                "test-session".to_string(),
                "i-test".to_string(),
                3390,
                Some("demo".to_string()),
                Some("secret".to_string()),
                Some("tls".to_string()),
                None,
                None,
                Diagnostics::default(),
            )
            .unwrap();

        assert!(bridge
            .state
            .lock()
            .unwrap()
            .connections
            .contains_key(&token));
        bridge.remove_connection(&token);
        assert!(!bridge
            .state
            .lock()
            .unwrap()
            .connections
            .contains_key(&token));
    }

    fn guacamole_request(uri: &str, origin: &str) -> Request {
        Request::builder()
            .uri(uri)
            .header("Origin", origin)
            .header("Sec-WebSocket-Protocol", "guacamole")
            .body(())
            .unwrap()
    }

    fn rdp_config(
        username: Option<&str>,
        domain: Option<&str>,
        password: Option<&str>,
        security_mode: RdpSecurityMode,
    ) -> RdpBridgeConfig {
        RdpBridgeConfig {
            session_id: "test-session".to_string(),
            instance_id: "i-test".to_string(),
            hostname: "127.0.0.1".to_string(),
            local_port: 3390,
            username: username.map(str::to_string),
            domain: domain.map(str::to_string),
            password: password.map(str::to_string),
            security_mode,
            width: 1280,
            height: 720,
            guacd_version: Some("guacd 1.6.0".to_string()),
            expires_at: Instant::now() + Duration::from_secs(60),
            diagnostics: Diagnostics::default(),
        }
    }

    fn rdp_config_with_host(
        hostname: &str,
        username: Option<&str>,
        domain: Option<&str>,
        password: Option<&str>,
        security_mode: RdpSecurityMode,
    ) -> RdpBridgeConfig {
        RdpBridgeConfig {
            hostname: hostname.to_string(),
            ..rdp_config(username, domain, password, security_mode)
        }
    }
}
