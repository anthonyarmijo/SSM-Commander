# Troubleshooting

## Environment is blocked

The required end-user dependencies are AWS CLI v2 and the Session Manager
plugin. Use the Initialize page to inspect the active profile and local tools.
Packaged macOS DMGs bundle their FreeRDP libraries; installing Homebrew FreeRDP
is only necessary for a source build.

## Profile validation fails

Confirm the selected profile can authenticate:

```sh
aws sts get-caller-identity --profile your-profile
aws sso login --profile your-profile
```

SSM Commander reads the standard AWS shared files directly. Ensure the profile,
region, and expected SSO session are configured there.

## Instances are missing or not ready

Verify that the profile can list the selected region and that the instance is a
managed node with a running SSM Agent:

```sh
aws ec2 describe-instances --profile your-profile --region us-west-2 --output json
```

The identity and instance role need the permissions required by Session Manager.

## Embedded RDP does not open

On macOS, native FreeRDP connects directly to the local SSM tunnel. Check the
Windows RDP service, tunnel, username, password, domain, and selected RDP
security mode. The Console reports a native FreeRDP error code on disconnect.
Close and reopen the console to negotiate a different initial resolution.

On Windows, embedded RDP is the legacy Guacamole renderer. Its `npm start`
development workflow requires Docker Desktop and manages `guacd` locally. Raw
`npm run tauri:dev` leaves that bridge under your control. See
[dependency setup](dependency-setup.md) for development requirements.

## Credential vault does not unlock

The vault needs the original master passphrase and cannot recover a lost one.
Deleting a vault from app data discards its saved SSH/RDP connection details;
do so only when you are prepared to recreate them. Locking the vault clears
edited secrets from renderer state.

## Tunnels keep running

Use Stop in SSM Activity. Application shutdown stops owned SSM tunnel processes
and embedded console sessions. Shell sessions opened in an external terminal
must be closed from that terminal.
