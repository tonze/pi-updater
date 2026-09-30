# pi-updater

pi-updater checks for [pi](https://pi.dev) and extension updates and lets you
install them from your current session. It also shows newer releases in your
scoped model families, without changing your models or settings.

- npm: https://www.npmjs.com/package/pi-updater
- repo: https://github.com/tonze/pi-updater

<img width="800" alt="Combined Pi and extension update prompt with Update all selected" src="https://raw.githubusercontent.com/tonze/pi-updater/main/docs/images/update-prompt.png" />

*Simulated updates.*

Pi already detects updates. This extension adds the prompt, installation,
and return to your session. Installation uses Pi's native `pi update` command;
pi-updater does not manage packages itself.

## Installation

```bash
pi install npm:pi-updater
```

Requires pi 0.74.0 or later (the `@earendil-works` package scope). On older
installs the extension fails to load harmlessly; if you need it there, pin
`pi-updater@0.3.3`.

## Usage

Checks run in the background on startup. Run `/update` to check manually.
There is nothing to configure.

If only pi is outdated:

- **Update now** — run `pi update --self`, then restart pi on the current session
- **Skip** — ask again next session
- **Ignore \<version\>** — don't ask again until a newer version appears

If both pi and extensions are outdated, a combined prompt appears:

- **Update all** — run `pi update --self --extensions`, then restart
- **Update pi only** — run `pi update --self`, then restart
- **Update extensions only** — run `pi update --extensions`, then reload
- **Skip** — ask again next session

If only extensions are outdated, you're offered `pi update --extensions`.
Extension-only updates reload in place when invoked through `/update`. From
the startup prompt, Pi restarts into the current session instead.

"Ignore" is only offered in the Pi-only prompt and suppresses automatic
prompts for that version. Manual `/update` checks still offer it.

Extension updates have no per-version skip; choosing Skip simply asks again
next session. Pinned (`@version` / `#ref`) and local packages are excluded,
matching pi's own update check.

In non-interactive modes, or if the restart fails, pi-updater falls back to
a message telling you how to restart yourself. Ephemeral `--no-session` runs
stay ephemeral across the restart.

### How version checks work

The Pi version check uses Pi's update service. Extension checks use Pi's
package manager. The prompt waits for both checks without blocking startup.
If the automatic version check fails, it can use a cached result.

After an update restarts Pi, the startup check is skipped once. `/update`
requests fresh results. Cache and dismissed-version state live in Pi's agent
directory and respect `PI_CODING_AGENT_DIR`.

### Scoped models

If a newer release in one of your scoped model families is available through
the same provider, pi-updater shows a notice:

<img width="800" alt="Scoped-model notices showing newer Sol and Sonnet releases through openai-codex and anthropic" src="https://raw.githubusercontent.com/tonze/pi-updater/main/docs/images/model-updates.png" />

*Simulated updates.*

Run `/scoped-models` to review your scope.

This is a suggestion, not an automatic upgrade. Pi-updater never switches
models or edits your scope. A newer release is not necessarily a better fit
or a drop-in replacement.

- On startup, each suggested release is shown once per provider. This is
  remembered across sessions, including known aliases of the same release.
- `/update` requests fresh metadata and shows eligible suggestions again.
- Adding the suggested release to your scope removes the suggestion.

Matching uses [models.dev](https://models.dev) family and release-date metadata
and Pi's available-model list. The notice compares the newest scoped release
with the newest eligible release in the same family. OpenAI Codex uses OpenAI
metadata but only suggests models available through Codex. Deprecated models
can serve as scoped baselines but are never suggested as upgrades.

Unknown local/custom models and entries without family metadata or complete
release dates are skipped. No explicit scope means no model check. This
requires Pi's scoped-model API, verified with 0.99.1. Older supported versions
still receive Pi and extension updates.

Model checks run independently of update prompts. The public catalog is cached
for four hours; requests time out after ten seconds. Failed requests retain
the last good catalog and also back off for four hours. Your scope and
credentials are not sent to models.dev. Matching happens locally.

Catalog metadata and shown-notice IDs are stored in `model-update-cache.json`
in Pi's agent directory. Offline mode skips requests and notices.
`PI_SKIP_VERSION_CHECK` disables automatic model checks too.

### Demo

Run `/update --test` in an interactive terminal to preview a combined Pi and
extension update prompt alongside model hints. All updates shown are fixtures;
choosing an update action only simulates progress. The command makes no network
requests or cache changes and never installs, reloads, or restarts Pi. It also
works offline.

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

## Limitations

Pi's native updater determines which installations can update automatically.
Standalone binary installs receive download instructions. Windows self-update
supports npm and pnpm installs only.

Model suggestions depend on catalog coverage and metadata. Pi-updater does
not infer model families from names or refresh your provider configuration.

## Updating pi-updater itself

```bash
pi update npm:pi-updater
```

## License

MIT
