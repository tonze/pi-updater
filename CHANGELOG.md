# Changelog

## Unreleased

- Detect pi install method and use the matching update command (`pnpm`, `yarn`, `bun`, or `npm`) instead of always using npm.
- Read the actual installed pi version from the running CLI entrypoint so update prompts compare against the real version, not the extension's bundled peer dependency.
- Respect `PI_CODING_AGENT_DIR` for updater cache location and preserve `--no-session` on auto-restart.
- Fall back to release download instructions for standalone binary installs.

## 0.3.0 - 2026-03-23

- Auto-restart pi after a successful update. Asks to restart, then seamlessly relaunches on the current session.
- Falls back to manual restart message in non-interactive modes or if restart fails.
- Cross-platform: uses `shell: true` on Windows to handle `.cmd` shims.
- `/update --test` to simulate the full update flow without a real install.

## 0.2.9 - 2026-03-16

- Keep startup checks cache-first and non-blocking.
- Add a one-time background live check per run.
- Show update prompt in the same session when the background check finds a newer version.
- Respect `PI_SKIP_VERSION_CHECK` and `PI_OFFLINE` for automatic checks.
- Avoid duplicate automatic prompts for the same version in one run.
- `/update` now warns and exits early when `PI_OFFLINE` is set.
