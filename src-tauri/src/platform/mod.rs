#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{launch_rdp, launch_ssh_terminal, launch_terminal_command, open_path};
#[cfg(target_os = "windows")]
pub use windows::{launch_rdp, launch_ssh_terminal, launch_terminal_command, open_path};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn launch_terminal_command(
    _title: &str,
    _args: &[String],
    _terminal_preset: Option<&str>,
    _custom_terminal_command: Option<&str>,
) -> Result<(), String> {
    Err("Terminal launch is only implemented for macOS and Windows in this MVP.".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn launch_rdp(_port: u16, _username: Option<&str>) -> Result<(), String> {
    Err("RDP launch is only implemented for macOS and Windows in this MVP.".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn launch_ssh_terminal(
    _port: u16,
    _username: &str,
    _key_path: Option<&str>,
    _terminal_preset: Option<&str>,
    _custom_terminal_command: Option<&str>,
) -> Result<(), String> {
    Err("SSH terminal launch is only implemented for macOS and Windows in this MVP.".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn open_path(_path: &std::path::Path) -> Result<(), String> {
    Err("Opening folders is only implemented for macOS and Windows in this MVP.".to_string())
}

pub fn shell_join(args: &[String]) -> String {
    args.iter()
        .map(|arg| shell_escape(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_escape(input: &str) -> String {
    if input
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "-_./:=@".contains(ch))
    {
        return input.to_string();
    }
    format!("'{}'", input.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::shell_join;

    #[test]
    fn shell_join_escapes_spaces() {
        let joined = shell_join(&["ssh".to_string(), "name with spaces".to_string()]);
        assert_eq!(joined, "ssh 'name with spaces'");
    }
}
