# pi-updater

A lightweight, Codex-style auto-updater for pi with fast, cache-first startup checks.

- npm: https://www.npmjs.com/package/pi-updater
- repo: https://github.com/tonze/pi-updater

> **Note:** pi-updater delegates installation to pi's native `pi update --self` command, so npm, pnpm, yarn, bun, and standalone installs follow pi's own update rules. Requires pi 0.74.0+ (`@earendil-works` scope); for older pi installs pin `pi-updater@0.3.3`.

<img width="800" height="482" alt="Screenshot 2026-02-28 at 09 01 37" src="https://github.com/user-attachments/assets/89df2dad-8d91-464b-b3cb-dfd15bce1c06" />

## What it does

If a newer version is available, pi-updater shows a startup prompt:
- **Update now** — run `pi update --self`, then auto-restart pi on the current session
- **Skip** — dismiss until next session
- **Skip this version** — don't ask again until a newer version appears

After a successful update, pi-updater asks whether to restart immediately. If confirmed, pi relaunches seamlessly on the current session. In non-interactive modes or if auto-restart fails, it falls back to a manual restart message. Ephemeral `--no-session` runs stay ephemeral on restart.

**`/update`:** manually check for updates (always fetches fresh from pi's update service, unless `PI_OFFLINE` is set). Installation is handled by pi's native updater, including package-manager detection and unsupported-install messages.

## How version checks work

pi-updater uses a cache-first approach to keep startup fast:

1. On startup, cached version data is checked instantly.
2. One background live fetch refreshes the cache from pi's update service.
3. If the background fetch finds a newer version, pi-updater can prompt in the same session.
4. Automatic checks are skipped when `PI_SKIP_VERSION_CHECK` or `PI_OFFLINE` is set.

## Install

```bash
pi install npm:pi-updater
```

Or from git:

```bash
pi install git:github.com/tonze/pi-updater
```

## Usage

Use `/update` inside pi to manually check for updates and install them.

Cache and dismissed-version state are stored in pi's configured agent directory and respect `PI_CODING_AGENT_DIR`.

## Environment flags

Disable automatic version checks:

```bash
export PI_SKIP_VERSION_CHECK=1
```

Or run in offline mode (also disables automatic checks):

```bash
export PI_OFFLINE=1
```

## Updating this package

```bash
pi update
```

## License

MIT
