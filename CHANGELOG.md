# Changelog

All notable changes to SSM Commander are tracked here.

## [Unreleased]

## [1.1.0] - 2026-07-10

### 2026-07-09

- Replace the macOS embedded-RDP renderer with a native FreeRDP Mac view that
  connects directly through existing SSM tunnels.
- Add opt-in PC/SC PIV/CAC redirection for established macOS RDP sessions and
  validate certificate authentication inside a Windows VM.
- Package FreeRDP/WinPR dylibs with the macOS app, including a clean-checkout
  build-time mouse-coordinate compatibility adjustment for the upstream view.
- Derive the initial RDP resolution from the visible console pane, smart-scale
  subsequent window resizes, remove the native focus banner, and show an RDP
  startup state before the native connection begins.
- Refresh the workspace UI and simplify Initialize: compact readiness summary,
  clearer local-tool status, and no obsolete Guacamole bridge environment check.
- Add macOS native RDP/PIV-CAC setup and validation documentation.

- Stabilize the legacy Windows embedded-RDP startup path after dynamic resize
  regressions, while preserving native macOS FreeRDP as the macOS renderer.

### 2026-05-13

- Fix embedded RDP keyboard capture so hidden console tabs no longer intercept typing in other views.
- Keep embedded RDP on the stable `1280x720` startup path with browser-side fitting and disabled Guacamole resize negotiation after dynamic resize attempts regressed into black-screen handshakes.
- Document the remaining embedded RDP scaling limitation: small top/bottom black bars can still appear when the console pane aspect ratio differs from the fixed remote desktop, though the rollback is more usable than the failed dynamic resize path.

## [1.0.0] - 2026-05-06

### 2026-05-06

- Refresh the GUI toward a three-pane OrbStack-inspired layout with liquid-glass navigation, resource browsing, and inspector actions.
- Refine the GUI refresh with the original blue accent palette, a shaded resize rail, and compact saved credential controls.
- Add encrypted local credential vault management for SSH and RDP connection details.
- Add a Credentials navigation view with unlock, lock, create, edit, delete, and default credential flows.
- Add SSH/RDP credential defaults and instance connection defaults for faster console launches.
- Improve embedded console session lifecycle handling and close behavior.
- Add RDP domain handling and explicit RDP security mode support.
- Keep embedded SSH and RDP credentials out of persisted preferences and logs.
- Reduce credential secret exposure across the renderer boundary by resolving saved credentials in the Tauri backend for console launches.
- Clear edited credential secrets from renderer state when locking the vault or leaving the Credentials view.
- Harden credential vault and pasted SSH key temporary file permissions.
- Enforce stronger master passphrases for newly created credential vaults.

### 2026-05-04

- Refine the Instances layout and tighten the VM table.
- Improve embedded RDP diagnostics and `guacd` readiness messaging.
- Add Docker-backed local `guacd` support through `npm start`.
- Fix tunnel dialog behavior and embedded RDP tunnel startup timing.
- Add advanced tunnel form handling and coverage.

### 2026-04-30

- Standardize local development around `npm start`.
- Add scripts to free the dev port and manage local Tauri startup.
- Restore CI lockfile tracking and remove local-only environment/task files.
- Add README screenshots and launch/development documentation updates.

### 2026-04-29

- Initial public release of SSM Commander.
- Add Tauri desktop app for AWS CLI profile discovery, SSO validation, EC2 instance browsing, SSM readiness, start/stop actions, and session launching.
- Add Console support for shell, SSH, RDP, and port-forward workflows.
- Add profile preferences, dependency checks, diagnostics, troubleshooting docs, and public release checklist.
- Document macOS `guacd` setup for embedded RDP.
- Add local app launcher scripts and refactor Tauri dev server integration.
