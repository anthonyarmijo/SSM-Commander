# Dependency Setup

SSM Commander depends on the existing AWS tooling rather than replacing it. That keeps profile, SSO, and credential behavior aligned with the AWS CLI you already use.

## macOS

Required:

- AWS CLI v2
- AWS Session Manager Plugin
- OpenSSH for embedded SSH console tabs

Recommended:

- Docker for `npm start`, or a native `guacd` binary for manual embedded RDP console tabs during development
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
`127.0.0.1:4822`; packaged builds can also use a bundled sidecar when one is
available. Homebrew may not provide a `guacamole-server` formula on macOS, so
the recommended manual fallback is to run the official `guacd` container:

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

Development builds also require Rust:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

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
