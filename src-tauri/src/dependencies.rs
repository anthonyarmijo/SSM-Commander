use crate::models::{DependencyCheck, DependencyStatus, EnvironmentState, EnvironmentStatus};
use crate::{aws_cli, guacd};
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

pub fn check_environment(app: &AppHandle) -> EnvironmentState {
    let openssh_install_url = if cfg!(target_os = "windows") {
        "https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview"
    } else {
        "https://www.openssh.com/portable.html"
    };
    let mut checks = vec![
        check_tool(
            "AWS CLI",
            "aws",
            &["--version"],
            true,
            "Install AWS CLI v2 and configure at least one profile.",
            Some("https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"),
            Some("AWS install guide"),
        ),
        check_tool(
            "Session Manager Plugin",
            "session-manager-plugin",
            &["--version"],
            true,
            "Install the AWS Session Manager Plugin for CLI-based SSM sessions.",
            Some(
                "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html",
            ),
            Some("AWS plugin guide"),
        ),
        check_tool(
            "OpenSSH",
            "ssh",
            &["-V"],
            false,
            "Install OpenSSH to use embedded SSH console tabs.",
            Some(openssh_install_url),
            Some("OpenSSH instructions"),
        ),
        DependencyCheck {
            name: "Embedded terminal PTY".to_string(),
            command: "portable-pty".to_string(),
            status: DependencyStatus::Present,
            version: Some("bundled".to_string()),
            required: false,
            message: "Built into SSM Commander".to_string(),
            remediation: None,
            install_url: None,
            install_label: None,
        },
        check_guacd_bridge(app),
    ];

    if cfg!(debug_assertions) {
        checks.push(check_tool(
            "Rust toolchain",
            "cargo",
            &["--version"],
            false,
            "Install Rust with rustup when building or packaging the app locally.",
            Some("https://www.rust-lang.org/tools/install"),
            Some("Rust install guide"),
        ));
    }

    if cfg!(target_os = "windows") {
        checks.push(check_tool(
            "Windows Remote Desktop",
            "mstsc.exe",
            &[],
            false,
            "Enable or install Remote Desktop Client for external RDP fallback.",
            Some("https://support.microsoft.com/en-us/windows/how-to-use-remote-desktop-5fe128d5-8fb1-7a23-3b8a-41e636865e8c"),
            Some("Microsoft instructions"),
        ));
    } else if cfg!(target_os = "macos") {
        checks.push(check_tool(
            "FreeRDP",
            "xfreerdp",
            &["/version"],
            false,
            "Install FreeRDP only if you want external RDP fallback.",
            Some("https://github.com/FreeRDP/FreeRDP/wiki/Compilation"),
            Some("FreeRDP install guide"),
        ));
    }

    let has_missing_required = checks
        .iter()
        .any(|check| check.required && matches!(check.status, DependencyStatus::Missing));
    let has_warnings = checks.iter().any(|check| {
        matches!(
            check.status,
            DependencyStatus::Missing | DependencyStatus::Warning
        )
    });

    let status = if has_missing_required {
        EnvironmentStatus::Blocked
    } else if has_warnings {
        EnvironmentStatus::Warning
    } else {
        EnvironmentStatus::Ready
    };

    EnvironmentState {
        status,
        platform: std::env::consts::OS.to_string(),
        checks,
    }
}

fn check_guacd_bridge(app: &AppHandle) -> DependencyCheck {
    if let Some(version) = guacd::bundled_guacd_version(app) {
        return DependencyCheck {
            name: "Guacamole RDP bridge".to_string(),
            command: "guacd".to_string(),
            status: DependencyStatus::Present,
            version: Some(version),
            required: false,
            message: "Bundled sidecar available; starts on demand".to_string(),
            remediation: None,
            install_url: None,
            install_label: None,
        };
    }

    if guacd::bridge_is_reachable() {
        return DependencyCheck {
            name: "Guacamole RDP bridge".to_string(),
            command: "guacd".to_string(),
            status: DependencyStatus::Present,
            version: Some("listening on 127.0.0.1:4822".to_string()),
            required: false,
            message: "Detected local bridge".to_string(),
            remediation: None,
            install_url: None,
            install_label: None,
        };
    }

    if let Some(version) = guacd::native_guacd_version() {
        return DependencyCheck {
            name: "Guacamole RDP bridge".to_string(),
            command: "guacd".to_string(),
            status: DependencyStatus::Present,
            version: Some(version),
            required: false,
            message: "Detected native guacd on PATH".to_string(),
            remediation: None,
            install_url: None,
            install_label: None,
        };
    }

    DependencyCheck {
        name: "Guacamole RDP bridge".to_string(),
        command: "guacd".to_string(),
        status: DependencyStatus::Missing,
        version: None,
        required: false,
        message: "No local guacd bridge or native guacd command detected".to_string(),
        remediation: Some(
            "Packaged macOS builds can start bundled guacd. Development builds can use npm start, a local guacd listening on 127.0.0.1:4822, or native guacd on PATH."
                .to_string(),
        ),
        install_url: Some("https://guacamole.apache.org/doc/gug/installing-guacamole.html".to_string()),
        install_label: Some("Guacamole install guide".to_string()),
    }
}

fn check_tool(
    name: &str,
    command: &str,
    args: &[&str],
    required: bool,
    remediation: &str,
    install_url: Option<&str>,
    install_label: Option<&str>,
) -> DependencyCheck {
    let executable = resolve_tool_executable(command);
    let mut command_builder = Command::new(&executable);
    command_builder.args(args);
    if let Some(path) = aws_cli::tool_path() {
        command_builder.env("PATH", path);
    }

    match command_builder.output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let version = if stdout.is_empty() { stderr } else { stdout };
            DependencyCheck {
                name: name.to_string(),
                command: command.to_string(),
                status: DependencyStatus::Present,
                version: Some(version),
                required,
                message: "Detected".to_string(),
                remediation: None,
                install_url: None,
                install_label: None,
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            DependencyCheck {
                name: name.to_string(),
                command: command.to_string(),
                status: DependencyStatus::Missing,
                version: None,
                required,
                message: if stderr.is_empty() {
                    "Not detected".to_string()
                } else {
                    stderr
                },
                remediation: Some(remediation.to_string()),
                install_url: install_url.map(str::to_string),
                install_label: install_label.map(str::to_string),
            }
        }
        Err(error) => DependencyCheck {
            name: name.to_string(),
            command: command.to_string(),
            status: DependencyStatus::Missing,
            version: None,
            required,
            message: format!("Not detected: {error}"),
            remediation: Some(remediation.to_string()),
            install_url: install_url.map(str::to_string),
            install_label: install_label.map(str::to_string),
        },
    }
}

fn resolve_tool_executable(command: &str) -> String {
    if command == "aws" {
        return aws_cli::aws_executable();
    }

    #[cfg(target_os = "macos")]
    {
        for directory in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            let candidate = PathBuf::from(directory).join(command);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    command.to_string()
}
