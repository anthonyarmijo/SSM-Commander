use crate::platform::shell_join;
use std::path::Path;
use std::process::Command;

pub fn launch_terminal_command(
    _title: &str,
    args: &[String],
    terminal_preset: Option<&str>,
    _custom_terminal_command: Option<&str>,
) -> Result<(), String> {
    let command = shell_join(args);
    match terminal_preset.unwrap_or("systemDefault") {
        "systemDefault" | "powerShell" => launch_powershell(&command),
        "windowsTerminal" => launch_windows_terminal(&command),
        "custom" => Err("Custom terminal launchers are disabled in public builds.".to_string()),
        unsupported => Err(format!(
            "Unsupported Windows terminal preset: {unsupported}"
        )),
    }
}

pub fn launch_rdp(port: u16, _username: Option<&str>) -> Result<(), String> {
    Command::new("mstsc.exe")
        .arg(format!("/v:127.0.0.1:{port}"))
        .spawn()
        .map_err(|error| format!("Could not launch Remote Desktop: {error}"))?;
    Ok(())
}

pub fn launch_ssh_terminal(
    port: u16,
    username: &str,
    key_path: Option<&str>,
    terminal_preset: Option<&str>,
    custom_terminal_command: Option<&str>,
) -> Result<(), String> {
    let mut args = vec!["ssh".to_string(), "-p".to_string(), port.to_string()];
    if let Some(key_path) = key_path.filter(|value| !value.trim().is_empty()) {
        args.push("-i".to_string());
        args.push(key_path.to_string());
    }
    args.push(format!("{username}@127.0.0.1"));
    launch_terminal_command(
        "SSH over SSM",
        &args,
        terminal_preset,
        custom_terminal_command,
    )
}

pub fn open_path(path: &Path) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not open path: {error}"))?;
    Ok(())
}

fn launch_powershell(command: &str) -> Result<(), String> {
    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            "Start-Process",
            "powershell.exe",
            "-ArgumentList",
        ])
        .arg(format!(
            r#""-NoExit -Command {}""#,
            command.replace('"', r#"\""#)
        ))
        .spawn()
        .map_err(|error| format!("Could not launch PowerShell: {error}"))?;
    Ok(())
}

fn launch_windows_terminal(command: &str) -> Result<(), String> {
    Command::new("wt.exe")
        .args(["new-tab", "powershell.exe", "-NoExit", "-Command", command])
        .spawn()
        .map_err(|error| format!("Could not launch Windows Terminal: {error}"))?;
    Ok(())
}
