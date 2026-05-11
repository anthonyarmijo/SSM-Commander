use crate::diagnostics::Diagnostics;
use crate::models::{DiagnosticArea, DiagnosticSeverity};
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const GUACD_HOST: &str = "127.0.0.1";
pub const GUACD_PORT: u16 = 4822;
const GUACD_START_TIMEOUT: Duration = Duration::from_secs(6);
const GUACD_PATH_ENV: &str = "SSM_COMMANDER_GUACD_PATH";
#[cfg(target_os = "macos")]
const OBJC_FORK_SAFETY_ENV: &str = "OBJC_DISABLE_INITIALIZE_FORK_SAFETY";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuacdReady {
    pub source: GuacdSource,
    pub version: Option<String>,
    pub port: u16,
}

impl GuacdReady {
    pub fn status_message(&self) -> String {
        match self.source {
            GuacdSource::ExistingBridge => {
                format!(
                    "Embedded RDP bridge is using guacd already listening on 127.0.0.1:{}.",
                    self.port
                )
            }
            GuacdSource::BundledSidecar => {
                format!(
                    "Embedded RDP bridge started bundled guacd on 127.0.0.1:{}.",
                    self.port
                )
            }
            GuacdSource::NativePath => {
                format!(
                    "Embedded RDP bridge started native guacd from PATH on 127.0.0.1:{}.",
                    self.port
                )
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuacdSource {
    ExistingBridge,
    BundledSidecar,
    NativePath,
}

#[derive(Default)]
pub struct GuacdSidecar {
    state: Mutex<GuacdSidecarState>,
}

#[derive(Default)]
struct GuacdSidecarState {
    owned_process: Option<Child>,
    ready: Option<GuacdReady>,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
enum GuacdSelection {
    ExistingBridge,
    Bundled(PathBuf),
    Native,
    Missing,
}

struct GuacdLaunchCandidate {
    command: PathBuf,
    source: GuacdSource,
    lib_dir: Option<PathBuf>,
    port: u16,
}

impl GuacdSidecar {
    pub fn ensure_ready(
        &self,
        app: &AppHandle,
        diagnostics: &Diagnostics,
    ) -> Result<GuacdReady, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "guacd sidecar state is unavailable".to_string())?;
        reap_finished_process(&mut state);
        if let (Some(_), Some(ready)) = (&state.owned_process, &state.ready) {
            if bridge_is_reachable_on(ready.port) {
                return Ok(ready.clone());
            }
        }

        let candidates = guacd_launch_candidates(app);
        if candidates.is_empty() && bridge_is_reachable() {
            let ready = GuacdReady {
                source: GuacdSource::ExistingBridge,
                version: native_guacd_version(),
                port: GUACD_PORT,
            };
            diagnostics.info(DiagnosticArea::Dependency, ready.status_message());
            return Ok(ready);
        }

        if candidates.is_empty() {
            return Err(
                "Embedded RDP requires guacd on 127.0.0.1:4822, a bundled guacd sidecar, or native guacd on PATH."
                    .to_string(),
            );
        }

        let mut last_error = None;
        for candidate in candidates {
            match start_guacd_candidate(candidate, diagnostics) {
                Ok((ready, child)) => {
                    state.ready = Some(ready.clone());
                    state.owned_process = Some(child);
                    return Ok(ready);
                }
                Err(error) => {
                    diagnostics.warning(
                        DiagnosticArea::Dependency,
                        format!("Could not start guacd candidate: {error}"),
                    );
                    last_error = Some(error);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            "Embedded RDP could not start a bundled or native guacd sidecar.".to_string()
        }))
    }

    pub fn stop_owned(&self, diagnostics: &Diagnostics) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(mut child) = state.owned_process.take() {
            match child.kill() {
                Ok(()) => {
                    let _ = child.wait();
                    diagnostics.info(
                        DiagnosticArea::Process,
                        "Stopped bundled/native guacd sidecar",
                    );
                }
                Err(error) => diagnostics.warning(
                    DiagnosticArea::Process,
                    format!("Could not stop guacd sidecar: {error}"),
                ),
            }
        }
        state.ready = None;
    }
}

fn reap_finished_process(state: &mut GuacdSidecarState) {
    if let Some(child) = &mut state.owned_process {
        if child.try_wait().ok().flatten().is_some() {
            state.owned_process = None;
            state.ready = None;
        }
    }
}

pub fn bridge_is_reachable() -> bool {
    bridge_is_reachable_on(GUACD_PORT)
}

pub fn bridge_is_reachable_on(port: u16) -> bool {
    TcpStream::connect((GUACD_HOST, port)).is_ok()
}

pub fn native_guacd_version() -> Option<String> {
    guacd_command_version(Path::new("guacd"))
}

pub fn bundled_guacd_version(app: &AppHandle) -> Option<String> {
    resolve_bundled_guacd(app).and_then(|(command, _)| guacd_command_version(&command))
}

fn guacd_command_version(command: &Path) -> Option<String> {
    let output = Command::new(command).arg("-v").output().ok()?;
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

fn guacd_launch_candidates(app: &AppHandle) -> Vec<GuacdLaunchCandidate> {
    let bundled = resolve_bundled_guacd(app).map(|(command, lib_dir)| GuacdLaunchCandidate {
        command,
        source: GuacdSource::BundledSidecar,
        lib_dir,
        port: allocate_guacd_port(),
    });
    let native = native_guacd_version().map(|_| GuacdLaunchCandidate {
        command: PathBuf::from("guacd"),
        source: GuacdSource::NativePath,
        lib_dir: None,
        port: allocate_guacd_port(),
    });

    [bundled, native].into_iter().flatten().collect()
}

fn allocate_guacd_port() -> u16 {
    TcpListener::bind((GUACD_HOST, 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|address| address.port()))
        .unwrap_or(GUACD_PORT)
}

fn resolve_bundled_guacd(app: &AppHandle) -> Option<(PathBuf, Option<PathBuf>)> {
    if let Some(path) = std::env::var_os(GUACD_PATH_ENV)
        .map(PathBuf::from)
        .filter(|path| path.exists())
    {
        return Some((path, resolve_resource_lib_dir(app)));
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let resource_dir = app.path().resource_dir().ok();
    let candidates = [
        exe_dir.as_ref().map(|dir| dir.join("guacd")),
        exe_dir
            .as_ref()
            .map(|dir| dir.join("guacd-aarch64-apple-darwin")),
        resource_dir.as_ref().map(|dir| dir.join("guacd")),
        resource_dir
            .as_ref()
            .map(|dir| dir.join("binaries").join("guacd")),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .map(|path| (path, resolve_resource_lib_dir(app)))
}

fn resolve_resource_lib_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|path| path.join("lib"))
        .filter(|path| path.exists())
}

fn start_guacd_candidate(
    candidate: GuacdLaunchCandidate,
    diagnostics: &Diagnostics,
) -> Result<(GuacdReady, Child), String> {
    let version = guacd_command_version(&candidate.command);
    let mut command = Command::new(&candidate.command);
    command
        .arg("-f")
        .arg("-L")
        .arg("debug")
        .arg("-b")
        .arg(GUACD_HOST)
        .arg("-l")
        .arg(candidate.port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "macos")]
    {
        // guacd forks per-connection workers; bundled FreeRDP dependencies can
        // touch Objective-C runtime state on macOS and trip fork-safety guards.
        command.env(OBJC_FORK_SAFETY_ENV, "YES");
    }

    if let Some(lib_dir) = candidate.lib_dir.as_ref() {
        command.current_dir(lib_dir);
        command.env("DYLD_LIBRARY_PATH", lib_dir);
        command.env("DYLD_FALLBACK_LIBRARY_PATH", lib_dir);
        command.env("GUACD_PLUGIN_DIR", lib_dir);
        command.env("GUACD_PLUGIN_PATH", lib_dir);
        command.env("FREERDP_PLUGIN_PATH", lib_dir);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Could not start {}: {error}",
            candidate.command.to_string_lossy()
        )
    })?;
    attach_guacd_logs(&mut child, diagnostics);

