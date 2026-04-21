import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { VERSION, BorderedLoader, getAgentDir } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_FILE = join(getAgentDir(), "update-cache.json");

const ENV_SKIP_VERSION_CHECK = "PI_SKIP_VERSION_CHECK";
const ENV_OFFLINE = "PI_OFFLINE";

type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";
type InstallCommand = {
  program: string | null;
  args: string[];
  display: string;
};

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

function parseVersion(v: string): [number, number, number] | undefined {
  const parts = v.trim().split(".");
  if (parts.length !== 3) return undefined;
  const nums = parts.map(Number);
  if (nums.some(isNaN)) return undefined;
  return nums as [number, number, number];
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
}

function isEnvSet(name: string): boolean {
  return Boolean(process.env[name]);
}

function shouldSkipAutoChecks(): boolean {
  return isEnvSet(ENV_SKIP_VERSION_CHECK) || isEnvSet(ENV_OFFLINE);
}

function isOffline(): boolean {
  return isEnvSet(ENV_OFFLINE);
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
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Returns a cached upgrade if available and not dismissed. */
function getCachedUpgradeVersion(): string | undefined {
  const cache = readCache();
  if (!cache) return undefined;
  if (!isNewer(cache.latestVersion, CURRENT_PI_VERSION)) return undefined;
  if (cache.dismissedVersion === cache.latestVersion) return undefined;
  return cache.latestVersion;
}

/** Fetch latest from npm and refresh cache. */
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

function isBunBinaryEntrypoint(entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  const normalized = entryPath.toLowerCase();
  return (
    normalized.includes("$bunfs") ||
    normalized.includes("~bun") ||
    normalized.includes("%7ebun") ||
    normalized.startsWith("compiled:")
  );
}

function detectInstallMethod(entryPath: string | undefined = process.argv[1]): InstallMethod {
  if (isBunBinaryEntrypoint(entryPath)) {
    return "bun-binary";
  }

  const resolvedPath = `${entryPath ?? ""}\0${process.execPath ?? ""}`.toLowerCase();

  if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
    return "pnpm";
  }
  if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
    return "yarn";
  }
  if (process.versions.bun) {
    return "bun";
  }
  if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
    return "npm";
  }

  return "unknown";
}

function readPiVersion(entryPath: string | undefined = process.argv[1]): string | undefined {
  if (!entryPath || isBunBinaryEntrypoint(entryPath)) {
    return undefined;
  }

  let dir = dirname(entryPath);
  while (true) {
    const packageJsonPath = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {}

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}

const CURRENT_PI_VERSION = readPiVersion() ?? VERSION;
const INSTALL_METHOD = detectInstallMethod();

function getInstallCommand(version: string): InstallCommand {
  const packageSpec = `${PACKAGE_NAME}@${version}`;

  switch (INSTALL_METHOD) {
    case "bun-binary":
      return {
        program: null,
        args: [],
        display: "Download from: https://github.com/badlogic/pi-mono/releases/latest",
      };
    case "pnpm":
      return {
        program: "pnpm",
        args: ["install", "-g", packageSpec],
        display: `pnpm install -g ${packageSpec}`,
      };
    case "yarn":
      return {
        program: "yarn",
        args: ["global", "add", packageSpec],
        display: `yarn global add ${packageSpec}`,
      };
    case "bun":
      return {
        program: "bun",
        args: ["install", "-g", packageSpec],
        display: `bun install -g ${packageSpec}`,
      };
    case "npm":
    case "unknown":
    default:
      return {
        program: "npm",
        args: ["install", "-g", packageSpec],
        display: `npm install -g ${packageSpec}`,
      };
  }
}

function fmtCmd(cmd: InstallCommand): string {
  return cmd.display;
}

function getUpdateActionLabel(cmd: InstallCommand): string {
  return cmd.program ? `Update now (${fmtCmd(cmd)})` : `Show update instructions (${fmtCmd(cmd)})`;
}

export default function (pi: ExtensionAPI) {
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
    const restartArgs = sessionFile ? ["--session", sessionFile] : ["-c"];

    return ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
      tui.stop();
      const result = spawnSync(piBinary, restartArgs, {
        cwd: ctx.cwd,
        env: process.env,
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
    const program = cmd.program;
    if (!program) {
      ctx.ui.notify(
        `Pi appears to be installed as a standalone binary. ${fmtCmd(cmd)}`,
        "info",
      );
      return;
    }

    const success = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Installing ${latest}...`);
      loader.onAbort = () => done(false);

      pi.exec(program, cmd.args, { timeout: 120_000 })
        .then((result) => {
          if (result.code !== 0) {
            ctx.ui.notify(
              `Update failed (exit ${result.code}): ${result.stderr || result.stdout}`,
              "error",
            );
            done(false);
          } else {
            done(true);
          }
        })
        .catch(() => done(false));

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
    const updateAction = getUpdateActionLabel(cmd);
    const choice = await ctx.ui.select(`Update ${CURRENT_PI_VERSION} → ${latest}`, [
      updateAction,
      "Skip",
      "Skip this version",
    ]);

    if (!choice || choice === "Skip") return;
    if (choice === "Skip this version") {
      dismissVersion(latest);
      return;
    }
    if (choice !== updateAction) return;
    await doInstall(ctx, latest, cmd);
  }

  function canAutoPromptVersion(latest: string): boolean {
    if (!isNewer(latest, CURRENT_PI_VERSION)) return false;
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
    const reason = (event as { reason?: string }).reason;
    if (reason === "reload" || reason === "fork") return;
    runAutoChecks(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    runAutoChecks(ctx);
  });

  pi.registerCommand("update", {
    description: "Check for pi updates and install",
    handler: async (rawArgs, ctx) => {
      // /update --test — simulate the full UI flow without a real install
      if (rawArgs?.trim() === "--test") {
        const fakeLatest = "99.0.0";
        const cmd = getInstallCommand(fakeLatest);
        const updateAction = getUpdateActionLabel(cmd);
        const choice = await ctx.ui.select(`Update ${CURRENT_PI_VERSION} → ${fakeLatest}`, [
          updateAction,
          "Skip",
          "Skip this version",
        ]);
        if (!choice || choice === "Skip" || choice === "Skip this version") return;
        if (choice !== updateAction) return;

        if (!cmd.program) {
          ctx.ui.notify(`Test mode: ${fmtCmd(cmd)}`, "info");
          return;
        }

        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, `Installing ${fakeLatest}...`);
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
        ctx.ui.notify("Could not reach npm registry.", "error");
        return;
      }

      saveLatestToCache(latest);

      if (!isNewer(latest, CURRENT_PI_VERSION)) {
        ctx.ui.notify(`Already on latest version (${CURRENT_PI_VERSION}).`, "info");
        return;
      }

      promptedVersions.add(latest);
      await showUpdatePrompt(ctx, latest);
    },
  });
}
