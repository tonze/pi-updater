import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { VERSION, BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const CACHE_FILE = join(getAgentDir(), "update-cache.json");
const UPDATE_COMMANDS = {
  self: { args: ["update", "--self"], display: "pi update --self" },
  extensions: { args: ["update", "--extensions"], display: "pi update --extensions" },
  // --self --extensions rather than --all: pi < 0.80 doesn't parse --all,
  // but the flag pair resolves to the "all" target on every supported version.
  all: { args: ["update", "--self", "--extensions"], display: "pi update --self --extensions" },
} as const;

type UpdateTarget = keyof typeof UPDATE_COMMANDS;

interface UpdateOffer {
  piLatest?: string;
  extensions: string[];
}

const ENV_SKIP_VERSION_CHECK = "PI_SKIP_VERSION_CHECK";
const ENV_OFFLINE = "PI_OFFLINE";
const ENV_INTERNAL_SKIP = "PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK";

interface VersionCache {
  latestVersion: string;
  dismissedVersion?: string;
  checkedAt?: string;
}

function readCache(): VersionCache | undefined {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeCache(cache: VersionCache) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache) + "\n");
  } catch {}
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return undefined;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4],
  };
}

function isNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  if (left.major !== right.major) return left.major > right.major;
  if (left.minor !== right.minor) return left.minor > right.minor;
  if (left.patch !== right.patch) return left.patch > right.patch;
  if (left.prerelease === right.prerelease) return false;
  if (!left.prerelease) return true;
  if (!right.prerelease) return false;
  return left.prerelease.localeCompare(right.prerelease) > 0;
}

function isEnvSet(name: string): boolean {
  return Boolean(process.env[name]);
}

const userSkippedVersionCheck =
  isEnvSet(ENV_SKIP_VERSION_CHECK) && !isEnvSet(ENV_INTERNAL_SKIP);

function shouldSkipAutoChecks(): boolean {
  return userSkippedVersionCheck || isEnvSet(ENV_OFFLINE);
}

function isOffline(): boolean {
  return isEnvSet(ENV_OFFLINE);
}

function piUserAgent(): string {
  const runtime = process.versions.bun
    ? `bun/${process.versions.bun}`
    : `node/${process.version}`;
  return `pi/${VERSION} (${process.platform}; ${runtime}; ${process.arch})`;
}

