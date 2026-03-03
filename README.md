# pi-updater

A Codex-style auto-updater for Pi.

> **Note:** Currently supports npm installations only.

<img width="800" height="482" alt="Screenshot 2026-02-28 at 09 01 37" src="https://github.com/user-attachments/assets/89df2dad-8d91-464b-b3cb-dfd15bce1c06" />

## What it does

**On startup:** if a newer version is available, shows a prompt:
- **Update now** — install with npm, then restart pi
- **Skip** — dismiss until next session
- **Skip this version** — don't ask again until a newer version appears

**`/update`:** manually check for updates (always fetches fresh from npm)

## How version checks work

pi-updater uses a cache-first approach to avoid slowing down startup with network requests:

1. On startup, the cached latest version is checked instantly against your installed version
2. A background fetch updates the cache for the next run
3. `/update` always fetches fresh from npm

This means there's a **one-start delay** when a new pi version is released — the first start after a release updates the cache in the background, and the update prompt appears on the next start.

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

## Updating this package

```bash
pi update
```

## License

MIT
