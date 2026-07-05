# Changelog

## 0.4.1 - 2026-07-05

- Combined prompt: group update actions together, Skip last.
- README: new screenshot showing the combined pi + extensions prompt.

## 0.4.0 - 2026-07-05

- Detect outdated extension packages (same check as pi's "Package Updates Available" banner) and offer to update them interactively.
- Combined prompt when both pi and extensions are outdated: "Update all" (`pi update --self --extensions`), pi only, or extensions only.
- Extensions-only prompt when pi is current but packages are outdated: runs `pi update --extensions`, then hot-reloads via `ctx.reload()` (from `/update`) or restarts into the same session (from the startup prompt, which cannot trigger a reload).
- Selecting an update option is the only interaction: no separate restart confirmation afterwards, and the restarted pi skips its startup check once so partial updates don't immediately re-prompt.
- Startup shows one consolidated prompt after both checks resolve (never a partial offer); the cached pi version is now only a fallback for failed fetches.
- `/update` now checks both pi and extension packages.
- Raise install timeout to 5 minutes to accommodate multi-package updates.
- Treat killed (timed-out) update processes as failures so a partial install never reloads or restarts as success.
- Use `pi update --self --extensions` instead of `--all` for compatibility with pi < 0.80.
- Version dismissal is now "Ignore <version>" and only offered in the pi-only prompt.

## 0.3.4 - 2026-07-05 (not published to npm; included in 0.4.0)

- Delegate installs to pi's native `pi update --self` command so npm, pnpm, yarn, bun, and standalone installs use pi's own update logic.
- Remove the npm-only package migration installer now that the legacy package migration window is closed.
- Remove all legacy `@mariozechner` support: static `@earendil-works/pi-coding-agent` import, no owning-package detection, no package-name tracking in the cache. Requires pi 0.74.0+ (`@earendil-works` scope); older installs can pin `pi-updater@0.3.3`.
- Keep pi-updater focused on the interactive prompt, cache-first update checks, and auto-restart flow.

## 0.3.3 - 2026-05-21

- Honor the update service `packageName` and install the explicit advertised npm package/version.
- Avoid native `pi update --self` so pi-updater can update through stale native self-update behavior.
- Keep loading under the legacy `@mariozechner/pi-coding-agent` runtime so package-name migrations can run.
- Migrate the global pi binary when the update service advertises a new package name by force-installing the advertised package after an engine-strict dry run.
- Treat package-name-only migrations as updates only when the advertised version is unchanged or newer, while staying on the current package if `packageName` is absent.
- Respect npm engine requirements during pi installs so updates fail safely when Node.js is too old.
- Switch extension imports and optional peer dependency to `@earendil-works/pi-coding-agent` so installing pi-updater no longer pulls the old `@mariozechner` pi package.

## 0.3.2 - 2026-05-02

- Use pi's native `pi update --self` installer on pi 0.70.3+ and keep npm install as the fallback for older pi versions.
- Use pi's `https://pi.dev/api/latest-version` update endpoint with a `pi/<version>` user agent.
- Keep pi-updater's interactive startup prompt on pi 0.70.3+ while avoiding pi's duplicate built-in version notice.

## 0.3.1 - 2026-04-04

- Compatibility with pi 0.65+: use `session_start` instead of legacy `session_switch` for automatic checks. See [pi-mono v0.65.0](https://github.com/badlogic/pi-mono/releases/tag/v0.65.0).
- Store cache and dismissed-version state in pi's configured agent directory.
- Preserve `--no-session` mode when restarting after an update and show the correct manual restart hint.

## 0.3.0 - 2026-03-23

- Auto-restart pi after a successful update. Asks to restart, then seamlessly relaunches on the current session.
- Falls back to manual restart message in non-interactive modes or if restart fails.
- Cross-platform: uses `shell: true` on Windows to handle `.cmd` shims.
- `/update --test` to simulate the full update flow without a real install.

## 0.2.9 - 2026-03-16

- Keep startup checks cache-first and non-blocking.
- Add a one-time background live check per run.
- Show update prompt in the same session when the background check finds a newer version.
- Respect `PI_SKIP_VERSION_CHECK` and `PI_OFFLINE` for automatic checks.
- Avoid duplicate automatic prompts for the same version in one run.
- `/update` now warns and exits early when `PI_OFFLINE` is set.
