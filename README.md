# pi-updater

pi-updater is a [pi](https://pi.dev) extension that turns pi's update notice
into an interactive flow: it prompts you when a new version is available,
installs it without leaving your session, and restarts pi right back into the
session you were in.

- npm: https://www.npmjs.com/package/pi-updater
- repo: https://github.com/tonze/pi-updater

<img width="800" height="482" alt="Screenshot 2026-02-28 at 09 01 37" src="https://github.com/user-attachments/assets/89df2dad-8d91-464b-b3cb-dfd15bce1c06" />

## Why does this exist?

pi already checks for updates and can update itself with `pi update`. But the
built-in flow is: see a notice, finish what you're doing, quit pi, run
`pi update`, start pi again, run `pi -c` to get your session back. That's five
steps for something that should be one keypress.

pi-updater collapses this into a prompt. Choose "Update now" and it installs
the new version and relaunches pi on your current session. You can also skip
once, or skip a specific version so it stops asking until the next release.

The actual installation is delegated to pi's native `pi update --self`
command. pi knows how it was installed (npm, pnpm, yarn, bun, or a standalone
binary) and updates itself accordingly; pi-updater deliberately does not
reimplement any of that. This extension owns the interactive experience,
nothing more.

## Installation

```bash
pi install npm:pi-updater
```

Requires pi 0.74.0 or later (the `@earendil-works` package scope). On older
installs the extension fails to load harmlessly; if you need it there, pin
`pi-updater@0.3.3`.

## Usage

There is nothing to configure. On startup, pi-updater checks both pi itself
and your installed extension packages (the same check behind pi's "Package
Updates Available" banner).

If only pi is outdated:

- **Update now** — run `pi update --self`, then restart pi on the current session
- **Skip** — ask again next session
- **Skip this version** — don't ask again until a newer version appears

If both pi and extensions are outdated, a combined prompt appears:

- **Update all** — run `pi update --self --extensions`, then restart
- **Update pi only** — run `pi update --self`, then restart
- **Update extensions only** — run `pi update --extensions`, then reload or restart to load them
- **Skip** / **Skip this pi version**

If only extensions are outdated, you're offered `pi update --extensions`.
From `/update` the reload happens automatically — no restart needed, since
extension updates take effect via reload. From the startup prompt (where
reload isn't available to extensions) you're offered a quick restart instead.

You can also check manually at any time with `/update`.

Extension updates have no per-version skip; choosing Skip simply asks again
next session. Pinned (`@version` / `#ref`) and local packages are excluded,
matching pi's own update check.

After a successful update, pi-updater asks whether to restart immediately. In
non-interactive modes, or if the restart fails, it falls back to a message
telling you how to restart yourself. Ephemeral `--no-session` runs stay
ephemeral across the restart.

### How version checks work

Startup stays fast because checks are cache-first:

1. On startup, the cached result is checked instantly (no network).
2. One background fetch per run refreshes the cache from pi's update service.
3. If the background fetch finds a newer version, the prompt appears in the
   same session.

`/update` always fetches fresh. Cache and dismissed-version state live in pi's
agent directory and respect `PI_CODING_AGENT_DIR`.

### Disabling checks

pi's standard environment variables are respected:

```bash
export PI_SKIP_VERSION_CHECK=1   # disable automatic checks
export PI_OFFLINE=1              # offline mode, also disables checks
```

While pi-updater is active it suppresses pi's built-in update notice so you
don't get prompted twice for the same release. pi's "Package Updates
Available" banner cannot be suppressed the same way, so it may still appear
alongside pi-updater's extension prompt.

## Caveats

Because installation is delegated to pi, pi's limitations apply: standalone
binary installs get download instructions instead of an automatic install, and
Windows self-update covers npm and pnpm installs only. In those cases you'll
see pi's own message explaining what to do.

## Updating pi-updater itself

```bash
pi update npm:pi-updater
```

## License

MIT
