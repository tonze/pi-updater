# pi-updater

Check for new pi versions and install updates. When a newer version is available, it can prompt on startup or be triggered manually with `/update`, then asks before restarting pi so you can resume with `pi -c`.

<img width="800" height="482" alt="Screenshot 2026-02-28 at 09 01 37" src="https://github.com/user-attachments/assets/89df2dad-8d91-464b-b3cb-dfd15bce1c06" />

## What it does

- **On startup**: if a newer version is known, shows a prompt with three choices:
  - **Update now** — installs the shown version with `npm`, then prompts you to restart pi
  - **Skip** — dismiss until next session
  - **Skip this version** — don't ask again until an even newer version appears
- **`/update`**: manually check for updates (always fetches fresh from npm)

Version checks are cached (`~/.pi/agent/update-cache.json`). On every startup, the latest version is fetched from npm in the background. The current launch uses the cached value; the next launch sees the fresh result.

Automatic updates currently use `npm`. If you installed pi another way, update it manually.

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
