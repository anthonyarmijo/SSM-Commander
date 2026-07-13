# Dependency Setup

SSM Commander uses your existing AWS CLI configuration. It does not create or
store AWS access keys.

## End-user requirements

On macOS and Windows, install:

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [AWS Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

Configure a profile before opening the app:

```sh
aws configure sso
aws sso login --profile your-profile
aws sts get-caller-identity --profile your-profile
```

Released macOS DMGs bundle the FreeRDP and WinPR libraries used by the native
embedded RDP renderer. End users do not need Homebrew or FreeRDP merely to run
the DMG. Packaged macOS builds discover standard AWS shared files
(`~/.aws/config` and `~/.aws/credentials`) and common tool locations when
started from Finder.

Optional workflow dependencies:

- OpenSSH for embedded SSH sessions.
- A reachable Windows host with Remote Desktop enabled for RDP sessions.
- A local smart-card reader and middleware when using opt-in macOS PIV/CAC
  redirection inside an established RDP session.

## Source-build requirements

All source builds need a supported Node.js release, npm, and Rust stable. Start
with the pinned native RDP source:

```sh
git submodule update --init --recursive
npm ci
```

### macOS

macOS source builds require Homebrew and FreeRDP 3 headers/libraries:

```sh
brew install freerdp
npm start
```

The native renderer connects directly through the local SSM tunnel; it does not
need `guacd`. To use another compatible FreeRDP prefix, set
`SSM_COMMANDER_FREERDP_PREFIX`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for
development validation and [the macOS RDP guide](macos-native-rdp-smartcard.md)
for card behavior and limitations.

### Windows

Windows source builds require Rust and normally use Docker Desktop for the
legacy Guacamole embedded-RDP development bridge:

```sh
npm start
```

The workflow starts `guacd` on `127.0.0.1:4822` only for the development
session. Windows users can also use the system Remote Desktop Client as an
external fallback. Set `SSM_COMMANDER_GUACD_RDP_HOST` only when a manually
managed bridge needs a different route to local SSM tunnel ports.

## Credential vault

The optional local vault encrypts saved SSH/RDP connection details with a
master passphrase. It is separate from AWS credentials. Saved secrets are
resolved in the Tauri backend for console launch; manually entered passwords
and pasted keys are session-only. Do not export vault files, private keys, or
real connection details into tickets, screenshots, or fixtures.
