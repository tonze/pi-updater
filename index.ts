import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  VERSION,
  BorderedLoader,
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { checkForModelUpdates, formatModelUpdates } from "./model-updates.js";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const CACHE_FILE = join(getAgentDir(), "update-cache.json");
const UPDATE_COMMANDS = {
  self: { args: ["update", "--self"], display: "pi update --self" },
  extensions: { args: ["update", "--extensions"], display: "pi update --extensions" },
  all: { args: ["update", "--all"], display: "pi update --all" },
} as const;

type UpdateTarget = keyof typeof UPDATE_COMMANDS;

interface UpdateOffer {
  piLatest?: string;
  extensions: string[];
}

const ENV_SKIP_VERSION_CHECK = "PI_SKIP_VERSION_CHECK";
const ENV_OFFLINE = "PI_OFFLINE";
const ENV_INTERNAL_SKIP = "PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK";
// One-shot: set on the pi process we restart into after an update, so the
// user is not immediately re-prompted for updates they just declined.
const ENV_SUPPRESS_STARTUP_CHECK = "PI_UPDATER_SUPPRESS_STARTUP_CHECK";

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

function createPackageManager(ctx: ExtensionContext): DefaultPackageManager {
  const cwd = ctx.cwd;
  // SettingsManager.create assumes a trusted project by default, so pass
  // pi's trust decision; otherwise an untrusted project's settings apply.
  const projectTrusted = ctx.isProjectTrusted();
  const agentDir = getAgentDir();
  return new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted }),
  });
}

/**
 * Check for outdated extension packages using pi's own package manager —
 * the same code path behind pi's startup "Package Updates Available" banner.
 * Network or npm failures and a stale ctx mean no extension offer.
 */
async function checkForExtensionUpdates(ctx: ExtensionContext): Promise<string[]> {
  try {
    const updates = await createPackageManager(ctx).checkForAvailableUpdates();
    return updates.map((update) => update.displayName);
  } catch {
    return [];
  }
}

/**
 * What is installed for every configured package: its package.json version
 * and, for a git checkout, its commit. Undefined when that cannot be read.
 */
