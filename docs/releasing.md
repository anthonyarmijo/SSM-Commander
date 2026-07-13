# Releasing SSM Commander

This is the recurring release runbook for `vX.Y.Z`. Tag creation, pushing, and
publication are deliberate human-controlled actions. The release workflow never
publishes a GitHub Release; it creates or updates a **draft** only.

## Scope

The first official macOS pipeline targets Apple Silicon only:
`aarch64-apple-darwin`. It does not build Intel or universal binaries. A future
updater is a separate phase requiring an updater signing key and stable release
hosting; it is not configured for this release.

## Before changing the version

1. Review `CHANGELOG.md` and retain genuinely unfinished work under
   `[Unreleased]`.
2. Choose the next semantic version and use the full tag format `vX.Y.Z`.
3. Check that no unrelated worktree changes, secrets, or non-fictional fixtures
   are included.

## Version synchronization

Update the authoritative version sources together:

- `package.json` and the root package entry in `package-lock.json`
- `src-tauri/Cargo.toml` and the `ssm-commander` package in `Cargo.lock`
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md`, release notes, and version examples in documentation

Verify them before tagging:

```sh
rg -n '"version": "X.Y.Z"|version = "X.Y.Z"|\[X.Y.Z\]' \
  package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock \
  src-tauri/tauri.conf.json CHANGELOG.md
```

## Apple Developer setup (one time)

An official direct-distribution build needs an Apple Developer membership, a
Developer ID Application certificate exported as base64 `.p12`, and an App
Store Connect API key with the access required for notarization. Configure these
repository secrets; never commit them:

- `APPLE_CERTIFICATE` — base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD` — password protecting that `.p12`
- `APPLE_SIGNING_IDENTITY` — Developer ID Application certificate identity
- `APPLE_API_ISSUER` — App Store Connect issuer ID
- `APPLE_API_KEY` — App Store Connect key ID
- `APPLE_API_KEY_P8` — contents of the one-time-downloaded API key file

The workflow writes the API key to a temporary file and supplies Tauri's
`APPLE_API_KEY_PATH`. It uses Tauri's supported signing and notarization
variables, with App Store Connect credentials preferred over Apple ID/password
notarization. See the official [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/)
and [Apple notarization documentation](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution).

## Local release preparation

Use an Apple Silicon Mac with current Xcode command-line tools. Initialize the
FreeRDP submodule and install the native build dependency:

```sh
git submodule update --init --recursive
brew install freerdp gitleaks
npm ci
npm test
npm run lint
npm run build
cd src-tauri && cargo test && cargo check && cd ..
npm run scan:secrets
```

Build the DMG through the normal Tauri command. The configured pre-bundle hook
stages the FreeRDP/WinPR dynamic-library closure before Tauri signs and bundles
the app:

```sh
npm run tauri:build -- --target aarch64-apple-darwin --bundles dmg
```

Do not replace this hook or commit generated staging outputs. The direct
distribution configuration preserves hardened runtime and the macOS 12.0
minimum. No App Store sandbox or smart-card entitlement is configured without a
demonstrated requirement.

## Bundle and DMG validation

For the produced `.app` and DMG, verify all of the following:

- The executable and every staged dylib have no `/opt/homebrew`,
  `/usr/local/opt`, or Cellar dependency.
- `Contents/Resources/licenses/FreeRDP-LICENSE` is present.
- Nested FreeRDP/WinPR libraries are signed before final application signing;
  verify the final bundle with `codesign --verify --deep --strict --verbose=2`.
- Assess the app with `spctl` where the host permits it.
- Validate stapling with `xcrun stapler validate` for the app and DMG.
- Generate a SHA-256 checksum for the final named DMG.

The release workflow performs these checks after its `tauri-apps/tauri-action`
build. It fails official tag builds for missing signing/notarization credentials,
missing licenses, residual Homebrew links, code-signature failures, or stapling
failures. Gatekeeper assessment is reported but may be unavailable on a hosted
runner.

## GitHub Actions release flow

`.github/workflows/release.yml` starts on tags matching `v*.*.*` and then
enforces the exact `vX.Y.Z` format before building. It checks out recursive
submodules, installs Node.js 22, Rust stable, Homebrew FreeRDP, and Gitleaks;
runs frontend and Rust checks; scans secrets; and builds only the Apple Silicon
DMG.

For a valid tag, signing/notarization secrets are mandatory. After verification,
the workflow uploads a versioned `SSM-Commander_X.Y.Z_aarch64.dmg` and its
`.sha256` to a draft GitHub Release. It will refuse to alter an already
published release.

`workflow_dispatch` performs a non-publishing validation build. Its default is
unsigned and deliberately skips signature, Gatekeeper, and stapling checks; its
artifact is not an official release. Set the `notarize` input only when the
required secrets are configured to exercise the signed/notarized path.

## Release and publication checklist

1. Run a clean-Mac smoke test from the packaged DMG with AWS CLI v2 and the
   Session Manager plugin installed, but without a Homebrew FreeRDP dependency.
2. Test the key workflows needed for the release. When PIV/CAC is in scope, test
   reader/card detection, in-VM enumeration, removal/reinsertion, reconnect,
   tab switching, and shutdown. Do not claim smart-card NLA logon unless it has
   separately passed its required matrix.
3. Commit the reviewed version and documentation changes. Do not include
   generated artifacts, certificates, keys, credentials, or vault exports.
4. Deliberately create and verify the tag only after the commit is final:

   ```sh
   git tag -a vX.Y.Z -m "SSM Commander vX.Y.Z"
   git show vX.Y.Z
   git push origin vX.Y.Z
   ```

5. Review the draft release, named DMG, checksum, automated checks, and smoke
   results. Publish the draft manually when release owners approve it.

## Failure and rollback guidance

Do not publish a failed or unsigned official artifact. Correct the cause in a
new commit, retest, and use a new semantic version/tag if the original tag has
escaped the release team. If a draft is wrong, edit or delete the draft and its
assets before publication. If a published version must be withdrawn, mark it as
superseded, communicate the risk and replacement version, and avoid rewriting
public tags or release history.
