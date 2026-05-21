import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const LEGACY_PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const NATIVE_VERSION_NOTICE_MIN_VERSION = "0.70.3";

const ENV_SKIP_VERSION_CHECK = "PI_SKIP_VERSION_CHECK";
const ENV_OFFLINE = "PI_OFFLINE";
const ENV_INTERNAL_SKIP = "PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK";

interface LatestRelease {
  version: string;
  packageName?: string;
}

interface VersionCache {
  latestVersion: string;
  latestPackageName?: string;
  dismissedVersion?: string;
  dismissedPackageName?: string;
  checkedAt?: string;
}

type BorderedLoaderConstructor = new (...args: any[]) => any;

interface PiRuntime {
  VERSION: string;
  BorderedLoader: BorderedLoaderConstructor;
  getAgentDir: () => string;
  packageName: string;
}

let VERSION = "0.0.0";
let BorderedLoader: BorderedLoaderConstructor;
let getAgentDir: () => string;
let currentRuntimePackageName = PACKAGE_NAME;

function uniquePackageNames(packageNames: Array<string | undefined>): string[] {
  return packageNames.filter(
    (packageName, index): packageName is string =>
      !!packageName && packageNames.indexOf(packageName) === index,
  );
}

function packageNameFromNodeModulesPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return undefined;

  const parts = normalized.slice(index + marker.length).split("/");
  if (!parts[0]) return undefined;
  if (parts[0].startsWith("@")) {
    if (!parts[1]) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

async function findOwningPiPackageName(pi: ExtensionAPI): Promise<string | undefined> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = await pi.exec(cmd, ["pi"]);
    const binary = result.code === 0 ? result.stdout?.trim().split(/\r?\n/)[0] : undefined;
    if (!binary) return undefined;

    try {
      return packageNameFromNodeModulesPath(realpathSync(binary));
    } catch {
      return packageNameFromNodeModulesPath(binary);
    }
  } catch {
    return undefined;
  }
}

async function loadPiRuntime(preferredPackageName?: string): Promise<PiRuntime> {
  for (const packageName of uniquePackageNames([
    preferredPackageName,
    PACKAGE_NAME,
    LEGACY_PACKAGE_NAME,
  ])) {
    try {
      const runtime = await import(packageName);
      if (
        typeof runtime.VERSION === "string" &&
        typeof runtime.BorderedLoader === "function" &&
        typeof runtime.getAgentDir === "function"
      ) {
        return {
          VERSION: runtime.VERSION,
          BorderedLoader: runtime.BorderedLoader,
          getAgentDir: runtime.getAgentDir,
          packageName,
        };
      }
    } catch {}
  }

  throw new Error(`Could not load ${PACKAGE_NAME} or ${LEGACY_PACKAGE_NAME}`);
}

function readCache(cacheFile: string): VersionCache | undefined {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeCache(cacheFile: string, cache: VersionCache) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache) + "\n");
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

function hasNativeVersionNotice(): boolean {
  return isAtLeast(VERSION, NATIVE_VERSION_NOTICE_MIN_VERSION);
}

function targetPackageName(release: LatestRelease, currentPackageName: string): string {
  return release.packageName ?? currentPackageName;
}

function releaseKey(release: LatestRelease, currentPackageName: string): string {
  return `${targetPackageName(release, currentPackageName)}@${release.version}`;
}

function isUpdateAvailable(release: LatestRelease, currentPackageName: string): boolean {
  return isNewer(release.version, VERSION) || targetPackageName(release, currentPackageName) !== currentPackageName;
}

function isDismissed(
  cache: VersionCache,
  release: LatestRelease,
  currentPackageName: string,
): boolean {
  if (cache.dismissedVersion !== release.version) return false;
  if (!cache.dismissedPackageName) return !release.packageName;
  return cache.dismissedPackageName === targetPackageName(release, currentPackageName);
}

