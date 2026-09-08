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

Simulates: select → install (fake 1.5s) → confirm restart → restart on same session. The prompt shows the command that would actually run — `pi update --self`, or a configured `selfUpdateCommand`.

## Test a custom self-update command

No install happens, so any command is safe here:

```bash
PI_UPDATER_SELF_COMMAND='echo pretend-upgrade' pi
```

Then run `/update --test` and check the loader label. Same for the config file at `~/.pi/agent/pi-updater.json` (or `$PI_CODING_AGENT_DIR/pi-updater.json`).

## Screen recording

To hide skills/extensions on startup, set in `~/.pi/agent/settings.json`:

```json
{
  "quietStartup": true
}
```

## Restore npm version

```bash
pi uninstall /Users/toms/dev/pi-updater
pi install npm:pi-updater
```
