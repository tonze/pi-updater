# pi-updater

A Codex-style auto-updater for Pi.

> **Note:** Currently supports npm installations only. If you installed pi another way, update manually.

<img width="800" height="482" alt="Screenshot 2026-02-28 at 09 01 37" src="https://github.com/user-attachments/assets/89df2dad-8d91-464b-b3cb-dfd15bce1c06" />

## What it does

**On startup:** if a newer version is available, shows a prompt:
- **Update now** — install with npm, then restart pi
- **Skip** — dismiss until next session
- **Skip this version** — don't ask again until a newer version appears

**`/update`:** manually check for updates (always fetches fresh from npm)

After installing, pi shuts down. Resume where you left off with `pi -c`.

Version checks are cached (`~/.pi/agent/update-cache.json`). Latest version is fetched in the background on startup — the *next* launch sees the fresh result.

## Install

```bash
pi install git:github.com/tonze/pi-updater
```

## Updating this extension

Already installed? Get the latest with:

```bash
pi update
```

## Usage

Update prompt appears automatically on startup when a new version is available. Or check manually:

```
/update
```

## License

MIT
