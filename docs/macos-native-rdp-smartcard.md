# macOS Native RDP and PIV/CAC Redirection

On macOS, SSM Commander’s embedded RDP console uses the upstream FreeRDP Mac
client view directly. It is placed in the app’s console workspace above the
web interface and connects to the same loopback port opened by the SSM RDP
tunnel. It does **not** send RDP graphics, keyboard input, or smart-card APDUs
through Guacamole or a browser API.

This is the preferred macOS renderer because FreeRDP implements the RDP
smart-card virtual channel and macOS already exposes PIV/CAC readers through
PC/SC.

## Using a card in a Windows VM

1. Insert the PIV/CAC card and make sure its macOS middleware can see it.
   `system_profiler SPSmartCardsDataType` is a useful first check.
2. Open an RDP console from the instance view.
3. Turn on **Share macOS PIV/CAC smart card with this RDP session** before
   opening the console.
4. In the Windows VM, use an application that supports the redirected Windows
   smart-card reader. The VM’s RDP host and domain policy must allow smart-card
   device redirection.

The checkbox maps to FreeRDP’s `/smartcard` option: it forwards the PC/SC
smart-card protocol, not a raw USB device. This is intentional: it works with
PIV/CAC software while avoiding browser/WebUSB permission and device-ownership
problems.

SSM Commander checks macOS SmartCard Services and displays a preflight message
when it cannot see a PC/SC reader. A detected reader does not itself prove that
a card is inserted or that the target Windows policy permits redirection.

## Scope and limitations

- This is for using a card *inside an established Windows desktop* (for
  example, browser, certificate, signing, or middleware activity in the VM).
- The native launch currently requires an RDP username and password. They stay
  in memory for the session or can come from the encrypted local vault.
- For an Active Directory account, enter either a plain username with the
  **RDP domain** field, or enter `DOMAIN\\username` and leave that field blank.
  The native renderer passes the domain and username as separate CredSSP/NLA
  settings; this is important for password logon to a domain-joined host.
- If FreeRDP cannot establish the connection, the console reports the
  disconnection and its FreeRDP error code instead of leaving a blank native
  view. Check the credentials, Windows RDP service, and the SSM tunnel before
  retrying.
- The initial remote resolution is derived from the available console pane, not
  a fixed `16:9` mode. The native view smart-scales as the app window changes;
  reopen the console when a different negotiated Windows desktop resolution is
  required.
- Smart-card authentication during RDP/NLA logon is a separate flow and is not
  yet exposed as a supported SSM Commander login mode. Validate that scenario
  separately before relying on it.
- The first implementation is macOS-first. Windows continues to use the
  Guacamole renderer, with the system RDP client as its external fallback.
- The native view uses the pinned upstream FreeRDP source submodule at
  `src-tauri/vendor/freerdp`; update and test it deliberately. During the
  macOS build, SSM Commander creates a local copy of `MRDPView.m` that converts
  mouse positions from window to view coordinates. This small compatibility
  adjustment keeps pointer input accurate when the RDP view starts beside the
  app sidebar; it does not modify the checked-out upstream submodule.
- The current 1.1.0 direct-distribution build is not App Store sandboxed. Do
  not add App Store sandbox or smart-card entitlements to this build without a
  separately established platform requirement.

## Development and packaging

The macOS Rust build compiles the upstream `MRDPView` sources using the local
Homebrew FreeRDP 3 headers and libraries. Install FreeRDP first:

```sh
brew install freerdp
git submodule update --init --recursive
cd src-tauri && cargo check
```

Homebrew is normally discovered at `/opt/homebrew/opt/freerdp` on Apple Silicon
and `/usr/local/opt/freerdp` on Intel. To use another compatible FreeRDP 3
build, set `SSM_COMMANDER_FREERDP_PREFIX`; the build and packaging steps use
the same override.

The Tauri pre-bundle hook copies FreeRDP and WinPR dylibs to the application's
`Resources/lib` directory, rewrites the native executable to load them through
an app-local `@rpath`, and rejects remaining Homebrew links. Development
commands are in [CONTRIBUTING.md](../CONTRIBUTING.md); signing, notarization,
and DMG checks are in [docs/releasing.md](releasing.md).

## Validation matrix

Before treating this feature as production-ready, test a real card and Windows
VM combination for:

- a YubiKey PIV slot and, if applicable, the target CAC reader;
- certificate enumeration in the remote Windows smart-card UI;
- signing/authentication in the intended in-VM application;
- card removal/reinsertion while the session is open;
- reconnect, tab switching, session stop, and application shutdown;
- both password/NLA RDP login and the separately-supported smart-card logon
  policy if that is a requirement.
