# SSM Commander

SSM Commander is a small Tauri app for browsing EC2 instances and launching AWS Systems Manager workflows from a desktop UI. It is designed for people who already use the AWS CLI and AWS SSO, but want a faster way to validate profiles, inspect instance readiness, start or stop instances, and run embedded SSH, RDP, shell, or port-forward sessions.

## Features

- Discover AWS CLI profiles already configured on your machine.
- Save the profiles you care about most and keep one active across the app.
- Validate AWS identity and launch AWS SSO sign-in from the UI.
- Show a lightweight capability checklist for each saved profile.
- Browse EC2 instances and SSM readiness by region.
- Start and stop EC2 instances from the selected profile.
- Launch SSM shell, embedded SSH/RDP console tabs, and generic port-forward sessions.
- Surface environment checks and local diagnostics in-app.

## Prerequisites

The app relies on existing AWS tooling instead of managing credentials itself.

Required:

- AWS CLI v2
- AWS Session Manager Plugin

Recommended, depending on your workflow:

- OpenSSH
- Docker for the one-command local dev workflow, or a native `guacd` binary for manual embedded RDP development
- FreeRDP on macOS or the native Remote Desktop client on Windows for external RDP fallback

Development builds also require Rust.

## AWS Setup

Configure one or more AWS CLI profiles before using the app:

```sh
aws configure sso
aws sso login --profile your-profile
aws sts get-caller-identity --profile your-profile
```

The app does not replace IAM, AWS SSO, or Session Manager setup. It expects profiles and permissions to already exist.

## Development

Install dependencies and launch the desktop app:

```sh
npm install
npm start
```

`npm start` starts the local Guacamole bridge with Docker, waits for it to be
ready, launches Tauri dev mode, and stops the bridge when you quit. Docker
Desktop must be running before you start the app.

Advanced/manual alternatives:

```sh
npm run tauri:dev  # raw Tauri dev mode, no Docker or guacd lifecycle management
npm run dev        # frontend-only Vite server
```

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

- The app does not store AWS credentials, passwords, or RDP passwords.
- Authentication and authorization continue to come from the AWS CLI profile you select.
- Embedded SSH and RDP session credentials are kept in memory and are not persisted to preferences.
- Public releases should be created from a fresh `git archive` export, scanned with Gitleaks, and pushed to a new repository.

## Troubleshooting

Additional setup and troubleshooting notes live in:

- [docs/dependency-setup.md](docs/dependency-setup.md)
- [docs/public-release-checklist.md](docs/public-release-checklist.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
