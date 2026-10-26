# Changelog

## Unreleased

- initial AppPilot desktop shell and application discovery layer,
- search and filter app catalog,
- package-manager availability detection,
- startup and process inspection support,
- React + TypeScript desktop frontend foundation.

## Limitations

- Tauri bundle packaging requires GTK and WebKit development libraries on the host system.
- Some package-manager actions are gated by `pkexec` availability and system configuration.
