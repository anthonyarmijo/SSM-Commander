# SSM Commander

SSM Commander is a Tauri desktop app for browsing EC2 instances and launching AWS Systems Manager workflows from a fast local UI. It is designed for people who already use the AWS CLI and AWS SSO, but want a cleaner way to validate profiles, inspect instance readiness, start or stop instances, and run embedded SSH, RDP, shell, or port-forward sessions.

![SSM Commander](docs/screenshots/app-home-dark.png)

## Features

- Discover AWS CLI profiles already configured on your machine.
- Save the profiles you care about most and keep one active across the app.
- Validate AWS identity and launch AWS SSO sign-in from the UI.
- Show a lightweight capability checklist for each saved profile.
- Browse EC2 instances and SSM readiness by region in a three-pane resource view.
- Start and stop EC2 instances from the selected profile.
- Launch SSM shell, embedded SSH/RDP console tabs, and generic port-forward sessions.
- Save optional SSH and RDP connection details in an encrypted local credential vault.
- Set default SSH/RDP credentials and apply them from the Instances inspector without exposing saved secrets to persisted preferences.
- Configure RDP domain and security mode details for embedded console launches.
- On macOS, use an embedded native FreeRDP view and optionally redirect a local PIV/CAC smart card into the Windows VM.
- Surface environment checks and local diagnostics in-app.

## Prerequisites

The app relies on existing AWS tooling instead of managing credentials itself.

Required:

- AWS CLI v2
- AWS Session Manager Plugin

Packaged macOS builds read AWS profiles directly from the standard
`~/.aws/config` and `~/.aws/credentials` files, so profile discovery does not
depend on shell startup files or Finder's `PATH`. Existing CLI-backed workflows
also search standard Homebrew and system tool locations before falling back to
`PATH`.

Recommended, depending on your workflow:

- OpenSSH
- FreeRDP 3 on macOS for the native embedded RDP renderer
- Docker/`guacd` for the legacy Windows embedded-RDP renderer and its development workflow

Development builds also require Node.js, npm, and Rust.

## AWS Setup

Configure one or more AWS CLI profiles before using the app:

```sh
aws configure sso
aws sso login --profile your-profile
aws sts get-caller-identity --profile your-profile
```

The app does not replace IAM, AWS SSO, or Session Manager setup. It expects profiles and permissions to already exist.

## v1.0 Release

Version 1.0.0 launches the refreshed resource browser, embedded console tabs,
encrypted local SSH/RDP credential vault, native macOS FreeRDP, and
public-release security checks.

## Development

Install dependencies and launch the desktop app:

```sh
npm install
npm start
```

On macOS, `npm start` launches Tauri directly and does not require Docker or a
running `guacd` process. On Windows, it starts the local Guacamole bridge for
the embedded-RDP renderer, waits for it to be ready, launches Tauri dev mode,
and stops the bridge when you quit. Set `SSM_COMMANDER_ENABLE_GUACD_DEV=1` on
macOS only when you intentionally need the legacy bridge for debugging.

Advanced/manual alternatives:

```sh
npm run tauri:dev  # raw Tauri dev mode, no Docker or guacd lifecycle management
npm run dev        # frontend-only Vite server
```

## macOS DMG Builds

Apple Silicon RDP uses the upstream FreeRDP Mac view embedded natively in the
console workspace. The source is pinned as the `src-tauri/vendor/freerdp`
submodule and builds against FreeRDP 3 installed through Homebrew. The bundle
workflow stages and rewrites the FreeRDP/WinPR dylib closure automatically.

```sh
npm run stage:freerdp:macos  # optional standalone staging check after a release build
npm run tauri:build -- --target aarch64-apple-darwin --bundles dmg
```

For macOS, the app starts FreeRDP directly against the SSM tunnel and does not
need a `guacd` listener. Windows continues to use the Guacamole bridge. See
[native macOS RDP and smart-card redirection](docs/macos-native-rdp-smartcard.md)
for card setup, architecture, and current limitations.

Signing and notarization are configured through environment variables instead
of committed values. Use `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, and
`APPLE_CERTIFICATE_PASSWORD` for signing in CI, plus either
`APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_KEY_PATH` for App Store
Connect API notarization or `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`
for Apple ID notarization. See Tauri's docs for
[external binaries](https://tauri.app/develop/sidecar/),
[macOS signing and notarization](https://tauri.app/distribute/sign/macos/), and
[platform-specific config](https://v2.tauri.app/ko/reference/config/).

Frontend checks:

```sh
npm test
npm run lint
npm run build
```

Rust checks:

```sh
cd src-tauri
cargo test
cargo check
```

## Security Notes

- The app does not store AWS access keys or AWS session tokens.
- Authentication and authorization continue to come from the AWS CLI profile you select.
- Saved SSH and RDP credentials live only in the encrypted local credential vault after you unlock it with a master passphrase.
- Saved credential secrets are resolved in the Tauri backend for console launches instead of being copied into persisted preferences.
- Manually entered embedded SSH and RDP session credentials are kept in memory and are not persisted to preferences.
- PIV/CAC redirection is opt-in per RDP launch and uses the RDP PC/SC smart-card channel; no raw USB device is exposed to the web UI.
- Public releases should be scanned with Gitleaks before publishing.

## Troubleshooting

Additional setup and troubleshooting notes live in:

- [docs/dependency-setup.md](docs/dependency-setup.md)
- [docs/public-release-checklist.md](docs/public-release-checklist.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)

Native macOS RDP selects its initial remote-desktop dimensions from the visible
console pane, then smart-scales the desktop as the app window changes. Smart-card
use inside an established desktop is supported; smart-card RDP/NLA login is not
yet a supported launch mode.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
