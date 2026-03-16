# pi-updater

A lightweight, Codex-style auto-updater for pi with fast, cache-first startup checks.

- npm: https://www.npmjs.com/package/pi-updater
- repo: https://github.com/tonze/pi-updater

> **Note:** Automatic installation currently supports npm-based pi installs only.

<img width="800" height="482" alt="Screenshot 2026-02-28 at 09 01 37" src="https://github.com/user-attachments/assets/89df2dad-8d91-464b-b3cb-dfd15bce1c06" />

## What it does

**On startup:** if a newer version is available, shows a prompt:
- **Update now** — install with npm, then restart pi
- **Skip** — dismiss until next session
- **Skip this version** — don't ask again until a newer version appears

**In the background (once per run):** performs one live npm check and can show the prompt in the same session when a new release is detected.

**`/update`:** manually check for updates (always fetches fresh from npm, unless `PI_OFFLINE` is set).

## How version checks work

pi-updater uses a cache-first approach to keep startup fast:

1. On startup, cached version data is checked instantly.
2. One background live fetch refreshes the cache.
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
