# AppPilot

AppPilot is a Linux desktop application manager built with Tauri, React, TypeScript, and Rust. It helps users discover installed software, inspect desktop launchers, review package-manager status, and safely launch or manage applications from local sources without exposing unrestricted shell access to the UI.

## Purpose

AppPilot is designed for Ubuntu-based and Zorin OS-style Linux desktops. It focuses on

- fast local discovery of desktop applications,
- clear source attribution for APT, Flatpak, Snap, and local launcher entries,
- package-manager integration with explicit privilege checks,
- safe launch and package operations,
- a polished desktop experience with a compact app catalog and details panel.

## Current status

This repository contains the first working implementation of the AppPilot shell and desktop discovery layer. The front-end is implemented in React + TypeScript and is validated with a production build. The Rust backend handles desktop-entry discovery, startup application inspection, process metadata, and validated package actions. Full native Tauri packaging is currently limited by missing GTK system libraries in this build environment.

## Supported platforms

- Primary target: Ubuntu-based Linux desktop environments
- Secondary candidate: Zorin OS 18-style distributions
- Architecture: x86_64 Linux

## Features

- Sidebar-based desktop navigation
- Search and source filtering for app catalog entries
- Desktop entry parsing for user/system application directories
- Startup application detection and basic process inspection
- Package-manager status detection for APT, Flatpak, and Snap
- Assistant-style package action validation with `pkexec` checks
- Dark/light theme toggle
- Real local data only; no fake statistics or fabricated app catalog

## Architecture

- Frontend: React + TypeScript + Vite
- Desktop shell: Tauri 2
- Native logic: Rust
- Data sources: desktop-entry files, process metadata, and command availability checks

## Development setup

Requirements:

- Node.js 20+
- npm 9+
- Rust stable toolchain
- Tauri runtime dependencies for Linux

Install and run:

```bash
npm install
npx -p node@20 -- npm run dev
```

For production validation:

```bash
npx -p node@20 -- npm run build
```

## Build notes and limitations

The project’s frontend build succeeds in this environment. The native Tauri build is blocked by missing GTK system libraries, specifically `gdk-3.0.pc` and related development packages. The exact error observed is:

```text
Package gdk-3.0 was not found in the pkg-config search path.
```

On Debian/Ubuntu systems, this is typically resolved with the Linux Tauri dependencies installed via the package manager, for example:

```bash
sudo apt-get install build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

If those packages are not available on the system, the native bundle cannot compile until the required libraries are installed.

## Security model

- No credentials are embedded in source code.
- Package operations only run through validated command arguments.
- Privileged actions require `pkexec` when supported.
- Frontend components do not expose unrestricted shell capability.
- There is no hidden telemetry or automatic remote network call in the app logic.

## Running the app

The project is structured for Tauri desktop execution after native dependencies are present:

```bash
npx -p node@20 -- npm install
cargo test --manifest-path src-tauri/Cargo.toml
npx -p node@20 -- npm run build
```

## Contributing

Contributions are welcome. Please open an issue or pull request with a concise explanation of the change and validation steps. Keep changes focused, testable, and consistent with the Linux desktop security model.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
