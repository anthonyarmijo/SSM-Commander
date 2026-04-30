use crate::models::{DependencyCheck, DependencyStatus, EnvironmentState, EnvironmentStatus};
use std::process::Command;

pub fn check_environment() -> EnvironmentState {
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
        check_tool(
            "Guacamole RDP bridge",
            "guacd",
            &["-v"],
            false,
            "Install or bundle guacd to use embedded RDP console tabs. Development builds can use a local guacd listening on 127.0.0.1:4822.",
            Some("https://guacamole.apache.org/doc/gug/installing-guacamole.html"),
            Some("Guacamole install guide"),
        ),
        check_tool(
            "Rust toolchain",
            "cargo",
            &["--version"],
            false,
            "Install Rust with rustup when building or packaging the app locally.",
            Some("https://www.rust-lang.org/tools/install"),
            Some("Rust install guide"),
        ),
    ];

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

fn check_tool(
    name: &str,
    command: &str,
    args: &[&str],
    required: bool,
    remediation: &str,
    install_url: Option<&str>,
    install_label: Option<&str>,
) -> DependencyCheck {
    match Command::new(command).args(args).output() {
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
