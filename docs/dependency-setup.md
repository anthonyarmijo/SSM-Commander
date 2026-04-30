# Dependency Setup

SSM Commander depends on the existing AWS tooling rather than replacing it. That keeps profile, SSO, and credential behavior aligned with the AWS CLI you already use.

## macOS

Required:

- AWS CLI v2
- AWS Session Manager Plugin
- OpenSSH for embedded SSH console tabs

Recommended:

- `guacd` for embedded RDP console tabs during development
- FreeRDP for external RDP fallback

Example Homebrew installs:

```sh
brew install awscli
brew install --cask session-manager-plugin
brew install guacamole-server
brew install freerdp
```

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
