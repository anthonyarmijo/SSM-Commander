use crate::models::UserPreferences;
use std::{fs, path::PathBuf};

fn preferences_path() -> Result<PathBuf, String> {
    let base = dirs_next::config_dir()
        .ok_or_else(|| "Could not locate user config directory".to_string())?;
    Ok(base.join("ssm-commander").join("preferences.json"))
}

fn legacy_preferences_path() -> Result<PathBuf, String> {
    let base = dirs_next::config_dir()
        .ok_or_else(|| "Could not locate user config directory".to_string())?;
    Ok(base.join("ssm-mgmt-gui").join("preferences.json"))
}

pub fn load_preferences() -> Result<UserPreferences, String> {
    let path = preferences_path()?;
    let path = if path.exists() {
        path
    } else {
        let legacy_path = legacy_preferences_path()?;
        if legacy_path.exists() {
            legacy_path
        } else {
            path
        }
    };

    if !path.exists() {
        return Ok(UserPreferences::default());
    }

    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read preferences: {error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("Could not parse preferences: {error}"))
}

pub fn save_preferences(preferences: &UserPreferences) -> Result<(), String> {
    let path = preferences_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create preferences directory: {error}"))?;
    }
    let contents = serde_json::to_string_pretty(preferences)
        .map_err(|error| format!("Could not serialize preferences: {error}"))?;
    fs::write(&path, contents).map_err(|error| format!("Could not write preferences: {error}"))
}

pub fn logs_dir() -> Result<PathBuf, String> {
    let base = dirs_next::data_local_dir()
        .ok_or_else(|| "Could not locate user data directory".to_string())?;
    let path = base.join("ssm-commander").join("logs");
    fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create logs directory: {error}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_ssm_commander_path_names() {
        let preferences = super::preferences_path().unwrap();
        let logs = super::logs_dir().unwrap();

        assert!(preferences.to_string_lossy().contains("ssm-commander"));
        assert!(logs.to_string_lossy().contains("ssm-commander"));
    }
}
