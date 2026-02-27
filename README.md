# pi-updater

Check for new pi versions and install without leaving your session — especially useful when pi is *not* on [OSS vacation](https://github.com/badlogic/pi-mono) and shipping multiple releases a day.

## What it does

- **On startup**: if a newer version is known, shows a prompt with three choices:
  - **Update now** — installs via your package manager
  - **Skip** — dismiss until next session
  - **Skip this version** — don't ask again until an even newer version appears
- **`/update`**: manually check for updates (always fetches fresh from npm)

Version checks are cached (`~/.pi/agent/update-cache.json`). On every startup, the latest version is fetched from npm in the background. The current launch uses the cached value; the next launch sees the fresh result.

Cross-platform. Detects npm, pnpm, yarn, and bun automatically.

## Install

```bash
pi install git:github.com/tonze/pi-updater
```

## Usage

The update prompt appears automatically on startup when a new version is available. You can also check manually:

```
/update
```

## License

MIT
