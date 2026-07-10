# Troubleshooting

## Environment Is Blocked

Run the environment check in Initialize. Required dependencies are AWS CLI v2
and the Session Manager Plugin. OpenSSH, the bundled terminal PTY, and FreeRDP
are reported as workflow-specific tools; the legacy Guacamole bridge is not an
Environment requirement.

## Profile Validation Fails

The Initialize page discovers profiles by reading the standard AWS shared files
directly: `~/.aws/config` and `~/.aws/credentials`. On macOS, packaged builds
also look for AWS CLI tools in common Homebrew and system locations so launching
the app from Finder or `open` does not require modifying your shell startup
files.

Try:

```sh
aws sts get-caller-identity --profile your-profile
```

For SSO profiles, refresh login:

```sh
aws sso login --profile your-profile
```

## Instances Do Not Appear

Confirm the selected profile and region can list EC2 instances:

```sh
aws ec2 describe-instances --profile your-profile --region us-west-2 --output json
```

The Instances view lists pending, running, stopping, and stopped instances.

## SSM Is Not Ready

The instance must be a managed node, the SSM Agent must be running, and IAM permissions must allow Session Manager access. The app checks `describe-instance-information` and labels instances as ready, offline, or not managed.

## Embedded RDP Does Not Open

On macOS, embedded RDP uses the native FreeRDP view directly against the local
SSM tunnel. Confirm that the Windows RDP service is reachable through the
tunnel, then check the username, password, domain, and selected RDP security
mode. A native error code is shown in the Console tab when FreeRDP disconnects.

For a local macOS development build, install FreeRDP 3 and initialize the
source submodule:

```sh
brew install freerdp
git submodule update --init --recursive
```

The initial remote desktop size is selected from the visible console pane and
the view smart-scales after window resizes. Close and reopen the console to
negotiate a different Windows desktop resolution.

On Windows, embedded RDP remains the legacy Guacamole implementation and needs
`guacd`. The normal development workflow is:

```sh
npm start
```

That command requires Docker Desktop. To manage the bridge manually:

```sh
docker run --rm --name ssm-commander-guacd \
  -p 127.0.0.1:4822:4822 \
  guacamole/guacd
```

For domain-joined Windows hosts, enter credentials with the Windows domain prefix,
for example `EXAMPLE\admin`. The Windows legacy renderer separates that into
its `domain` and `username` parameters; macOS passes equivalent native FreeRDP
settings. The Instances page also includes an RDP security selector with Auto,
NLA, NLA-Ext, TLS, and RDP options.

## Credential Vault Does Not Unlock

The credential vault requires the same master passphrase used when it was created. New vaults require a stronger passphrase. SSM Commander cannot recover a lost vault passphrase; delete the local vault from your app data directory only if you are prepared to recreate saved SSH/RDP credentials.

When the vault is locked, saved credential options are unavailable and console launches fall back to manual entry. Locking the vault or leaving the Credentials view clears edited credential secrets from renderer state.

## Raw Tauri Dev Mode

Use raw Tauri dev mode when you want to manage the Windows legacy `guacd`
bridge yourself:

```sh
npm run tauri:dev
```

On macOS this starts the native FreeRDP renderer directly. On Windows it does
not start or stop the Guacamole container.

## Tunnels Keep Running

Use Stop in the SSM Activity panel. On app shutdown, owned SSM tunnel processes and embedded Console sessions are terminated. Shell sessions launched in an external terminal must be closed from that terminal.
