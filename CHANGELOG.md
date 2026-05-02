# Changelog

## 0.3.2 - 2026-05-02

- Use pi's native `pi update --self` installer on pi 0.70.3+ and keep npm install as the fallback for older pi versions.
- Use pi's `https://pi.dev/api/latest-version` update endpoint with a `pi/<version>` user agent.
- Keep pi-updater's interactive startup prompt on pi 0.70.3+ while avoiding pi's duplicate built-in version notice.

## 0.3.1 - 2026-04-04

- Compatibility with pi 0.65+: use `session_start` instead of legacy `session_switch` for automatic checks. See [pi-mono v0.65.0](https://github.com/badlogic/pi-mono/releases/tag/v0.65.0).
- Store cache and dismissed-version state in pi's configured agent directory.
- Preserve `--no-session` mode when restarting after an update and show the correct manual restart hint.

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
