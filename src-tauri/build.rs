use std::fs;
use std::path::Path;

const GUACD_TARGET_TRIPLE: &str = "aarch64-apple-darwin";
const GUACD_PLACEHOLDER_MARKER: &str = "SSM_COMMANDER_GENERATED_GUACD_PLACEHOLDER";
const GUACD_LIB_PLACEHOLDER: &str = "SSM_COMMANDER_GENERATED_GUACD_LIB_PLACEHOLDER";

fn main() {
    build_macos_freerdp();
    prepare_debug_guacd_placeholder();
    tauri_build::build()
}

fn build_macos_freerdp() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let prefix = std::env::var("SSM_COMMANDER_FREERDP_PREFIX")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| {
            ["/opt/homebrew/opt/freerdp", "/usr/local/opt/freerdp"]
                .into_iter()
                .map(std::path::PathBuf::from)
                .find(|path| path.join("include/freerdp3/freerdp/freerdp.h").exists())
        })
        .unwrap_or_else(|| {
            panic!("embedded macOS RDP requires FreeRDP 3 headers; install it with `brew install freerdp` or set SSM_COMMANDER_FREERDP_PREFIX")
        });
    let source = std::path::Path::new("vendor/freerdp");
    if !source.join("client/Mac/MRDPView.m").exists() {
        panic!("the FreeRDP source submodule is missing; run `git submodule update --init --recursive`");
    }
    let mrdp_view = source.join("client/Mac/MRDPView.m");
    let original_mrdp_view = std::fs::read_to_string(&mrdp_view)
        .expect("could not read FreeRDP's macOS MRDPView source");
    let patched_mrdp_view = original_mrdp_view.replace(
        "[event locationInWindow]",
        "[self convertPoint:[event locationInWindow] fromView:nil]",
    );
    if patched_mrdp_view == original_mrdp_view {
        panic!(
            "the pinned FreeRDP MRDPView source no longer has the expected mouse coordinate calls"
        );
    }
    let patched_mrdp_view_path =
        std::path::PathBuf::from(std::env::var("OUT_DIR").expect("Cargo did not provide OUT_DIR"))
            .join("SSMCommanderMRDPView.m");
    std::fs::write(&patched_mrdp_view_path, patched_mrdp_view)
        .expect("could not write patched FreeRDP MRDPView source");

    println!("cargo:rerun-if-env-changed=SSM_COMMANDER_FREERDP_PREFIX");
    println!("cargo:rerun-if-changed=native/macos/ssmc_freerdp.m");
    println!("cargo:rerun-if-changed=native/macos/ssmc_freerdp.h");
    for file in [
        "client/common/client.c",
        "client/Mac/mf_client.m",
        "client/Mac/MRDPCursor.m",
        "client/Mac/MRDPView.m",
        "client/Mac/Keyboard.m",
        "client/Mac/Clipboard.m",
        "client/Mac/CertificateDialog.m",
        "client/Mac/PasswordDialog.m",
    ] {
        println!("cargo:rerun-if-changed={}", source.join(file).display());
    }

    let include = |build: &mut cc::Build| {
        build
            .include(prefix.join("include/freerdp3"))
            .include(prefix.join("include/winpr3"))
            .include(source.join("client/Mac"))
            .include(source.join("client/common"))
            .flag("-mmacosx-version-min=12.0")
            .flag("-Wno-deprecated-declarations");
    };
    let mut common = cc::Build::new();
    include(&mut common);
    common
        .file(source.join("client/common/client.c"))
        .compile("ssmc_freerdp_common");

    let mut mac = cc::Build::new();
    include(&mut mac);
    mac.flag("-std=gnu2x").flag("-fno-objc-arc");
    for file in [
        "native/macos/ssmc_freerdp.m",
        "vendor/freerdp/client/Mac/mf_client.m",
        "vendor/freerdp/client/Mac/MRDPCursor.m",
        "vendor/freerdp/client/Mac/Keyboard.m",
        "vendor/freerdp/client/Mac/Clipboard.m",
        "vendor/freerdp/client/Mac/CertificateDialog.m",
        "vendor/freerdp/client/Mac/PasswordDialog.m",
    ] {
        mac.file(file);
    }
    mac.file(patched_mrdp_view_path);
    mac.compile("ssmc_freerdp_macos");

    println!(
        "cargo:rustc-link-search=native={}",
        prefix.join("lib").display()
    );
    println!("cargo:rustc-link-lib=dylib=freerdp-client3");
    println!("cargo:rustc-link-lib=dylib=freerdp3");
    println!("cargo:rustc-link-lib=dylib=winpr3");
    for framework in [
        "AppKit",
        "Cocoa",
        "Foundation",
        "CoreGraphics",
        "IOKit",
        "PCSC",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}

fn prepare_debug_guacd_placeholder() {
    let target = std::env::var("TAURI_ENV_TARGET_TRIPLE")
        .or_else(|_| std::env::var("TARGET"))
        .unwrap_or_default();
    if target != GUACD_TARGET_TRIPLE
        || std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
    {
        return;
    }

    let path = Path::new("binaries").join(format!("guacd-{GUACD_TARGET_TRIPLE}"));
    let lib_dir = Path::new("resources").join("macos").join("lib");
    let profile = std::env::var("PROFILE").unwrap_or_default();

    if profile == "release" {
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
