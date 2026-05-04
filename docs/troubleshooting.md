# Troubleshooting

## Environment Is Blocked

Run the environment check in Initialize. Required dependencies are AWS CLI v2 and the Session Manager Plugin. OpenSSH and guacd are reported separately because some workflows can still work without them.

## Profile Validation Fails

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

The MVP lists pending, running, stopping, and stopped instances.

## SSM Is Not Ready

The instance must be a managed node, the SSM Agent must be running, and IAM permissions must allow Session Manager access. The app checks `describe-instance-information` and labels instances as ready, offline, or not managed.

## Embedded RDP Does Not Open

Embedded RDP uses Apache Guacamole's `guacd` protocol bridge. The app shows
"Embedded RDP is not ready" when it cannot find a `guacd` binary or connect to a
bridge on `127.0.0.1:4822`.

For the standard local workflow, start the app with:

```sh
npm start
```

That command requires Docker Desktop to be running. It starts the Guacamole
container, launches Tauri dev mode, and stops the container when you quit.

On macOS, Homebrew may not provide a `guacamole-server` formula. For development,
you can also run the official `guacd` container manually:

```sh
docker run --rm --name ssm-commander-guacd \
  -p 127.0.0.1:4822:4822 \
  guacamole/guacd
```

In another terminal, verify the bridge is reachable:

```sh
nc -zv 127.0.0.1 4822
```

If you already have a native `guacd` binary, start it on the address and port the
app expects:

```sh
guacd -f -b 127.0.0.1 -l 4822
```

Packaged builds can use a bundled guacd sidecar. RDP credentials entered in Console are kept in memory only.

For domain-joined Windows hosts, enter credentials with the Windows domain prefix,
for example `cyber\pkiadmin`. Embedded RDP splits that into Guacamole's separate
`domain` and `username` parameters. The Instances page also includes an advanced
RDP security selector with Auto, NLA, NLA-Ext, TLS, and RDP options; Auto leaves
security negotiation to `guacd`.

## Raw Tauri Dev Mode

Use raw Tauri dev mode when you want to manage Docker or native `guacd`
yourself:

```sh
npm run tauri:dev
```

This does not start or stop the Guacamole container.

## Tunnels Keep Running

Use Stop in the SSM Activity panel. On app shutdown, owned SSM tunnel processes and embedded Console sessions are terminated. Shell sessions launched in an external terminal must be closed from that terminal.
