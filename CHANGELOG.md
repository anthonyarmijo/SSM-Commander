# Changelog

All notable changes to SSM Commander are tracked here.

## Wish List

- Bundle platform-specific `guacd` sidecar binaries for packaged builds.

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
