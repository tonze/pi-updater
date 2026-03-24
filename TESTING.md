# Testing locally

## Setup

Uninstall the npm version and install from the local checkout:

```bash
pi uninstall npm:pi-updater
pi install /Users/toms/dev/pi-updater
```

Or load it directly without touching installed packages:

```bash
pi -ne -e /Users/toms/dev/pi-updater/index.ts
```

## Test the full UI flow

```
/update --test
```

Simulates: select → install (fake 1.5s) → confirm restart → restart on same session.

## Screen recording

To hide skills/extensions on startup, set in `~/.pi/agent/settings.json`:

```json
{
  "quietStartup": true
}
```

To simulate a real update with an older pi version:

```bash
npm install -g @mariozechner/pi-coding-agent@0.61.1
npm install -g pi-updater@0.3.0
pi
```

Both commands, that order. The pi downgrade nukes pi-updater from global node_modules, so the second install is required.

## Restore npm version

```bash
pi uninstall /Users/toms/dev/pi-updater
pi install npm:pi-updater
```
