# Testing locally

## Automated checks

```bash
npm ci
npm test
npm run typecheck
```

The regression tests run the extension with mocked network, cache, and UI boundaries. They check stale-context and prompt failures, nonblocking startup, the consolidated prompt, and cached-version fallback. Model-hint tests cover family matching, availability, local models, Codex identities, cache expiry, failure backoff, canonical-alias deduplication across launches, and scope changes during a request. Installer tests check all native update targets; demo tests check every action, cancellation, offline use, and the absence of side effects. No updates are installed and no live catalog requests are made.

`npm run typecheck` checks the minimum development baseline, Pi 0.74.1. Also verify extension loading and type compatibility against current Pi when changing the extension APIs. Model hints should quietly skip hosts without `ctx.scopedModels`.

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

Shows fixture Pi and extension updates in the real combined prompt, alongside two model hints rendered with the active theme. Select any update action to see 1.5 seconds of simulated progress for the corresponding native command. Skip or Escape dismisses the prompt; Escape also cancels progress.

The demo makes no network requests, reads or writes no caches, and never installs, reloads, restarts, or changes model scope. It works with `PI_OFFLINE=1` and requires an interactive terminal. For a recording without real startup checks:

```bash
PI_OFFLINE=1 pi -ne -e /Users/toms/dev/pi-updater/index.ts --no-session
```

Then run `/update --test`.

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

## Releasing

1. Choose an unpublished version (`npm view pi-updater version` shows the current release). Update `package.json` and both root version fields in `package-lock.json`. Move the `Unreleased` changelog entries under that version and the release date.
2. Run `npm test`, `npm run typecheck`, and `npm pack --dry-run`. There is no build step: the package ships TypeScript directly. Check that the archive contains only `package.json`, `index.ts`, `model-updates.ts`, `README.md`, and `CHANGELOG.md`.
3. Commit the release changes on a branch and open a PR. Reference the reports with `Fixes #<issue>` and include the validation results. Squash-merge after reviewing the diff and checks.
4. Switch back to `main`, run `git pull --ff-only`, and confirm the working tree is clean. Publish from the merged commit. Check `npm whoami`; use `npm login` if needed. The account must have publish access to `pi-updater`.
5. Run `npm publish` and complete any authentication prompt. An accepted upload can remain in npm validation before becoming public. Verify both `npm view pi-updater@<version> version` and `npm view pi-updater version` report the new version. Download the published package and verify its contents. Do not republish merely because validation is taking time; published versions cannot be reused.
6. Tag the merged release commit as `v<version>` and push that tag. Do not move an existing release tag to include later documentation changes.
7. Create a GitHub Release from that tag, using the reviewed changelog entries as its notes. Mark it **Latest**: `gh release create v<version> --verify-tag --title v<version> --notes-file <release-notes-file> --latest`. A pushed Git tag alone does not update GitHub's Releases sidebar.
8. Verify the public npm version, pushed tag, and published GitHub Release all match. Only then call the release complete or announce it. Users can update with `pi update npm:pi-updater`, then `/reload`.
