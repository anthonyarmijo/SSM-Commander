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

Install or start `guacd` for development fallback:

```sh
brew install guacamole-server
guacd -f -l 127.0.0.1
```

Packaged builds can use a bundled guacd sidecar. RDP credentials entered in Console are kept in memory only.

## Tunnels Keep Running

Use Stop in the SSM Activity panel. On app shutdown, owned SSM tunnel processes and embedded Console sessions are terminated. Shell sessions launched in an external terminal must be closed from that terminal.