function saveLatestToCache(cacheFile: string, latest: LatestRelease) {
  const prev = readCache(cacheFile);
  writeCache(cacheFile, {
    latestVersion: latest.version,
    latestPackageName: latest.packageName,
    dismissedVersion: prev?.dismissedVersion,
    dismissedPackageName: prev?.dismissedPackageName,
    checkedAt: new Date().toISOString(),
  });
}

async function fetchLatestRelease(): Promise<LatestRelease | undefined> {
  try {
    const res = await fetch(LATEST_VERSION_URL, {
      headers: {
        "User-Agent": piUserAgent(),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string; packageName?: string };
    if (typeof data.version !== "string" || !data.version.trim()) return undefined;
    const packageName =
      typeof data.packageName === "string" && data.packageName.trim()
        ? data.packageName.trim()
        : undefined;
    return { version: data.version.trim(), packageName };
  } catch {
    return undefined;
  }
}

/** Returns a cached upgrade if available and not dismissed. */
function getCachedUpgradeRelease(
  cacheFile: string,
  currentPackageName: string,
): LatestRelease | undefined {
  const cache = readCache(cacheFile);
  if (!cache) return undefined;
  const release = {
    version: cache.latestVersion,
    packageName: cache.latestPackageName,
  };
  if (!isUpdateAvailable(release, currentPackageName)) return undefined;
  if (isDismissed(cache, release, currentPackageName)) return undefined;
  return release;
}

/** Fetch latest from Pi's update endpoint and refresh cache. */
async function refreshLatestReleaseInCache(cacheFile: string): Promise<LatestRelease | undefined> {
  const latest = await fetchLatestRelease();
  if (!latest) return undefined;
  saveLatestToCache(cacheFile, latest);
  return latest;
}

function dismissRelease(
  cacheFile: string,
  release: LatestRelease,
  currentPackageName: string,
) {
  const cache = readCache(cacheFile);
  writeCache(cacheFile, {
    latestVersion: cache?.latestVersion ?? release.version,
    latestPackageName: cache?.latestPackageName ?? release.packageName,
    dismissedVersion: release.version,
    dismissedPackageName: targetPackageName(release, currentPackageName),
    checkedAt: cache?.checkedAt,
  });
}

interface InstallStep {
  program: string;
  args: string[];
  display: string;
}

interface ExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

interface InstallFailure {
  result: ExecResult;
  step: InstallStep;
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
}

interface InstallCommand {
  display: string;
  targetVersion: string;
  targetPackageName: string;
  currentPackageName: string;
  packageChanged: boolean;
}

function installPackageStep(packageSpec: string): InstallStep {
  return {
    program: "npm",
    args: ["install", "-g", packageSpec, "--engine-strict=true"],
    display: `npm install -g ${packageSpec} --engine-strict=true`,
  };
}

function getInstallCommand(
  release: LatestRelease,
  currentPackageName: string,
): InstallCommand {
  const updatePackageName = targetPackageName(release, currentPackageName);
  const targetVersion = release.version;
  const packageSpec = `${updatePackageName}@${targetVersion}`;
  const packageChanged = updatePackageName !== currentPackageName;

  return {
    display: packageChanged
      ? `migrate ${currentPackageName} → ${packageSpec}`
      : installPackageStep(packageSpec).display,
    targetVersion,
    targetPackageName: updatePackageName,
    currentPackageName,
    packageChanged,
  };
}

function fmtCmd(cmd: InstallCommand): string {
  return cmd.display;
}

function extractRequiredNodeVersion(output: string): string | undefined {
  return (
    output.match(/required:\s*\{\s*node:\s*['"]([^'"]+)['"]/i)?.[1] ??
    output.match(/Required:\s*\{[^}]*"node":"([^"]+)"/i)?.[1]
  );
}

function formatInstallFailure(failure: InstallFailure, cmd: InstallCommand): string {
  const output = [failure.result.stderr, failure.result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (/EBADENGINE|Unsupported engine|not compatible with your version of node/i.test(output)) {
    const requiredNode = extractRequiredNodeVersion(output);
    const requirement = requiredNode ? ` Requires Node.js ${requiredNode}.` : "";
    return `Update blocked: pi ${cmd.targetVersion} is incompatible with current Node.js ${process.version}.${requirement} Upgrade Node.js, restart pi, then run /update again.`;
  }

  const rollback = failure.rollbackAttempted
    ? failure.rollbackSucceeded
      ? " Previous pi package was restored."
      : " Rollback failed; reinstall pi manually."
    : "";

  return `Update failed while running \`${failure.step.display}\` (exit ${failure.result.code})${output ? `: ${output}` : ""}${rollback}`;
}

function parsePackedTarballPath(output: string, destination: string): string | undefined {
  try {
    const packuments = JSON.parse(output) as Array<{ filename?: string }>;
    const filename = packuments[0]?.filename;
    return filename ? join(destination, filename) : undefined;
  } catch {
    return undefined;
  }
}

async function runStep(pi: ExtensionAPI, step: InstallStep): Promise<ExecResult> {
  return pi.exec(step.program, step.args, { timeout: 120_000 });
}

async function packPackage(
  pi: ExtensionAPI,
  packageSpec: string,
  destination: string,
): Promise<{ failure?: InstallFailure; tarball?: string }> {
  const step = {
    program: "npm",
    args: ["pack", packageSpec, "--pack-destination", destination, "--json"],
    display: `npm pack ${packageSpec} --pack-destination ${destination}`,
  };
  const result = await runStep(pi, step);
  if (result.code !== 0) return { failure: { result, step } };

  const tarball = parsePackedTarballPath(result.stdout ?? "", destination);
  if (!tarball) {
    return {
      failure: {
        result: { code: 1, stdout: result.stdout, stderr: "Could not find packed tarball." },
        step,
      },
    };
  }

  return { tarball };
}

async function runInstallCommand(
  pi: ExtensionAPI,
  cmd: InstallCommand,
): Promise<InstallFailure | undefined> {
  const packageSpec = `${cmd.targetPackageName}@${cmd.targetVersion}`;

  if (!cmd.packageChanged) {
    const step = installPackageStep(packageSpec);
    const result = await runStep(pi, step);
    return result.code === 0 ? undefined : { result, step };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pi-updater-"));
  try {
    const dryRunStep = {
      program: "npm",
      args: ["install", "-g", packageSpec, "--dry-run", "--engine-strict=true"],
      display: `npm install -g ${packageSpec} --dry-run --engine-strict=true`,
    };
    const dryRun = await runStep(pi, dryRunStep);
    if (dryRun.code !== 0) return { result: dryRun, step: dryRunStep };

    const targetPack = await packPackage(pi, packageSpec, tempDir);
    if (targetPack.failure) return targetPack.failure;

    const currentSpec = `${cmd.currentPackageName}@${VERSION}`;
    const rollbackPack = await packPackage(pi, currentSpec, tempDir);
    if (rollbackPack.failure) return rollbackPack.failure;

    const uninstallStep = {
      program: "npm",
      args: ["uninstall", "-g", cmd.currentPackageName],
      display: `npm uninstall -g ${cmd.currentPackageName}`,
    };
    const uninstall = await runStep(pi, uninstallStep);
    if (uninstall.code !== 0) return { result: uninstall, step: uninstallStep };

    const installStep = installPackageStep(targetPack.tarball!);
    const install = await runStep(pi, installStep);
    if (install.code === 0) return undefined;

    const rollbackStep = {
      program: "npm",
      args: ["install", "-g", rollbackPack.tarball!, "--engine-strict=true", "--force"],
      display: `npm install -g ${rollbackPack.tarball!} --engine-strict=true --force`,
    };
    const rollback = await runStep(pi, rollbackStep);
    return {
      result: install,
      step: installStep,
      rollbackAttempted: true,
      rollbackSucceeded: rollback.code === 0,
    };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

export default async function (pi: ExtensionAPI) {
  const owningPackageName = await findOwningPiPackageName(pi);
  const runtime = await loadPiRuntime(owningPackageName);
  VERSION = runtime.VERSION;
  BorderedLoader = runtime.BorderedLoader;
  getAgentDir = runtime.getAgentDir;
  currentRuntimePackageName = owningPackageName ?? runtime.packageName;

  const cacheFile = join(getAgentDir(), "update-cache.json");
  const suppressNativeCheck = hasNativeVersionNotice() && !userSkippedVersionCheck;
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

      runInstallCommand(pi, cmd)
        .then((failure) => {
          if (failure) {
            ctx.ui.notify(formatInstallFailure(failure, cmd), "error");
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

  async function showUpdatePrompt(ctx: ExtensionContext, latest: LatestRelease) {
    const cmd = getInstallCommand(latest, currentRuntimePackageName);
    const currentLabel = `${currentRuntimePackageName}@${VERSION}`;
    const targetLabel = `${cmd.targetPackageName}@${cmd.targetVersion}`;
    const choice = await ctx.ui.select(`Update ${currentLabel} → ${targetLabel}`, [
      `Update now (${fmtCmd(cmd)})`,
      "Skip",
      "Skip this version",
    ]);

    if (!choice || choice === "Skip") return;
    if (choice === "Skip this version") {
      dismissRelease(cacheFile, latest, currentRuntimePackageName);
      return;
    }
    await doInstall(ctx, targetLabel, cmd);
  }

  function canAutoPromptVersion(latest: LatestRelease): boolean {
    if (!isUpdateAvailable(latest, currentRuntimePackageName)) return false;
    if (promptedVersions.has(releaseKey(latest, currentRuntimePackageName))) return false;
    const cache = readCache(cacheFile);
    if (cache && isDismissed(cache, latest, currentRuntimePackageName)) return false;
    return true;
  }

  async function maybeShowAutoPrompt(ctx: ExtensionContext, latest: LatestRelease) {
    if (!ctx.hasUI) return;
    if (promptOpen) return;
    if (!canAutoPromptVersion(latest)) return;

    promptOpen = true;
    promptedVersions.add(releaseKey(latest, currentRuntimePackageName));
    try {
      await showUpdatePrompt(ctx, latest);
    } finally {
      promptOpen = false;
    }
  }

  function runAutoChecks(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (shouldSkipAutoChecks()) return;

    const cached = getCachedUpgradeRelease(cacheFile, currentRuntimePackageName);
    if (cached) void maybeShowAutoPrompt(ctx, cached);

    if (liveCheckStarted) return;
    liveCheckStarted = true;

    void refreshLatestReleaseInCache(cacheFile)
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
    description: "Check for pi updates and install with npm",
    handler: async (rawArgs, ctx) => {
      // /update --test — simulate the full UI flow without a real install
      if (rawArgs?.trim() === "--test") {
        const fakeLatest = "99.0.0";
        const cmd = getInstallCommand({ version: fakeLatest }, currentRuntimePackageName);
        const choice = await ctx.ui.select(`Update ${currentRuntimePackageName}@${VERSION} → ${cmd.targetPackageName}@${fakeLatest}`, [
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

      const latest = await ctx.ui.custom<LatestRelease | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            "Checking for updates...",
          );
          loader.onAbort = () => done(null);
          fetchLatestRelease()
            .then((v) => done(v ?? null))
            .catch(() => done(null));
          return loader;
        },
      );

      if (!latest) {
        ctx.ui.notify("Could not reach Pi update service.", "error");
        return;
      }

      saveLatestToCache(cacheFile, latest);

      if (!isUpdateAvailable(latest, currentRuntimePackageName)) {
        ctx.ui.notify(`Already on latest version (${currentRuntimePackageName}@${VERSION}).`, "info");
        return;
      }

      promptedVersions.add(releaseKey(latest, currentRuntimePackageName));
      await showUpdatePrompt(ctx, latest);
    },
  });
}
