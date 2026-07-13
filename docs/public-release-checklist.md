# Public Release Checklist

The complete recurring release runbook is [docs/releasing.md](releasing.md).
This page is the short final gate; the old one-time fresh-repository export is
not part of the normal release path.

- [ ] Version, changelog, tag, and release assets agree on `vX.Y.Z`.
- [ ] Frontend, Rust, secret-scan, DMG, signing, notarization, and bundle checks pass.
- [ ] The GitHub release is still a draft and contains the Apple Silicon DMG and SHA-256 checksum.
- [ ] A clean-Mac smoke test and any required PIV/CAC validation are complete.
- [ ] Screenshots and fixtures are fictional and contain no account IDs, ARNs, SSO URLs, profile names, instance IDs, addresses, hostnames, or key paths.
- [ ] No vault exports, private keys, Apple credentials, certificates, or environment files are included.
- [ ] A human has reviewed the draft release and deliberately publishes it.
