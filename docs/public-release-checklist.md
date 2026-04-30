# Public Release Checklist

Use a brand-new public repository for the first public release. Do not publish a repository that previously contained private environment metadata in any reachable, dangling, rewritten, forked, or cached history.

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

Before pushing, run the checks below in the fresh repository.

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
cd ..
git fsck --no-reflogs --full
```

Also manually inspect generated screenshots, docs, and release notes before the first public push.

## Notes

- `npm run scan:secrets` expects `gitleaks` to be installed locally.
- The CI workflow runs Gitleaks against full Git history on pull requests and pushes to `main`.
- Keep screenshots and preview fixtures fictional. Avoid account IDs, ARNs, SSO start URLs, profile names from real environments, instance IDs, private IPs, VPC/subnet IDs, hostnames, and key paths.
