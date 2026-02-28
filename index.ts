import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { VERSION, BorderedLoader } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_FILE = join(homedir(), ".pi", "agent", "update-cache.json");

const FAKE_LATEST: string | undefined = undefined;

interface VersionCache {
  latestVersion: string;
  dismissedVersion?: string;
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

async function fetchLatestVersion(): Promise<string | undefined> {
  if (FAKE_LATEST) return FAKE_LATEST;
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

/**
 * Returns the cached latest version if an upgrade is available and not dismissed.
 * Always kicks off a background fetch to refresh the cache for the next run.
 */
function getUpgradeVersion(): string | undefined {
  const cache = readCache();

  void fetchLatestVersion().then((latest) => {
    if (!latest) return;
    // Re-read cache to avoid overwriting a dismissal that happened during the fetch
    writeCache({
      latestVersion: latest,
      dismissedVersion: readCache()?.dismissedVersion,
    });
  });

  if (!cache) return undefined;
  if (!isNewer(cache.latestVersion, VERSION)) return undefined;
  if (cache.dismissedVersion === cache.latestVersion) return undefined;
  return cache.latestVersion;
}

function dismissVersion(version: string) {
  const cache = readCache();
  if (!cache) return;
  cache.dismissedVersion = version;
  writeCache(cache);
}

function getInstallCommand(): { program: string; args: string[] } {
  if (process.versions.bun) {
    const url = import.meta.url;
    if (
      url.includes("$bunfs") ||
      url.includes("~BUN") ||
      url.includes("%7EBUN")
    ) {
      return {
        program: "echo",
        args: [
          "Download from https://github.com/badlogic/pi-mono/releases/latest",
        ],
      };
    }
    return { program: "bun", args: ["install", "-g", PACKAGE_NAME] };
  }

  let piPath = "";
  try {
    piPath = import.meta.resolve(PACKAGE_NAME);
  } catch {}

  const search = `${piPath}\0${process.execPath || ""}`.toLowerCase();
  const s = sep;

  if (search.includes(`${s}pnpm${s}`) || search.includes(`${s}.pnpm${s}`))
    return { program: "pnpm", args: ["install", "-g", PACKAGE_NAME] };
  if (search.includes(`${s}yarn${s}`) || search.includes(`${s}.yarn${s}`))
    return { program: "yarn", args: ["global", "add", PACKAGE_NAME] };

  return { program: "npm", args: ["install", "-g", PACKAGE_NAME] };
}

function fmtCmd(cmd: { program: string; args: string[] }): string {
  return `${cmd.program} ${cmd.args.join(" ")}`;
}

export default function (pi: ExtensionAPI) {
  async function doInstall(
    ctx: ExtensionContext,
    latest: string,
    cmd: { program: string; args: string[] },
  ) {
    const success = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Installing ${latest}...`);
      loader.onAbort = () => done(false);

      const run = async () => {
        if (cmd.program === "echo") {
          ctx.ui.notify(cmd.args[0], "info");
          return false;
        }
        const result = await pi.exec(cmd.program, cmd.args, {
          timeout: 120_000,
        });
        if (result.code !== 0) {
          ctx.ui.notify(
            `Update failed (exit ${result.code}): ${result.stderr || result.stdout}`,
            "error",
          );
          return false;
        }
        return true;
      };

      run()
        .then(done)
        .catch(() => done(false));
      return loader;
    });

    if (!success) return;

    const ok = await ctx.ui.confirm(
      `Updated to ${latest}!`,
      "Shut down pi? (Use pi -c to continue this session)",
    );
    if (ok) ctx.shutdown();
  }

  async function showUpdatePrompt(ctx: ExtensionContext, latest: string) {
    const cmd = getInstallCommand();
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

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const latest = getUpgradeVersion();
    if (latest) void showUpdatePrompt(ctx, latest);
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const latest = getUpgradeVersion();
    if (latest) void showUpdatePrompt(ctx, latest);
  });

  pi.registerCommand("update", {
    description: "Check for pi updates and install",
    handler: async (_args, ctx) => {
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

      writeCache({
        latestVersion: latest,
        dismissedVersion: readCache()?.dismissedVersion,
      });

      if (!isNewer(latest, VERSION)) {
        ctx.ui.notify(`Already on latest version (${VERSION}).`, "info");
        return;
      }

      await showUpdatePrompt(ctx, latest);
    },
  });
}
