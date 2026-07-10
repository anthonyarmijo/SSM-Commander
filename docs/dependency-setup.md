# Dependency Setup

SSM Commander depends on the existing AWS tooling rather than replacing it. That keeps profile, SSO, and AWS credential behavior aligned with the AWS CLI you already use.

## macOS

Required:

- AWS CLI v2
- AWS Session Manager Plugin
- OpenSSH for embedded SSH console tabs

Recommended:

- FreeRDP 3 for the native embedded macOS RDP renderer

Example Homebrew installs:

```sh
brew install awscli
brew install --cask session-manager-plugin
brew install freerdp
```

macOS embedded RDP uses the upstream FreeRDP Mac view and connects directly to
the loopback port created by the SSM tunnel. It does not need `guacd`. Install
FreeRDP and initialize the pinned source submodule before building:

```sh
brew install freerdp
git submodule update --init --recursive
```

On macOS, `npm start` launches the native renderer without Docker or `guacd`:

```sh
npm start
```

To package the native renderer for Apple Silicon, install FreeRDP first:

```sh
brew install freerdp
```

Then run:

```sh
npm run tauri:build -- --target aarch64-apple-darwin --bundles dmg
```

Tauri invokes `scripts/stage-freerdp-macos.mjs` immediately before bundling.
It copies the FreeRDP/WinPR dependency closure into
`src-tauri/resources/macos/lib/`, rewrites the release executable to use that
app-local library path, and fails if it finds a remaining Homebrew link. You
can run `npm run stage:freerdp:macos` manually after `cargo build --release` to
inspect the staging step in isolation.

For smart-card setup and release-validation requirements, read
[macOS Native RDP and PIV/CAC Redirection](macos-native-rdp-smartcard.md).

Use environment variables for Apple signing and notarization secrets. Do not
commit certificates, private keys, app-specific passwords, or API keys. Tauri
uses `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, and either App Store Connect API variables
`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` or Apple ID variables
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

Development builds also require Rust:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Frontend development also requires Node.js and npm.

## Windows

Required:

- AWS CLI v2
- AWS Session Manager Plugin

Recommended:

- Windows OpenSSH client
- Remote Desktop Client (`mstsc.exe`) for external RDP fallback
- Windows Terminal or PowerShell for external terminal fallback

Development builds also require Rust from <https://rustup.rs/>.

Windows continues to use the legacy Guacamole renderer for embedded RDP. Its
`npm start` workflow requires Docker Desktop and starts `guacd` on
`127.0.0.1:4822` for the duration of the development session. To manage it
manually instead, run:

```sh
docker run --rm --name ssm-commander-guacd \
  -p 127.0.0.1:4822:4822 \
  guacamole/guacd
```

Set `SSM_COMMANDER_GUACD_RDP_HOST` only when that bridge runs outside the host
network namespace and needs a different route to local SSM tunnel ports.

## AWS Profile Setup

The app expects profiles to already be configured through AWS CLI files or SSO:

```sh
aws configure sso
aws sso login --profile your-profile
aws sts get-caller-identity --profile your-profile
```

The app can validate profiles and report clear errors, but it does not replace IAM, SSO, or Session Manager account configuration.
Packaged macOS builds discover profiles by reading `~/.aws/config` and
`~/.aws/credentials` directly, then use standard Homebrew and system tool
locations for remaining CLI-backed workflows.

## Local Credential Vault

SSM Commander v1.0 can save optional SSH and RDP connection details in an encrypted local vault. The vault is separate from AWS credentials, requires a master passphrase to unlock, and is intended only for connection details used by embedded console sessions.

Saved credential secrets are resolved by the Tauri backend when a console session starts. They are not written to preferences, diagnostics, or release fixtures. Manually entered SSH/RDP passwords and pasted private keys are treated as session-only values.
