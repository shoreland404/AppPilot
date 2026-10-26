# Contributing to AppPilot

Thanks for helping improve AppPilot.

## Ways to contribute

- report bugs,
- improve desktop discovery logic,
- refine Linux package-manager handling,
- strengthen security-focused behavior,
- document edge cases and platform limitations.

## Workflow

1. Fork the repository and create a branch.
2. Make a focused change with clear tests or validation steps.
3. Run the relevant checks for the frontend or native backend.
4. Open a pull request with a brief summary, evidence, and any known limitations.

## Coding expectations

- keep Linux-specific behavior explicit,
- avoid random shell construction from UI text,
- prefer validated subprocess arguments over string interpolation,
- document any unresolved platform limitations.
