# Public Release Checklist

Use this checklist before publishing SSM Commander v1.0 or any later public release. Do not publish a repository that previously contained private environment metadata in any reachable, dangling, rewritten, forked, or cached history.

## Fresh Repository Export

Create the public repository from a clean archive of the current tree:

```sh
git archive --format=tar HEAD | tar -x -C ../ssm-commander-public
cd ../ssm-commander-public
git init
git add .
git commit -m "Initial public release"
git remote add origin <new-public-repo-url>
```

Before pushing a fresh public repository, run the checks below in the exported tree.

## Required Checks

```sh
npm ci
npm audit
npm test
npm run lint
npm run build
npm run scan:secrets
cd src-tauri
cargo test
cargo check
cd ..
git fsck --no-reflogs --full
```

Also manually inspect generated screenshots, docs, release notes, and the final `git status --short --branch` before publishing.

## Apple Silicon macOS DMG

Stage the generated Apache Guacamole `guacd` sidecar before building the DMG:

```sh
npm run stage:guacd:macos
file src-tauri/binaries/guacd-aarch64-apple-darwin
otool -L src-tauri/binaries/guacd-aarch64-apple-darwin
npm run tauri:build -- --target aarch64-apple-darwin --bundles dmg
```

Confirm `otool -L` output for `guacd` and staged dylibs does not reference
`/opt/homebrew` or `/usr/local/opt`. Generated files under
`src-tauri/binaries/` and `src-tauri/resources/macos/lib/` are local release
artifacts and should not be committed.

Configure signing and notarization with environment variables only:
`APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and
either `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` or `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`. Do not commit certificates, private keys,
notarization secrets, Apple credentials, or raw local credentials.

Reference Tauri's docs for
[external binaries](https://tauri.app/develop/sidecar/),
[macOS signing and notarization](https://tauri.app/distribute/sign/macos/), and
[platform-specific config](https://v2.tauri.app/ko/reference/config/).

## Tagging v1.0

Create the launch tag only after the release commit is verified:

```sh
git tag -a v1.0 -m "SSM Commander v1.0"
git tag --list v1.0
```

Push the tag when you are ready to publish the GitHub release:

```sh
git push origin main v1.0
```

## Notes

- `npm run scan:secrets` expects `gitleaks` to be installed locally.
- The CI workflow runs Gitleaks against full Git history on pull requests and pushes to `main`.
- Keep screenshots and preview fixtures fictional. Avoid account IDs, ARNs, SSO start URLs, profile names from real environments, instance IDs, private IPs, VPC/subnet IDs, hostnames, and key paths.
- Saved SSH/RDP credentials belong only in the encrypted local vault. Do not commit exported vault files, pasted private keys, local key paths, or real connection screenshots.
