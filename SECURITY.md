# Security Policy

## Credential model

SSM Commander reads AWS CLI profiles and delegates authentication and
authorization to the AWS CLI, AWS IAM Identity Center, and AWS services. It
does not persist AWS access keys or session tokens.

Optional SSH and RDP connection details may be stored in an encrypted local
vault protected by a user-provided master passphrase. The vault is distinct from
AWS credential files. Saved connection secrets are resolved in the Tauri
backend when a console starts; manually entered passwords and pasted SSH keys
are session-only and are not written to preferences.

## Trust boundaries

The web renderer requests operations through Tauri commands; credential
resolution, process launch, and local tunnel handling occur in the backend.
On macOS, the native FreeRDP view is embedded above the web interface and talks
directly to the loopback SSM tunnel. On Windows, the legacy Guacamole bridge is
used only for the embedded-RDP implementation. Treat all remote endpoints and
their policies as separate trust domains.

PIV/CAC redirection is opt-in for a macOS RDP session and uses FreeRDP's PC/SC
channel. It forwards smart-card protocol access, not raw USB control. Review
the target Windows policy and the focused [macOS RDP guide](docs/macos-native-rdp-smartcard.md)
before enabling it.

## Reporting a vulnerability

Please use GitHub's private security advisory/reporting feature for this
repository when it is available. If it is unavailable, open a minimal public
issue requesting a private reporting channel; do not include exploit details,
credentials, or sensitive environment information. Maintainers should
acknowledge reports, assess impact, coordinate a fix, and publish an advisory
only after affected users have a reasonable remediation path.

## Secret handling

Run `npm run scan:secrets` before releases when Gitleaks is installed. Do not
commit credentials, certificates, API keys, app-specific passwords, vault
exports, private keys, or non-fictional screenshots. Keep test fixtures and
release screenshots free of account IDs, ARNs, SSO URLs, instance IDs, private
addresses, hostnames, and key paths.