async function readPackageRevisions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  try {
    const revisions: string[] = [];
    for (const { source, scope, installedPath } of createPackageManager(ctx).listConfiguredPackages()) {
      if (!installedPath) continue;
      let version: string | undefined;
      try {
        const manifest = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf-8"));
        if (typeof manifest.version === "string") version = manifest.version;
      } catch {
        // No readable package.json: the commit below still identifies a git package.
      }
      let commit: string | undefined;
      if (existsSync(join(installedPath, ".git"))) {
        const git = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: installedPath, timeout: 10_000 });
        commit = git.stdout.trim();
        if (git.code !== 0 || git.killed || !commit) throw new Error(`No commit for ${source}`);
      }
      // Two unreadable snapshots would compare equal and hide a real update.
      if (version === undefined && commit === undefined) throw new Error(`No revision for ${source}`);
      revisions.push([scope, source, version, commit].join(" "));
    }
    return revisions.join("\n");
  } catch {
    return undefined;
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

/**
 * Version of the pi package a restart would launch: the package that owns
 * process.argv[1] now. npm replaces that package in place and pnpm repoints
 * its symlink, so the version changes. Installs that keep versions side by
 * side (pi.dev installer, custom update commands) leave it unchanged.
 */
function readRestartPiVersion(): string | undefined {
  try {
    let dir = dirname(realpathSync(process.argv[1]));
    while (!existsSync(join(dir, "package.json"))) {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
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

type NativeUpdateResult = { ok: true; output: string } | { ok: false; failure: InstallFailure };

function formatInstallFailure(failure: InstallFailure, display: string): string {
  return `Update failed while running \`${display}\` (exit ${failure.code})${failure.output ? `: ${failure.output}` : ""}`;
}

async function runNativeUpdate(
  pi: ExtensionAPI,
  target: UpdateTarget,
): Promise<NativeUpdateResult> {
  const previousSkip = process.env[ENV_SKIP_VERSION_CHECK];
  const previousInternalSkip = process.env[ENV_INTERNAL_SKIP];
  delete process.env[ENV_SKIP_VERSION_CHECK];
  delete process.env[ENV_INTERNAL_SKIP];

  try {
    const cmd = currentPiCommand([...UPDATE_COMMANDS[target].args]);
    const result = await pi.exec(cmd.program, cmd.args, { timeout: 300_000 });
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    // A timed-out process is killed and can report exit code 0; treat it as failure.
    if (result.killed || result.code !== 0) {
      return {
        ok: false,
        failure: {
          code: result.code,
          output: result.killed ? ["Update timed out after 5 minutes.", output].filter(Boolean).join("\n") : output,
        },
      };
    }
    return { ok: true, output };
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
  // An automatic offer that resolved while the agent was running.
  let pendingOffer: { latest: string | undefined; extensions: string[] } | undefined;
  let liveCheckStarted = false;

  // Consume the one-shot suppression from a post-update restart. Deleting it
  // keeps it from propagating into any further restarts from this session.
  const suppressStartupCheck = isEnvSet(ENV_SUPPRESS_STARTUP_CHECK);
  delete process.env[ENV_SUPPRESS_STARTUP_CHECK];

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
    // The user just acted on an update prompt; don't greet them with another.
    env[ENV_SUPPRESS_STARTUP_CHECK] = "1";

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

  // `reload` comes from the /update command context. The startup prompt only
  // has an event context, which cannot reload.
  async function reloadExtensions(ctx: ExtensionContext, reload?: () => Promise<void>) {
    // Command contexts (/update) can hot-reload in place — the best path.
    if (reload) {
      ctx.ui.notify("Extensions updated. Reloading...", "info");
      await reload();
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

  async function doInstall(
    ctx: ExtensionContext,
    target: UpdateTarget,
    offer: UpdateOffer,
    reload?: () => Promise<void>,
  ) {
    // Installing mid-run would restart or reload under the running agent.
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pi is busy. Run /update again when the agent has finished.", "warning");
      return;
    }

    const command = UPDATE_COMMANDS[target];
    // Not cancellable: closing the loader would leave `pi update` running unseen.
    const result = await ctx.ui.custom<{ output: string; unchanged: boolean } | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Running ${command.display}...`, {
        cancellable: false,
      });

      // `pi update` exits 0 even when stale npm metadata kept every package at
      // its old version, so compare what is installed before and after. This
      // runs under the loader, which keeps the user from starting a run.
      const install = async () => {
        const before = target === "extensions" ? await readPackageRevisions(pi, ctx) : undefined;
        const update = await runNativeUpdate(pi, target);
        const unchanged =
          update.ok && before !== undefined && before === (await readPackageRevisions(pi, ctx));
        return { update, unchanged };
      };

      install()
        .then(({ update, unchanged }) => {
          if (update.ok) {
            done({ output: update.output, unchanged });
          } else {
            ctx.ui.notify(formatInstallFailure(update.failure, command.display), "error");
            done(null);
          }
        })
        .catch((error) => {
          ctx.ui.notify(
            `Update failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          done(null);
        });

      return loader;
    });

    if (!result) return;

    if (target === "extensions") {
      // Reloading after an update that installed nothing would only bring the
      // same prompt back.
      if (result.unchanged) {
        ctx.ui.notify(
          [`Extensions were not updated: ${offer.extensions.join(", ")}`, result.output]
            .filter(Boolean)
            .join("\n\n"),
          "warning",
        );
        return;
      }
      await reloadExtensions(ctx, reload);
      return;
    }

    const latest = offer.piLatest ?? "latest";
    const restartTip = ctx.sessionManager.getSessionFile()
      ? "Tip: run `pi -c` to continue this session."
      : "Tip: run `pi --no-session` to continue without a saved session.";

    // Restarting relaunches process.argv[1], so only do it when that now
    // leads to a different version than the one running.
    const updatedInPlace = (readRestartPiVersion() ?? VERSION) !== VERSION;

    if (!canAutoRestart(ctx) || !updatedInPlace) {
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

  async function showUpdatePrompt(
    ctx: ExtensionContext,
    offer: UpdateOffer,
    install: (target: UpdateTarget) => Promise<void> = (target) => doInstall(ctx, target, offer),
  ) {
    const { piLatest, extensions } = offer;
    const extList = extensions.join(", ");

    if (piLatest && extensions.length > 0) {
      const updateAll = "Update all";
      const updatePi = "Update pi only";
      const updateExtensions = "Update extensions only";
      // No "Ignore pi X" here: dismissing a version while also deciding about
      // extensions is ambiguous. Version dismissal lives in the pi-only prompt.
      const choice = await ctx.ui.select(
        `Update pi ${VERSION} → ${piLatest} · extensions: ${extList}`,
        [updateAll, updatePi, updateExtensions, "Skip"],
      );

      if (!choice || choice === "Skip") return;
      if (choice === updateAll) return install("all");
      if (choice === updatePi) return install("self");
      if (choice === updateExtensions) return install("extensions");
      return;
    }

    if (piLatest) {
      const updateAction = "Update now";
      const ignorePiVersion = `Ignore ${piLatest}`;
      const choice = await ctx.ui.select(`Update ${VERSION} → ${piLatest}`, [
        updateAction,
        "Skip",
        ignorePiVersion,
      ]);

      if (!choice || choice === "Skip") return;
      if (choice === ignorePiVersion) {
        dismissVersion(piLatest);
        return;
      }
      if (choice !== updateAction) return;
      await install("self");
      return;
    }

    if (extensions.length > 0) {
      const updateAction = "Update now";
      const choice = await ctx.ui.select(`Extension updates available: ${extList}`, [
        updateAction,
        "Skip",
      ]);
      if (choice === updateAction) await install("extensions");
    }
  }

  function canAutoPromptVersion(latest: string): boolean {
    if (!isNewer(latest, VERSION)) return false;
    if (promptedVersions.has(latest)) return false;
    if (readCache()?.dismissedVersion === latest) return false;
    return true;
  }

  async function maybeShowAutoPrompt(
    ctx: ExtensionContext,
    latest: string | undefined,
    extensions: string[],
  ) {
    if (!ctx.hasUI) return;
    if (promptOpen) return;

    const piLatest = latest && canAutoPromptVersion(latest) ? latest : undefined;
    if (!piLatest && extensions.length === 0) return;

    // Prompting mid-run invites an install under the running agent. Keep the
    // newest offer and show it from agent_settled.
    if (!ctx.isIdle()) {
      pendingOffer = { latest, extensions };
      return;
    }

    promptOpen = true;
    if (piLatest) promptedVersions.add(piLatest);
    try {
      await showUpdatePrompt(ctx, { piLatest, extensions });
    } finally {
      promptOpen = false;
    }
  }

  function runAutoChecks(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (shouldSkipAutoChecks()) return;
    if (liveCheckStarted) return;
    liveCheckStarted = true;

    // Model hints are independent: a slow catalog must not delay update prompts.
    void checkForModelUpdates(ctx);

    // Wait for both checks and show a single consolidated prompt. Startup is
    // never blocked; the prompt simply appears when the checks resolve.
    void Promise.all([
      refreshLatestVersionInCache().catch(() => undefined),
      checkForExtensionUpdates(ctx).catch(() => [] as string[]),
    ])
      .then(([latest, extensions]) => {
        // Fall back to a previously cached pi version if the live fetch failed.
        return maybeShowAutoPrompt(ctx, latest ?? getCachedUpgradeVersion(), extensions);
      })
      .catch(() => {});
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload" || event.reason === "fork") return;
    // One-shot suppression applies only to the startup right after a
    // post-update restart, never to later new/resume session starts.
    if (suppressStartupCheck && event.reason === "startup") return;
    runAutoChecks(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!pendingOffer) return;
    const { latest, extensions } = pendingOffer;
    pendingOffer = undefined;
    // Use this handler's ctx: the one that started the check may be stale.
    // Not awaited, so the prompt does not hold up Pi's settled notification.
    void maybeShowAutoPrompt(ctx, latest, extensions).catch(() => {});
  });

  pi.registerCommand("update", {
    description: "Check for pi updates and install with pi's native updater",
    handler: async (rawArgs, ctx) => {
      // The demo uses the real presentation with fixture data and an inert installer.
      if (rawArgs?.trim() === "--test") {
        if (!ctx.hasUI || ctx.mode !== "tui") {
          ctx.ui.notify("The update demo requires an interactive terminal.", "warning");
          return;
        }
        const modelNotice = formatModelUpdates(ctx, [
          {
            current: { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" },
            latest: { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
          },
          {
            current: { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
            latest: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
          },
        ]);
        ctx.ui.notify(`Demo only. Nothing will be changed.\n\n${modelNotice}`, "info");
        await showUpdatePrompt(ctx, {
          piLatest: "99.0.0",
          extensions: ["example-tools", "example-prompts"],
        }, async (target) => {
          const completed = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
            const loader = new BorderedLoader(tui, theme, `Demo: ${UPDATE_COMMANDS[target].display}...`);
            const timer = setTimeout(() => done(true), 1500);
            loader.onAbort = () => {
              clearTimeout(timer);
              done(false);
            };
            return loader;
          });
          const status = completed ? "Demo complete. Nothing changed." : "Demo cancelled. Nothing changed.";
          ctx.ui.notify(`${status}\n\n${modelNotice}`, "info");
        });
        return;
      }

      if (isOffline()) {
        ctx.ui.notify(
          "PI_OFFLINE is set. Disable it to check for updates.",
          "warning",
        );
        return;
      }

      // This check replaces an automatic offer still waiting for the agent.
      // Dropped before the first await, so agent_settled cannot show it meanwhile.
      pendingOffer = undefined;

      let modelNotice: string | undefined;
      let updateStatus: string | undefined;
      // Pi replaces consecutive info notices. Preserve both results, whichever
      // check finishes first, without making the update prompt wait for models.
      const showUpdateStatus = () => {
        ctx.ui.notify([updateStatus, modelNotice].filter(Boolean).join("\n\n"), "info");
      };
      void checkForModelUpdates(ctx, true, (message) => {
        modelNotice = message;
        showUpdateStatus();
      });

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
          checkForExtensionUpdates(ctx).catch(() => [] as string[]),
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
        updateStatus = `pi ${VERSION} · extensions up to date`;
        showUpdateStatus();
        return;
      }

      if (piLatest) promptedVersions.add(piLatest);
      const offer = { piLatest, extensions };
      await showUpdatePrompt(ctx, offer, (target) => doInstall(ctx, target, offer, () => ctx.reload()));
    },
  });
}
