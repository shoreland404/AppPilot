# AppPilot

AppPilot is a native desktop application manager for Linux and Windows, built with Tauri 2, React, TypeScript, and Rust. It reads the real application and package-manager state of the computer it is running on; it does not ship a fabricated catalogue or simulate successful system changes.

## What it does

- **15 everyday capabilities:** system overview; installed-app library; instant library search; source/category filters; favourites; alphabetical sorting; one-click filter reset; application details; desktop launching; Flatpak/WinGet discovery; package installation; individual updates; grouped updates; verified removal; and startup/process controls.
- **Linux:** discovers desktop launchers and package ownership from XDG, APT, Flatpak, and Snap; launches apps through the desktop; browses configured Flatpak remotes; installs, updates, and removes packages when identity can be verified.
- **Windows:** discovers WinGet-managed apps, searches the live WinGet catalogue, installs exact package IDs for the current user, checks and applies individual or grouped updates, uninstalls exact package IDs, and opens matching Start menu shortcuts.
- Reads and manages user-owned startup entries (Linux XDG entries and Windows Startup-folder shortcuts).
- Shows processes visible to the current user and only offers stop actions after checking process ownership.
- Saves favourites, filters by source and category, sorts the library, and offers a one-click way to clear filters.
- Provides a first-run guide, keyboard search (`Ctrl+K` or `/`), a system-aware theme default, and a persistent compact library layout.
- Keeps application data and preferences on the device. AppPilot has no telemetry.

### Windows requirements

AppPilot uses WinGet, which is provided by **App Installer**. Install or update App Installer from Microsoft Store to use the Windows application inventory, catalogue, and package actions. Only package identities reported by WinGet are manageable; other Windows software is not guessed or removed.

WinGet installs are restricted to the current user. Package names and IDs are passed as individual process arguments, not evaluated as shell commands. App launching looks for an exact-name Start menu shortcut and reports when one cannot be found.

### Linux requirements

The Linux build targets x86_64 and uses GTK 3, WebKitGTK 4.1, XDG desktop entries, `/proc`, APT, Flatpak, Snap, and `pkexec` where available. Package actions are offered only when AppPilot can verify the local package identity.

## Performance and accessibility

Process and startup inventories are loaded only when their pages are opened. APT package ownership is queried in batches and the Linux application inventory is cached briefly in memory. Long-running operating-system commands execute outside the UI thread; AppPilot does not poll the system in the background.

The interface avoids remote fonts and background effects, follows the operating system's reduced-motion preference, uses readable contrast and spacing, and lets users choose a compact library layout. Search and filters are local except for an explicit WinGet catalogue search or a Flatpak catalogue request.

## GitHub Releases

The release workflow builds the supported desktop installers on GitHub Actions. No local package build is required.

1. Push a version tag, for example `v0.2.0`.
2. Open the generated **GitHub Release** for that tag.
3. Download `AppPilot_*_amd64.AppImage` for Linux or the `.exe` (NSIS) / `.msi` installer for Windows.

The workflow also runs manually from **Actions → Desktop release → Run workflow**. Manually triggered builds are downloadable from the completed workflow's **Artifacts** section for 14 days; tag builds additionally attach all installers to the GitHub Release.

Pull requests and pushes run frontend lint/build plus Rust formatting, tests, and Clippy on Linux and Windows.

## Development

Requirements: Node.js 22.12+, npm 10+, and Rust 1.90+.

```bash
npm ci
npm run tauri:dev
```

`npm run dev` starts only the browser interface. A browser has no native package-manager access, so AppPilot displays a clear runtime notice instead of sample data or simulated actions.

Linux development dependencies on Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libgtk-3-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

Windows development requires the Microsoft C++ Build Tools, WebView2 Runtime, and WinGet/App Installer.

## Security and privacy

- Installed-application inventory, process details, and preferences stay local.
- Linux package operations re-read launcher and package metadata before acting. System-level operations use the operating system's authorization prompt.
- Windows package IDs are validated and passed as explicit WinGet arguments. Process termination is limited to processes owned by the current user.
- Install and removal require confirmation; user startup entries are distinguished from system-owned entries.
- Browser-only mode never substitutes demo data.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Contributing

Contributions are welcome. Include the operating system, package-manager state, and exact validation commands in pull requests. Keep platform-support claims aligned with working native backends.

## License

AppPilot is licensed under the MIT License. See [LICENSE](LICENSE).
