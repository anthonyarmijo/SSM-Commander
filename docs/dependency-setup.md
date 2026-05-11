# Dependency Setup

SSM Commander depends on the existing AWS tooling rather than replacing it. That keeps profile, SSO, and AWS credential behavior aligned with the AWS CLI you already use.

## macOS

Required:

- AWS CLI v2
- AWS Session Manager Plugin
- OpenSSH for embedded SSH console tabs

Recommended:

- Docker for `npm start`, a native `guacd` binary for manual embedded RDP console tabs during development, or the bundled `guacd` sidecar in packaged macOS builds
- FreeRDP for external RDP fallback

Example Homebrew installs:

```sh
brew install awscli
brew install --cask session-manager-plugin
brew install freerdp
```

Embedded RDP uses Apache Guacamole's `guacd` protocol bridge. The standard
development command manages this for you:

```sh
npm start
```

`npm start` requires Docker Desktop to be running. It starts the official
`guacd` container on `127.0.0.1:4822`, launches Tauri dev mode, and stops the
container when you quit. The launcher also sets
`SSM_COMMANDER_GUACD_RDP_HOST=host.docker.internal` so `guacd` can connect back
to SSM tunnel ports opened on the host.

For manual development, the app expects `guacd` to be reachable on
`127.0.0.1:4822`. Packaged Apple Silicon DMGs can start a bundled native
sidecar when no bridge is already reachable. Homebrew may not provide a
`guacamole-server` formula on macOS, so the recommended manual fallback is to
run the official `guacd` container:

```sh
docker run --rm --name ssm-commander-guacd \
  -p 127.0.0.1:4822:4822 \
  guacamole/guacd
```

Verify that the bridge is listening before opening an embedded RDP session:

```sh
nc -zv 127.0.0.1 4822
```

If you install a native `guacd` binary instead, bind it to the same address and
port:

```sh
guacd -f -b 127.0.0.1 -l 4822
```

Native or bundled `guacd` targets `127.0.0.1` by default. Set
`SSM_COMMANDER_GUACD_RDP_HOST` only if your bridge runs outside the host network
namespace and needs a different route back to the local SSM tunnel.

To stage the native sidecar for Apple Silicon packaging, install the build
dependencies first:

```sh
brew install cairo freerdp jpeg-turbo libpng openssl@3 ossp-uuid pkgconf
```

Then run:

```sh
npm run stage:guacd:macos
file src-tauri/binaries/guacd-aarch64-apple-darwin
otool -L src-tauri/binaries/guacd-aarch64-apple-darwin
```

The staging script builds Apache Guacamole Server, copies the RDP-capable
`guacd` binary to `src-tauri/binaries/`, stages required dylibs under
`src-tauri/resources/macos/lib/`, and fails if relocatable library paths still
point at Homebrew. Generated sidecar files are ignored by git. Later runs reuse
valid staged artifacts; set `GUACD_FORCE_REBUILD=1` when you intentionally need
to rebuild `guacd` from source.

Packaged builds start the bundled sidecar on a private loopback port for the
current app process. That avoids reusing stale development or previously mounted
DMG `guacd` listeners on the default port.

The macOS DMG release build is:

```sh
npm run tauri:build -- --target aarch64-apple-darwin --bundles dmg
```

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
- `guacd` for embedded RDP console tabs during development
- Remote Desktop Client (`mstsc.exe`) for external RDP fallback
- Windows Terminal or PowerShell for external terminal fallback

Development builds also require Rust from <https://rustup.rs/>.

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
