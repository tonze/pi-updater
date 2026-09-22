# Testing locally

## Automated checks

```bash
npm ci
npm test
npm run typecheck
```

The regression tests run the extension with mocked network, cache, and UI boundaries. They check stale-context and prompt failures, nonblocking startup, the consolidated prompt, and cached-version fallback. No updates are installed.

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

Simulates: select → install (fake 1.5s) → restart on the same session. The prompt shows the native `pi update --self` command.

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

1. Update the version in `package.json` and both root version fields in `package-lock.json`. Add a dated entry to `CHANGELOG.md`. These are already prepared for 0.4.2.
2. Run `npm test`, `npm run typecheck`, and `npm publish --dry-run`. There is no build step: the package ships `index.ts` directly. Check that the archive contains only `package.json`, `index.ts`, `README.md`, and `CHANGELOG.md`.
3. Commit the release changes on a branch and open a PR. Reference the reports with `Fixes #<issue>` and include the validation results. Squash-merge after reviewing the diff and checks.
4. Switch back to `main`, run `git pull --ff-only`, and confirm the working tree is clean. Publish from the merged commit. Check `npm whoami`; use `npm login` if needed. The account must have publish access to `pi-updater`.
5. Run `npm publish` and complete any authentication prompt. Published versions cannot be reused.
6. Tag the merged release commit (`git tag v0.4.2`) and push that tag (`git push origin v0.4.2`). A GitHub release is optional; npm publication is what distributes the package. If npm publication is blocked, the tag can be prepared first, but keep any GitHub release as a draft until npm publication succeeds.
7. Verify `npm view pi-updater version` reports the new version. Users can update with `pi update npm:pi-updater`, then `/reload`.
