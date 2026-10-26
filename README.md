# AppPilot

AppPilot is a native Linux desktop application manager built with Tauri 2, React, TypeScript, and Rust. It discovers application launchers and system state from the machine it is running on; it does not ship a fabricated app catalogue or simulated package-manager results.

## What it does

- Discovers visible application desktop entries in the current XDG, Flatpak, and Snap application directories.
- Identifies APT ownership from `dpkg-query` and recognizes installed Flatpak and Snap applications from their own local inventories.
- Launches installed applications through the desktop-entry system (`gio launch`).
- Browses applications available from the Flatpak remotes already configured on the computer and installs them with an explicit confirmation.
- Saves an application favourites list and filters the library by source and desktop category.
- Reads XDG startup entries and live process names / resident memory from `/proc`; user-owned startup entries can be enabled or disabled.
- Can request graceful termination of a process owned by the current user, with confirmation.
- Checks for available APT, Flatpak, and Snap updates using the installed package-manager tools.
- Supports per-package and grouped updates, plus removal for packages it can verify; destructive actions require confirmation and privileged work goes through the system authorization prompt.
- Offers dark and light themes, with the selection saved locally in the app.

## Performance

AppPilot does not scan processes or startup folders during its initial launch. Those inventories are loaded only when their pages are opened. Desktop package ownership is queried in batches, and the discovered application list is cached in memory for one minute. Package-manager and filesystem work runs off the UI thread; there are no periodic background scans.

Package metadata is deliberately conservative. Launchers whose package owner cannot be proven are labelled `System` or `Local`, and package actions remain unavailable for them.

## Platform support

The first supported target is **x86_64 Linux** (Ubuntu 24.04-based distributions). AppPilot uses Linux desktop-entry conventions, XDG autostart, `/proc`, APT, Flatpak, Snap, and `pkexec`.

Windows and macOS installers are not currently produced: their native application-discovery and package-management backends have not been implemented. The release workflow only publishes the supported Linux AppImage.

## Requirements

- Linux desktop session with GTK 3 and WebKitGTK 4.1 development libraries
- Node.js 22.12+ and npm 10+
- Rust 1.90+ (stable recommended)
- `gio` for launching desktop entries

On Ubuntu, install the native build dependencies with:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libgtk-3-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

## Run locally

From the repository root:

```bash
npm ci
npm run tauri:dev
```

`npm run dev` starts only the browser interface. Since a browser has no access to the native Linux backend, AppPilot shows a clear desktop-runtime notice instead of displaying sample applications or pretending that system operations succeeded.

## GitHub builds

The GitHub Actions workflows are the source of release builds; a local AppImage build is not required.

- Pushes and pull requests run frontend and Rust quality checks.
- To build an AppImage on GitHub, open **Actions → Linux release → Run workflow**. Download the `AppPilot-linux-x86_64` artifact from the completed run; workflow artifacts are retained for 14 days.
- Pushing a version tag such as `v0.1.0` builds the AppImage and attaches it to a GitHub Release.

CI runs frontend lint/build, Rust formatting, backend tests, and Clippy on Linux.

## Security and privacy

- Installed-application inventory and process details stay local. The Discover page contacts only the Flatpak remotes configured on the computer when the user opens, refreshes, or installs an application; AppPilot has no telemetry or third-party application catalogue.
- Frontend package operations identify an installed application by its desktop-entry ID. The Rust backend re-reads the launcher and package metadata before running an action.
- Commands are launched with explicit argument arrays; no user-provided string is executed through a shell.
- Install and removal require explicit user confirmation. Flatpak installs are re-checked against the selected configured remote; user installs stay in the current account and system-wide installs use `pkexec`.
- AppPilot only offers package operations when the package manager and package identity can be verified.
- Application names and system details are displayed from local OS data. Browser-only mode never substitutes demo data.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Contributing

Contributions are welcome. Please include the Linux distribution, relevant package-manager state, and the exact validation commands used in your pull request. Keep platform-support claims aligned with working native backends.

## License

AppPilot is licensed under the MIT License. See [LICENSE](LICENSE).
