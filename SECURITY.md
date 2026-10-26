# Security Policy

## Supported versions

This project is in active development. Security fixes are evaluated as they are reported.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainer or by opening a discreet issue with limited reproduction details. Do not disclose sensitive exploit details in public discussions until a resolution is available.

## Security expectations

- no password or token embedding,
- package operations are restricted to applications whose package identity can be verified from local system metadata,
- privileged package operations are launched through `pkexec` and destructive removal requires explicit confirmation,
- commands are executed with argument arrays; user-provided values are never passed through a shell,
- no hidden telemetry,
- no silent privilege escalation or fabricated success responses.

AppPilot is currently a Linux-only application. Its native package-management code should not be enabled on other platforms until platform-specific implementations and tests are available.
