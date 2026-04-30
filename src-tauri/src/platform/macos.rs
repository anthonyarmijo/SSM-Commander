use crate::platform::shell_join;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

pub fn launch_terminal_command(
    _title: &str,
    args: &[String],
    terminal_preset: Option<&str>,
    _custom_terminal_command: Option<&str>,
) -> Result<(), String> {
    let command = shell_join(args);
    match terminal_preset.unwrap_or("systemDefault") {
        "systemDefault" | "terminal" => launch_terminal_app(&command),
        "iterm" => launch_iterm_app(&command),
        "ghostty" => {
            launch_exec_terminal("ghostty", &["-e", "/bin/zsh", "-lc", &command], "Ghostty")
        }
        "wezterm" => launch_exec_terminal(
            "wezterm",
            &["start", "--", "/bin/zsh", "-lc", &command],
            "WezTerm",
        ),
        "warp" => launch_warp_script(&command),
        "custom" => Err("Custom terminal launchers are disabled in public builds.".to_string()),
        unsupported => Err(format!("Unsupported macOS terminal preset: {unsupported}")),
    }
}

pub fn launch_rdp(port: u16, username: Option<&str>) -> Result<(), String> {
    let mut args = vec![format!("/v:127.0.0.1:{port}"), "/cert:ignore".to_string()];
    if let Some(username) = username.filter(|value| !value.trim().is_empty()) {
        args.push(format!("/u:{username}"));
    }

    Command::new("xfreerdp")
        .args(args)
        .spawn()
        .map_err(|error| format!("Could not launch xfreerdp: {error}"))?;
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
    Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|error| format!("Could not open path: {error}"))?;
    Ok(())
}

fn escape_applescript(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

fn launch_terminal_app(command: &str) -> Result<(), String> {
    let script = format!(
        r#"tell application "Terminal" to do script "{}""#,
        escape_applescript(command)
    );
    Command::new("osascript")
        .args([
            "-e",
            &script,
            "-e",
            r#"tell application "Terminal" to activate"#,
        ])
        .spawn()
        .map_err(|error| format!("Could not launch Terminal: {error}"))?;
    Ok(())
}

fn launch_iterm_app(command: &str) -> Result<(), String> {
    let script = format!(
        r#"
tell application "iTerm"
    activate
    create window with default profile
    tell current session of current window to write text "{}"
end tell
"#,
        escape_applescript(command)
    );
    Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map_err(|error| format!("Could not launch iTerm: {error}"))?;
    Ok(())
}

fn launch_exec_terminal(executable: &str, args: &[&str], display_name: &str) -> Result<(), String> {
    Command::new(executable)
        .args(args)
        .spawn()
        .map_err(|error| format!("Could not launch {display_name}: {error}"))?;
    Ok(())
}

fn launch_warp_script(command: &str) -> Result<(), String> {
    let script_path = create_temp_command_script(command)?;
    Command::new("open")
        .arg("-a")
        .arg("Warp")
        .arg(script_path)
        .spawn()
        .map_err(|error| format!("Could not launch Warp: {error}"))?;
    Ok(())
}

fn create_temp_command_script(command: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("ssm-commander-{}.command", Uuid::new_v4()));
    let contents = format!("#!/bin/zsh\n{command}\n");
    fs::write(&path, contents)
        .map_err(|error| format!("Could not write temporary command script: {error}"))?;
    let permissions = fs::Permissions::from_mode(0o700);
    fs::set_permissions(&path, permissions)
        .map_err(|error| format!("Could not make temporary command script executable: {error}"))?;
    Ok(path)
}
