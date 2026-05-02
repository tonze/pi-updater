import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { VERSION, BorderedLoader, getAgentDir } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const NATIVE_SELF_UPDATE_MIN_VERSION = "0.70.3";
const CACHE_FILE = join(getAgentDir(), "update-cache.json");

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

function compareVersions(leftVersion: string, rightVersion: string): number | undefined {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) return undefined;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function isNewer(latest: string, current: string): boolean {
  const comparison = compareVersions(latest, current);
  return comparison !== undefined && comparison > 0;
}

function isAtLeast(version: string, minimum: string): boolean {
  const comparison = compareVersions(version, minimum);
  return comparison !== undefined && comparison >= 0;
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

function hasNativeSelfUpdate(): boolean {
  return isAtLeast(VERSION, NATIVE_SELF_UPDATE_MIN_VERSION);
}

function saveLatestToCache(latest: string) {
  const prev = readCache();
  writeCache({
    latestVersion: latest,
    dismissedVersion: prev?.dismissedVersion,
    checkedAt: new Date().toISOString(),
  });
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
    const version = ((await res.json()) as { version?: string }).version;
    return typeof version === "string" && version.trim()
      ? version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Returns a cached upgrade if available and not dismissed. */
function getCachedUpgradeVersion(): string | undefined {
  const cache = readCache();
  if (!cache) return undefined;
  if (!isNewer(cache.latestVersion, VERSION)) return undefined;
  if (cache.dismissedVersion === cache.latestVersion) return undefined;
  return cache.latestVersion;
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

interface InstallCommand {
  program: string;
  args: string[];
  display: string;
}

function getInstallCommand(version: string): InstallCommand {
  if (hasNativeSelfUpdate()) {
    return {
      program: "pi",
      args: ["update", "--self"],
      display: "pi update --self",
    };
  }

  return {
    program: "npm",
    args: ["install", "-g", `${PACKAGE_NAME}@${version}`],
    display: `npm install -g ${PACKAGE_NAME}@${version}`,
  };
}

function fmtCmd(cmd: InstallCommand): string {
  return cmd.display;
}

export default function (pi: ExtensionAPI) {
  const suppressNativeCheck = hasNativeSelfUpdate() && !userSkippedVersionCheck;
  if (suppressNativeCheck) {
    process.env[ENV_SKIP_VERSION_CHECK] = "1";
    process.env[ENV_INTERNAL_SKIP] = "1";
  }

  let promptOpen = false;
  const promptedVersions = new Set<string>();
  let liveCheckStarted = false;

  async function findPiBinary(): Promise<string> {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = await pi.exec(cmd, ["pi"]);
    if (result.code === 0 && result.stdout?.trim()) {
      return result.stdout.trim().split(/\r?\n/)[0];
    }
    return "pi";
  }

  function canAutoRestart(ctx: ExtensionContext): boolean {
    return ctx.hasUI && !!process.stdin.isTTY && !!process.stdout.isTTY;
  }

  async function restartPi(ctx: ExtensionContext): Promise<boolean> {
    const piBinary = await findPiBinary();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const restartArgs = sessionFile ? ["--session", sessionFile] : ["--no-session"];
    const env = { ...process.env };
    if (suppressNativeCheck) {
      delete env[ENV_SKIP_VERSION_CHECK];
      delete env[ENV_INTERNAL_SKIP];
    }

    return ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
      tui.stop();
      const result = spawnSync(piBinary, restartArgs, {
        cwd: ctx.cwd,
        env,
        stdio: "inherit",
        shell: process.platform === "win32",
        windowsHide: false,
      });
      tui.start();
      tui.requestRender(true);
      done(!result.error && (result.status === null || result.status === 0));
      return { render: () => [], invalidate: () => {} };
    });
  }

  async function doInstall(
    ctx: ExtensionContext,
    latest: string,
    cmd: InstallCommand,
  ) {
    const success = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Running ${cmd.display}...`);
      loader.onAbort = () => done(false);

      const runUpdateCommand = async () => {
        if (suppressNativeCheck && cmd.program === "pi") {
          delete process.env[ENV_SKIP_VERSION_CHECK];
          delete process.env[ENV_INTERNAL_SKIP];
          try {
            return await pi.exec(cmd.program, cmd.args, { timeout: 120_000 });
          } finally {
            process.env[ENV_SKIP_VERSION_CHECK] = "1";
            process.env[ENV_INTERNAL_SKIP] = "1";
          }
        }
        return pi.exec(cmd.program, cmd.args, { timeout: 120_000 });
      };

      runUpdateCommand()
        .then((result) => {
          if (result.code !== 0) {
            const output = [result.stderr, result.stdout]
              .filter(Boolean)
              .join("\n")
              .trim();
            ctx.ui.notify(
              `Update failed (exit ${result.code})${output ? `: ${output}` : ""}`,
              "error",
            );
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

    const restart = await ctx.ui.confirm(
      `Updated to ${latest}!`,
      "Restart now?",
    );

    if (!restart) return;

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

  async function showUpdatePrompt(ctx: ExtensionContext, latest: string) {
    const cmd = getInstallCommand(latest);
    const choice = await ctx.ui.select(`Update ${VERSION} → ${latest}`, [
      `Update now (${fmtCmd(cmd)})`,
      "Skip",
      "Skip this version",
    ]);

    if (!choice || choice === "Skip") return;
    if (choice === "Skip this version") {
      dismissVersion(latest);
      return;
    }
    await doInstall(ctx, latest, cmd);
  }

  function canAutoPromptVersion(latest: string): boolean {
    if (!isNewer(latest, VERSION)) return false;
    if (promptedVersions.has(latest)) return false;
    if (readCache()?.dismissedVersion === latest) return false;
    return true;
  }

  async function maybeShowAutoPrompt(ctx: ExtensionContext, latest: string) {
    if (!ctx.hasUI) return;
    if (promptOpen) return;
    if (!canAutoPromptVersion(latest)) return;

    promptOpen = true;
    promptedVersions.add(latest);
    try {
      await showUpdatePrompt(ctx, latest);
    } finally {
      promptOpen = false;
    }
  }

  function runAutoChecks(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (shouldSkipAutoChecks()) return;

    const cached = getCachedUpgradeVersion();
    if (cached) void maybeShowAutoPrompt(ctx, cached);

    if (liveCheckStarted) return;
    liveCheckStarted = true;

    void refreshLatestVersionInCache()
      .then((latest) => {
        if (!latest) return;
        void maybeShowAutoPrompt(ctx, latest);
      })
      .catch(() => {});
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload" || event.reason === "fork") return;
    runAutoChecks(ctx);
  });

  pi.registerCommand("update", {
    description: "Check for pi updates and install via native updater when available",
    handler: async (rawArgs, ctx) => {
      // /update --test — simulate the full UI flow without a real install
      if (rawArgs?.trim() === "--test") {
        const fakeLatest = "99.0.0";
        const cmd = getInstallCommand(fakeLatest);
        const choice = await ctx.ui.select(`Update ${VERSION} → ${fakeLatest}`, [
          `Update now (${fmtCmd(cmd)})`,
          "Skip",
          "Skip this version",
        ]);
        if (!choice || choice === "Skip" || choice === "Skip this version") return;

        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, `Running ${cmd.display}...`);
          loader.onAbort = () => done();
          setTimeout(() => done(), 1500);
          return loader;
        });

        if (!canAutoRestart(ctx)) {
          ctx.ui.notify(`Updated to ${fakeLatest}! Please restart pi.`, "info");
          return;
        }

        const restart = await ctx.ui.confirm(`Updated to ${fakeLatest}!`, "Restart now?");
        if (!restart) return;

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

      const latest = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            "Checking for updates...",
          );
          loader.onAbort = () => done(null);
          fetchLatestVersion()
            .then((v) => done(v ?? null))
            .catch(() => done(null));
          return loader;
        },
      );

      if (!latest) {
        ctx.ui.notify("Could not reach Pi update service.", "error");
        return;
      }

      saveLatestToCache(latest);

      if (!isNewer(latest, VERSION)) {
        ctx.ui.notify(`Already on latest version (${VERSION}).`, "info");
        return;
      }

      promptedVersions.add(latest);
      await showUpdatePrompt(ctx, latest);
    },
  });
}
