# Changelog

Notable changes to AppPilot are recorded here.

## Unreleased

- Added a searchable Flatpak catalogue sourced from configured user and system remotes.
- Added confirmed Flatpak installation with live package verification and scope-aware authorization.
- Added downloadable AppImage artifacts to manually triggered GitHub release builds.
- Reduced launch work by deferring process and startup scans, batching APT ownership lookups, and caching the application inventory.
- Added persistent favourites and application filters for source and desktop category.
- Added controls for enabling or disabling user-owned startup entries.
- Added confirmed graceful termination for processes owned by the current user.
- Added grouped, one-confirmation updates across supported package managers.

## 0.1.0

- Replaced browser demo data and simulated package actions with a native-runtime-only Linux interface.
- Added live desktop-entry discovery with conservative APT, Flatpak, Snap, local, and system attribution.
- Added startup-entry, process, and package-update views backed by local Linux data.
- Added verified per-application update/removal flows and authorization prompts.
- Added responsive overview, application details, theme preferences, and error/empty states.
- Limited release automation to the supported Linux AppImage target.
