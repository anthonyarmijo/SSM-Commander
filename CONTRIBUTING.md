# Contributing to SSM Commander

## Development prerequisites

Install Node.js 22, npm, and Rust stable. Clone with submodules, or initialize
the pinned FreeRDP source after cloning:

```sh
git submodule update --init --recursive
npm ci
```

On macOS, install FreeRDP 3 with Homebrew (`brew install freerdp`). The native
renderer compiles against its headers and libraries. On Windows, install Docker
Desktop when exercising the legacy Guacamole embedded-RDP development path.

## Run locally

`npm start` is the normal desktop development command. On macOS it launches the
native FreeRDP renderer directly. On Windows it manages a local `guacd` bridge
for the development session. Alternatives are `npm run tauri:dev` for raw Tauri
development and `npm run dev` for the frontend alone.

## Validate changes

Run the checks appropriate to the change before opening a pull request:

```sh
npm test
npm run lint
npm run build
cd src-tauri && cargo test && cargo check
```

On macOS, test native RDP changes with a disposable Windows host when possible.
For packaging or release checks, follow [docs/releasing.md](docs/releasing.md).

## Contribution expectations

Keep changes scoped, add or update tests for behavior changes, and update user
documentation when workflows change. Never commit AWS credentials, exported
vaults, private keys, real profile data, or screenshots containing environment
identifiers. Preserve platform behavior: macOS uses native FreeRDP; Windows
retains the legacy Guacamole renderer for embedded RDP development.
