mod aws_cli;
mod commands;
mod console;
mod dependencies;
mod diagnostics;
mod models;
mod platform;
mod ports;
mod preferences;
mod process_registry;
mod sessions;

use console::{ConsoleRegistry, GuacamoleBridge};
use diagnostics::Diagnostics;
use models::SsoLoginAttempt;
use process_registry::ProcessRegistry;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    diagnostics: Diagnostics,
    processes: Mutex<ProcessRegistry>,
    consoles: Mutex<ConsoleRegistry>,
    guacamole_bridge: GuacamoleBridge,
    sso_login_attempts: Mutex<HashMap<String, SsoLoginAttempt>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            diagnostics: Diagnostics::default(),
            processes: Mutex::new(ProcessRegistry::default()),
            consoles: Mutex::new(ConsoleRegistry::default()),
            guacamole_bridge: GuacamoleBridge::default(),
            sso_login_attempts: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::check_environment,
            commands::list_profiles,
            commands::validate_profile,
            commands::probe_profile_capabilities,
            commands::list_regions,
            commands::start_sso_login,
            commands::get_sso_login_attempt,
            commands::load_preferences,
            commands::save_preferences,
            commands::discover_instances,
            commands::get_ssm_readiness,
            commands::start_instances,
            commands::stop_instances,
            commands::start_shell_session,
            commands::start_port_forward,
            commands::start_rdp_session,
            commands::start_ssh_session,
            commands::start_console_session,
            commands::stop_console_session,
            commands::list_console_sessions,
            commands::write_console_input,
            commands::resize_console_terminal,
            commands::stop_session,
            commands::list_active_sessions,
            commands::get_diagnostics,
            commands::open_logs_folder
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<AppState>() {
                    let tunnel_ids = if let Ok(mut consoles) = state.consoles.lock() {
                        consoles.stop_all()
                    } else {
                        Vec::new()
                    };
                    state.guacamole_bridge.clear_connections();
                    if let Ok(mut registry) = state.processes.lock() {
                        for tunnel_id in tunnel_ids {
                            let _ = registry.stop_session(&tunnel_id, &state.diagnostics);
                        }
                        registry.stop_all(&state.diagnostics);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SSM Commander");
}
