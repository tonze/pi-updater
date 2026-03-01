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

Version checks are cached. Latest version is fetched in the background on startup.

## Install

```bash
pi install npm:pi-updater
```

Or from git:

```bash
pi install git:github.com/tonze/pi-updater
```

> **Upgrading from ≤ 0.2.6?** Earlier versions included `@mariozechner/pi-coding-agent` as a peer dependency. This caused npm to silently update pi itself whenever pi-updater was installed or updated — bypassing the update prompt entirely. Fixed in 0.2.7 by removing the peer dependency.

## Usage

Use `/update` inside pi to manually check for updates and install them.

## Updating this package

```bash
pi update
```

## License

MIT