    let started_at = Instant::now();
    while started_at.elapsed() < GUACD_START_TIMEOUT {
        if bridge_is_reachable_on(candidate.port) {
            let ready = GuacdReady {
                source: candidate.source,
                version,
                port: candidate.port,
            };
            diagnostics.info(DiagnosticArea::Dependency, ready.status_message());
            return Ok((ready, child));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "guacd exited before listening on 127.0.0.1:{}: {status}",
                candidate.port
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = child.kill();
    let _ = child.wait();
    Err(format!(
        "Timed out waiting for guacd to listen on 127.0.0.1:{}.",
        candidate.port
    ))
}

fn attach_guacd_logs(child: &mut Child, diagnostics: &Diagnostics) {
    if let Some(stdout) = child.stdout.take() {
        let diagnostics = diagnostics.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                diagnostics.push(
                    DiagnosticSeverity::Info,
                    DiagnosticArea::Process,
                    format!("guacd: {line}"),
                    None,
                );
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let diagnostics = diagnostics.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                diagnostics.push(
                    DiagnosticSeverity::Warning,
                    DiagnosticArea::Process,
                    format!("guacd: {line}"),
                    None,
                );
            }
        });
    }
}

#[cfg(test)]
fn choose_guacd_source(
    bridge_reachable: bool,
    bundled_exists: bool,
    native_exists: bool,
) -> GuacdSelection {
    if bridge_reachable {
        GuacdSelection::ExistingBridge
    } else if bundled_exists {
        GuacdSelection::Bundled(PathBuf::from("guacd"))
    } else if native_exists {
        GuacdSelection::Native
    } else {
        GuacdSelection::Missing
    }
}

#[cfg(test)]
mod tests {
    use super::{choose_guacd_source, GuacdSelection};
    use std::path::PathBuf;

    #[test]
    fn reachable_bridge_wins_over_bundled_and_native_guacd() {
        assert_eq!(
            choose_guacd_source(true, true, true),
            GuacdSelection::ExistingBridge
        );
    }

    #[test]
    fn bundled_guacd_wins_when_bridge_is_absent() {
        assert_eq!(
            choose_guacd_source(false, true, true),
            GuacdSelection::Bundled(PathBuf::from("guacd"))
        );
    }

    #[test]
    fn native_guacd_is_used_only_when_bundled_is_missing() {
        assert_eq!(
            choose_guacd_source(false, false, true),
            GuacdSelection::Native
        );
    }

    #[test]
    fn missing_guacd_reports_no_selection() {
        assert_eq!(
            choose_guacd_source(false, false, false),
            GuacdSelection::Missing
        );
    }
}
