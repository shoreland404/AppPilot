# Changelog

Notable changes to AppPilot are recorded here.

## 0.2.0

- Added a Windows native backend for WinGet inventory, live search, exact current-user installs, per-app and grouped updates, verified package removal, and Start menu launching.
- Added Windows Startup-folder controls and process listing with current-user ownership checks before stop requests.
- Added platform-specific package integration status and guidance when WinGet is not available.
- Added a first-run guide that links application launch, catalogue search, and updates to their relevant pages.
- Added persistent library sorting and a clear-all-filters action.
- Added a persistent compact library layout without reducing text size.
- Set the initial appearance from the operating-system theme, while retaining a manual light/dark toggle.
- Added `/` to focus application search and `Escape` to clear and close it.
- Reduced visual noise and startup rendering cost; the interface no longer relies on remote fonts or backdrop blur and honours reduced-motion preferences.
- Added Linux and Windows CI checks and GitHub Release automation for AppImage, NSIS `.exe`, and MSI `.msi` installers.
- Tag builds attach the Linux and Windows installers directly to the GitHub Release; manual builds expose workflow artifacts.

## 0.1.0

- Replaced browser demo data and simulated package actions with a native-runtime-only Linux interface.
- Added live desktop-entry discovery with conservative APT, Flatpak, Snap, local, and system attribution.
- Added startup-entry, process, and package-update views backed by local Linux data.
- Added verified per-application update/removal flows and authorization prompts.
- Added responsive overview, application details, theme preferences, and error/empty states.
