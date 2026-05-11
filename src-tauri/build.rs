use std::fs;
use std::path::Path;

const GUACD_TARGET_TRIPLE: &str = "aarch64-apple-darwin";
const GUACD_PLACEHOLDER_MARKER: &str = "SSM_COMMANDER_GENERATED_GUACD_PLACEHOLDER";
const GUACD_LIB_PLACEHOLDER: &str = "SSM_COMMANDER_GENERATED_GUACD_LIB_PLACEHOLDER";

fn main() {
    prepare_debug_guacd_placeholder();
    tauri_build::build()
}

fn prepare_debug_guacd_placeholder() {
    let target = std::env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_default();
    if target != GUACD_TARGET_TRIPLE {
        return;
    }

    let path = Path::new("binaries").join(format!("guacd-{GUACD_TARGET_TRIPLE}"));
    let lib_dir = Path::new("resources").join("macos").join("lib");
    let profile = std::env::var("PROFILE").unwrap_or_default();

    if profile == "release" {
        if fs::read_to_string(&path)
            .map(|contents| contents.contains(GUACD_PLACEHOLDER_MARKER))
            .unwrap_or(false)
        {
            panic!(
                "release macOS builds require a real guacd sidecar; run scripts/stage-guacd-macos.mjs before building the DMG"
            );
        }
        let has_staged_dylib = fs::read_dir(&lib_dir)
            .map(|entries| {
                entries.filter_map(Result::ok).any(|entry| {
                    entry
                        .path()
                        .extension()
                        .map(|extension| extension == "dylib")
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if !has_staged_dylib {
            panic!(
                "release macOS builds require staged guacd dylibs; run scripts/stage-guacd-macos.mjs before building the DMG"
            );
        }
        return;
    }

    fs::create_dir_all(&lib_dir).expect("failed to create debug guacd resource directory");
    let lib_placeholder = lib_dir.join(".debug-guacd-placeholder");
    if !lib_placeholder.exists() {
        fs::write(&lib_placeholder, GUACD_LIB_PLACEHOLDER)
            .expect("failed to write debug guacd lib placeholder");
    }

    if path.exists() {
        return;
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("failed to create debug guacd placeholder directory");
    }
    fs::write(
        &path,
        format!(
            "#!/bin/sh\n# {GUACD_PLACEHOLDER_MARKER}\necho \"Debug placeholder: stage native guacd for packaged embedded RDP.\" >&2\nexit 127\n"
        ),
    )
    .expect("failed to write debug guacd placeholder");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("failed to make debug guacd placeholder executable");
    }
}