async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(LATEST_VERSION_URL, {
      headers: {
        "User-Agent": piUserAgent(),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    if (typeof data.version !== "string" || !data.version.trim()) return undefined;
    return data.version.trim();
  } catch {
    return undefined;
  }
}

/**
 * Check for outdated extension packages using pi's own package manager —
 * the same code path behind pi's startup "Package Updates Available" banner.
 * These exports are not documented extension API, so degrade gracefully.
 */
async function checkForExtensionUpdates(cwd: string): Promise<string[]> {
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as Record<string, any>;
    const { DefaultPackageManager, SettingsManager } = mod;
    if (
      typeof DefaultPackageManager !== "function" ||
      typeof SettingsManager?.create !== "function"
    ) {
      return [];
    }
    const agentDir = getAgentDir();
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
    });
    const updates = await packageManager.checkForAvailableUpdates();
    if (!Array.isArray(updates)) return [];
    return updates
      .map((update) => String(update?.displayName ?? update?.source ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Returns a cached upgrade version if available and not dismissed. */
function getCachedUpgradeVersion(): string | undefined {
  const cache = readCache();
  if (!cache) return undefined;
  if (!isNewer(cache.latestVersion, VERSION)) return undefined;
  if (cache.dismissedVersion === cache.latestVersion) return undefined;
  return cache.latestVersion;
}

function saveLatestToCache(latest: string) {
  const prev = readCache();
  writeCache({
    latestVersion: latest,
    dismissedVersion: prev?.dismissedVersion,
    checkedAt: new Date().toISOString(),
  });
}

/** Fetch latest from Pi's update endpoint and refresh cache. */
async function refreshLatestVersionInCache(): Promise<string | undefined> {
  const latest = await fetchLatestVersion();
  if (!latest) return undefined;
  saveLatestToCache(latest);
  return latest;
}

function dismissVersion(version: string) {
  const cache = readCache();
  writeCache({
    latestVersion: cache?.latestVersion ?? version,
    dismissedVersion: version,
    checkedAt: cache?.checkedAt,
  });
}

function isBunFsPath(path: string): boolean {
  return path.includes("$bunfs") || path.includes("~BUN") || path.includes("%7EBUN");
}

/**
 * Command that re-invokes the currently running pi, regardless of what
 * `pi` on PATH points to. For Node installs this is `node <entrypoint>`;
 * for Bun standalone binaries the executable itself is pi.
 */
function currentPiCommand(args: string[]): { program: string; args: string[] } {
  const entry = process.argv[1];
  if (entry && !isBunFsPath(entry)) {
    return { program: process.execPath, args: [entry, ...args] };
  }
  return { program: process.execPath, args };
}

interface InstallFailure {
  code: number;
  output: string;
}

function formatInstallFailure(failure: InstallFailure, display: string): string {
  return `Update failed while running \`${display}\` (exit ${failure.code})${failure.output ? `: ${failure.output}` : ""}`;
}

async function runNativeUpdate(
  pi: ExtensionAPI,
  target: UpdateTarget,
): Promise<InstallFailure | undefined> {
  const previousSkip = process.env[ENV_SKIP_VERSION_CHECK];
  const previousInternalSkip = process.env[ENV_INTERNAL_SKIP];
  delete process.env[ENV_SKIP_VERSION_CHECK];
  delete process.env[ENV_INTERNAL_SKIP];

  try {
    const cmd = currentPiCommand([...UPDATE_COMMANDS[target].args]);
    const result = await pi.exec(cmd.program, cmd.args, { timeout: 300_000 });
    if (result.code !== 0) {
      return {
        code: result.code,
        output: [result.stderr, result.stdout].filter(Boolean).join("\n").trim(),
      };
    }
  } finally {
    if (previousSkip === undefined) delete process.env[ENV_SKIP_VERSION_CHECK];
    else process.env[ENV_SKIP_VERSION_CHECK] = previousSkip;

    if (previousInternalSkip === undefined) delete process.env[ENV_INTERNAL_SKIP];
    else process.env[ENV_INTERNAL_SKIP] = previousInternalSkip;
  }
}

export default function (pi: ExtensionAPI) {
  // Take over pi's built-in version notice with our interactive prompt,
  // unless the user disabled version checks themselves.
  const suppressNativeCheck = !userSkippedVersionCheck;
  if (suppressNativeCheck) {
    process.env[ENV_SKIP_VERSION_CHECK] = "1";
    process.env[ENV_INTERNAL_SKIP] = "1";
  }

  let promptOpen = false;
  const promptedVersions = new Set<string>();
  let liveCheckStarted = false;

  function canAutoRestart(ctx: ExtensionContext): boolean {
    return ctx.hasUI && !!process.stdin.isTTY && !!process.stdout.isTTY;
  }

  async function restartPi(ctx: ExtensionContext): Promise<boolean> {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const restartArgs = sessionFile ? ["--session", sessionFile] : ["--no-session"];
    const cmd = currentPiCommand(restartArgs);
    const env = { ...process.env };
    if (suppressNativeCheck) {
      delete env[ENV_SKIP_VERSION_CHECK];
      delete env[ENV_INTERNAL_SKIP];
    }

    return ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
      tui.stop();
      const result = spawnSync(cmd.program, cmd.args, {
        cwd: ctx.cwd,
        env,
        stdio: "inherit",
        windowsHide: false,
      });
      tui.start();
      tui.requestRender(true);
      done(!result.error && (result.status === null || result.status === 0));
      return { render: () => [], invalidate: () => {} };
    });
  }

  async function reloadExtensions(ctx: ExtensionContext) {
    // Command contexts (/update) can hot-reload in place — the best path.
    const maybeReload = (ctx as { reload?: () => Promise<void> }).reload;
    if (typeof maybeReload === "function") {
      ctx.ui.notify("Extensions updated. Reloading...", "info");
      await maybeReload.call(ctx);
      return;
    }
    // Event contexts (startup prompt) can't reload programmatically.
    // Restart into the same session instead — at startup this is cheap
    // and the user already consented by choosing "Update now".
    if (canAutoRestart(ctx)) {
      const ok = await restartPi(ctx);
      if (ok) {
        ctx.shutdown();
        return;
      }
    }
    ctx.ui.notify("Extensions updated. Run /reload to load them.", "info");
  }

  async function doInstall(ctx: ExtensionContext, target: UpdateTarget, piLatest?: string) {
    const command = UPDATE_COMMANDS[target];
    const success = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Running ${command.display}...`);
      loader.onAbort = () => done(false);

      runNativeUpdate(pi, target)
        .then((failure) => {
          if (failure) {
            ctx.ui.notify(formatInstallFailure(failure, command.display), "error");
            done(false);
          } else {
            done(true);
          }
        })
        .catch((error) => {
          ctx.ui.notify(
            `Update failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          done(false);
        });

      return loader;
    });

    if (!success) return;

    if (target === "extensions") {
      await reloadExtensions(ctx);
      return;
    }

    const latest = piLatest ?? "latest";
    const restartTip = ctx.sessionManager.getSessionFile()
      ? "Tip: run `pi -c` to continue this session."
      : "Tip: run `pi --no-session` to continue without a saved session.";

    if (!canAutoRestart(ctx)) {
      ctx.ui.notify(
        `Updated to ${latest}! Please restart pi.\n${restartTip}`,
        "info",
      );
      return;
    }

    // No confirmation: choosing the update option was the consent, and the
    // restart relaunches straight into the current session.
    const ok = await restartPi(ctx);
    if (ok) {
      ctx.shutdown();
      return;
    }

    ctx.ui.notify(
      `Updated to ${latest}! Auto-restart failed. Please restart pi manually.\n${restartTip}`,
      "error",
    );
  }

  async function showUpdatePrompt(ctx: ExtensionContext, offer: UpdateOffer) {
    const { piLatest, extensions } = offer;
    const extList = extensions.join(", ");

    if (piLatest && extensions.length > 0) {
      const updateAll = `Update all (${UPDATE_COMMANDS.all.display})`;
      const updatePi = `Update pi only (${UPDATE_COMMANDS.self.display})`;
      const updateExtensions = `Update extensions only (${UPDATE_COMMANDS.extensions.display})`;
      const choice = await ctx.ui.select(
        `Update pi ${VERSION} → ${piLatest} · extensions: ${extList}`,
        [updateAll, updatePi, updateExtensions, "Skip", "Skip this pi version"],
      );

      if (!choice || choice === "Skip") return;
      if (choice === "Skip this pi version") {
        dismissVersion(piLatest);
        return;
      }
      if (choice === updateAll) return doInstall(ctx, "all", piLatest);
      if (choice === updatePi) return doInstall(ctx, "self", piLatest);
      if (choice === updateExtensions) return doInstall(ctx, "extensions");
      return;
    }

    if (piLatest) {
      const updateAction = `Update now (${UPDATE_COMMANDS.self.display})`;
      const choice = await ctx.ui.select(`Update ${VERSION} → ${piLatest}`, [
        updateAction,
        "Skip",
        "Skip this version",
      ]);

      if (!choice || choice === "Skip") return;
      if (choice === "Skip this version") {
        dismissVersion(piLatest);
        return;
      }
      if (choice !== updateAction) return;
      await doInstall(ctx, "self", piLatest);
      return;
    }

    if (extensions.length > 0) {
      const updateAction = `Update now (${UPDATE_COMMANDS.extensions.display})`;
      const choice = await ctx.ui.select(`Extension updates available: ${extList}`, [
        updateAction,
        "Skip",
      ]);
      if (choice === updateAction) await doInstall(ctx, "extensions");
    }
  }

  function canAutoPromptVersion(latest: string): boolean {
    if (!isNewer(latest, VERSION)) return false;
    if (promptedVersions.has(latest)) return false;
    if (readCache()?.dismissedVersion === latest) return false;
    return true;
  }

  let queuedOffer: { latest: string | undefined; extensions: string[] } | undefined;

  async function maybeShowAutoPrompt(
    ctx: ExtensionContext,
    latest: string | undefined,
    extensions: string[],
  ) {
    if (!ctx.hasUI) return;
    if (promptOpen) {
      // A prompt is open (e.g. the instant cached pi prompt). Queue this
      // offer instead of dropping it; it is re-checked once the prompt closes.
      queuedOffer = { latest, extensions };
      return;
    }

    const piLatest = latest && canAutoPromptVersion(latest) ? latest : undefined;
    if (!piLatest && extensions.length === 0) return;

    promptOpen = true;
    if (piLatest) promptedVersions.add(piLatest);
    try {
      await showUpdatePrompt(ctx, { piLatest, extensions });
    } finally {
      promptOpen = false;
    }

    if (queuedOffer) {
      const next = queuedOffer;
      queuedOffer = undefined;
      // Deduped by promptedVersions/dismissed checks, so this terminates.
      await maybeShowAutoPrompt(ctx, next.latest, next.extensions);
    }
  }

  function runAutoChecks(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (shouldSkipAutoChecks()) return;

    // Cache-first: show a known pi update instantly, before any network.
    const cached = getCachedUpgradeVersion();
    if (cached) void maybeShowAutoPrompt(ctx, cached, []);

    if (liveCheckStarted) return;
    liveCheckStarted = true;

    void Promise.all([
      refreshLatestVersionInCache().catch(() => undefined),
      checkForExtensionUpdates(ctx.cwd).catch(() => [] as string[]),
    ])
      .then(([latest, extensions]) => {
        // promptedVersions dedupes the pi part if the cached prompt already ran.
        void maybeShowAutoPrompt(ctx, latest ?? getCachedUpgradeVersion(), extensions);
      })
      .catch(() => {});
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload" || event.reason === "fork") return;
    runAutoChecks(ctx);
  });

  pi.registerCommand("update", {
    description: "Check for pi updates and install with pi's native updater",
    handler: async (rawArgs, ctx) => {
      // /update --test — simulate the full UI flow without a real install
      if (rawArgs?.trim() === "--test") {
        const fakeLatest = "99.0.0";
        const updateAction = `Update now (${UPDATE_COMMANDS.self.display})`;
        const choice = await ctx.ui.select(`Update ${VERSION} → ${fakeLatest}`, [
          updateAction,
          "Skip",
          "Skip this version",
        ]);
        if (!choice || choice === "Skip" || choice === "Skip this version") return;
        if (choice !== updateAction) return;

        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, `Running ${UPDATE_COMMANDS.self.display}...`);
          loader.onAbort = () => done();
          setTimeout(() => done(), 1500);
          return loader;
        });

        if (!canAutoRestart(ctx)) {
          ctx.ui.notify(`Updated to ${fakeLatest}! Please restart pi.`, "info");
          return;
        }

        const ok = await restartPi(ctx);
        if (ok) { ctx.shutdown(); return; }
        ctx.ui.notify("Test restart failed.", "error");
        return;
      }

      if (isOffline()) {
        ctx.ui.notify(
          "PI_OFFLINE is set. Disable it to check for updates.",
          "warning",
        );
        return;
      }

      const result = await ctx.ui.custom<{
        latest: string | undefined;
        extensions: string[];
      } | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          "Checking for updates...",
        );
        loader.onAbort = () => done(null);
        Promise.all([
          fetchLatestVersion().catch(() => undefined),
          checkForExtensionUpdates(ctx.cwd).catch(() => [] as string[]),
        ])
          .then(([latest, extensions]) => done({ latest, extensions }))
          .catch(() => done(null));
        return loader;
      });

      if (!result || (!result.latest && result.extensions.length === 0)) {
        ctx.ui.notify("Could not reach Pi update service.", "error");
        return;
      }

      const { latest, extensions } = result;
      if (latest) saveLatestToCache(latest);

      const piLatest = latest && isNewer(latest, VERSION) ? latest : undefined;

      if (!piLatest && extensions.length === 0) {
        ctx.ui.notify(
          `Already on latest version (${VERSION}). Extensions are up to date.`,
          "info",
        );
        return;
      }

      if (piLatest) promptedVersions.add(piLatest);
      await showUpdatePrompt(ctx, { piLatest, extensions });
    },
  });
}
