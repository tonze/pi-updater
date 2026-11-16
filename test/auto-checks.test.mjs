import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
// Pi's real argument parser, so restart tests exercise its actual grammar.
import { parseArgs } from "@earendil-works/pi-coding-agent";

// Exercise the entire extension without real network, cache, or installer I/O.
const source = ts.transpileModule(
  readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup({ cachedVersion, cacheContent, rejectPrompt = false, env = {}, hasUI = true,
  choice = "Skip", abortInstall = false, mode = "tui", installResult,
  projectTrusted = true, idle = true, installedVersion, restartStatus,
  changedPackage = "npm", unreadableRevision, entryMissing = false, cwdError,
  argv = [], sessionFile = "/test/session.json", sessionHasMessages = false,
  sessionPersisted = sessionHasMessages, removeError } = {}) {
  const version = deferred();
  const extensions = deferred();
  const notices = [];
  const prompts = [];
  const effects = [];
  const executions = [];
  const restarts = [];
  const removals = [];
  const loaders = [];
  const loaderInstances = [];
  const settingsCreates = [];
  const timers = new Set();
  const handlers = new Map();
  const commands = new Map();
  let cache = cacheContent ?? (cachedVersion && JSON.stringify({ latestVersion: cachedVersion }));
  let active = true;
  let installed = false;
  const tui = { stop() { effects.push("tui stop"); }, start() {}, requestRender() {} };
  const ui = {
    async select(title, options) {
      prompts.push({ title, options: Array.from(options) });
      if (rejectPrompt) throw new Error("Prompt failed");
      return choice;
    },
    theme: { fg: (_color, text) => text, bold: (text) => text },
    notify: (message, type) => notices.push({ message, type }),
    custom: (factory) => new Promise((done) => {
      const loader = factory(tui, ui.theme, {}, done);
      if (abortInstall) loader.onAbort();
    }),
  };
  function assertActive() {
    if (!active) throw new Error("This extension ctx is stale after session replacement or reload.");
  }
  // pi guards even hasUI with assertActive(), not just UI operations.
  const ctx = {
    get hasUI() { assertActive(); return hasUI; },
    get ui() { assertActive(); return ui; },
    cwd: "/test/project",
    mode,
    isIdle: () => { assertActive(); return idle; },
    isProjectTrusted: () => projectTrusted,
    reload: async () => { effects.push("reload"); },
    shutdown: () => { effects.push("shutdown"); },
    sessionManager: {
      getSessionFile: () => sessionFile,
      buildSessionProjection: () => ({ messages: sessionHasMessages ? [{ role: "user" }] : [] }),
    },
  };
  const modules = {
    "@earendil-works/pi-coding-agent": {
      VERSION: "0.87.0",
      getAgentDir: () => "/test/agent",
      parseArgs,
      BorderedLoader: class {
        constructor(_tui, _theme, message, options) {
          loaders.push(message);
          loaderInstances.push({ loader: this, options: options && { ...options } });
        }
      },
      SettingsManager: {
        create: (cwd, agentDir, options) => {
          settingsCreates.push({ cwd, agentDir, options: { ...options } });
          return {};
        },
      },
      DefaultPackageManager: class {
        checkForAvailableUpdates() { effects.push("extension check"); return extensions.promise; }
        listConfiguredPackages() {
          return [
            { source: "npm:example-extension", scope: "user", installedPath: "/test/agent/npm/example-extension" },
            { source: "git:example.com/other-extension", scope: "user", installedPath: "/test/agent/git/other-extension" },
            { source: "npm:not-installed", scope: "user" },
          ];
        }
      },
    },
    "node:fs": {
      readFileSync: (file) => {
        if (file === "/test/pi/package.json") {
          effects.push("package read");
          if (!installedVersion) throw new Error("ENOENT");
          return JSON.stringify({ version: installedVersion });
        }
        if (file === "/test/agent/npm/example-extension/package.json") {
          if (unreadableRevision === "manifest") return "\uFEFF{}";
          return JSON.stringify({ version: installed && changedPackage === "npm" ? "1.1.0" : "1.0.0" });
        }
        // The git package keeps its package.json version across commits.
        if (file === "/test/agent/git/other-extension/package.json") return JSON.stringify({ version: "2.0.0" });
        effects.push("cache read");
        if (!cache) throw new Error("ENOENT");
        return cache;
      },
      existsSync: (file) => (sessionPersisted && file === sessionFile)
        || ["/test/agent/git/other-extension/.git", "/test/pi/package.json"].includes(file),
      // The entrypoint is a symlink into the package, as with npm and pnpm bin links.
      realpathSync: (file) => {
        assert.equal(file, "/test/pi.js");
        if (entryMissing) throw new Error("ENOENT");
        return "/test/pi/dist/bundle/cli.js";
      },
      mkdirSync: () => { effects.push("mkdir"); },
      writeFileSync: (_path, value) => { effects.push("cache write"); cache = value; },
      rmSync: (file, options) => {
        removals.push({ file, options: { ...options } });
        if (removeError) throw removeError;
      },
    },
    "node:path": path,
    "node:util": util,
    "node:child_process": {
      spawnSync: (program, args, options) => {
        effects.push("restart");
        restarts.push({ program, args: Array.from(args), cwd: options.cwd });
        if (restartStatus === undefined) throw new Error("Unexpected restart");
        return { status: restartStatus };
      },
    },
  };
  const exports = {};
  const sandbox = {
    exports,
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
      return modules[name];
    },
    process: { env: { ...env }, versions: process.versions, version: process.version,
      platform: process.platform, arch: process.arch, stdin: { isTTY: true }, stdout: { isTTY: true },
      execPath: "/test/node", argv: ["/test/node", "/test/pi.js", ...argv], cwd: () => { if (cwdError) throw cwdError; return "/test/launch"; } },
    AbortSignal,
    fetch: () => { effects.push("fetch"); return version.promise; },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 1500);
      timers.add(callback);
      queueMicrotask(() => { if (timers.delete(callback)) callback(); });
      return callback;
    },
    clearTimeout: (timer) => timers.delete(timer),
  };
  runInNewContext(source, sandbox, { filename: "index.js" });
  exports.default({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    exec: async (program, args, options) => {
      if (program === "git") {
        assert.deepEqual([Array.from(args), options.cwd], [["rev-parse", "HEAD"], "/test/agent/git/other-extension"]);
        if (unreadableRevision === "git") return { code: 128, stdout: "", stderr: "fatal", killed: false };
        return { code: 0, stdout: installed && changedPackage === "git" ? "bbbbbbb\n" : "aaaaaaa\n", stderr: "" };
      }
      effects.push("install");
      executions.push({ program, args: Array.from(args), options: { ...options } });
      if (!installResult) throw new Error("Unexpected install");
      assert.equal(sandbox.process.env.PI_SKIP_VERSION_CHECK, undefined);
      assert.equal(sandbox.process.env.PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK, undefined);
      if (installResult.code === 0 && !installResult.killed) installed = true;
      return installResult;
    },
  });

  return {
    prompts, notices, effects, executions, restarts, removals, loaders, loaderInstances, timers, settingsCreates,
    env: sandbox.process.env,
    start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx),
    // Pi passes the current ctx to agent_settled; the run is over by then.
    settle: () => { idle = true; return handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, ctx); },
    setIdle: (value) => { idle = value; },
    command: (args = "") => commands.get("update").handler(args, ctx),
    invalidate: () => { active = false; },
    resolveVersion: (latest) => version.resolve({ ok: true, json: async () => ({ version: latest }) }),
    rejectVersion: () => version.reject(new Error("Network unavailable")),
    resolveExtensions: (names) => extensions.resolve(names.map((displayName) => ({ displayName }))),
  };
}

for (const latest of ["99.0.0", "0.87.0"]) {
  test(`stale context does not leak a rejection (latest ${latest})`, async () => {
    const check = setup();
    await check.start();
    check.invalidate();
    check.resolveVersion(latest);
    check.resolveExtensions([]);
    // Let detached promises settle. node:test fails on unhandled rejections.
    await setImmediate();
    assert.equal(check.prompts.length, 0);
  });
}

test("an asynchronous prompt failure does not leak a rejection", async () => {
  const check = setup({ rejectPrompt: true });
  await check.start();
  check.resolveVersion("99.0.0");
  check.resolveExtensions([]);
  await setImmediate();
  assert.equal(check.prompts.length, 1);
});

for (const projectTrusted of [false, true]) {
  test(`extension checks follow pi's project trust decision: trusted ${projectTrusted}`, async () => {
    const check = setup({ projectTrusted });
    await check.start();
    const command = check.command();
    check.resolveVersion("0.87.0");
    check.resolveExtensions([]);
    await command;
    await setImmediate();
    const expected = { cwd: "/test/project", agentDir: "/test/agent", options: { projectTrusted } };
    assert.deepEqual(check.settingsCreates, [expected, expected]);
  });
}

test("startup stays nonblocking and waits for both checks before prompting", async () => {
  const check = setup();
  await check.start();
  check.resolveVersion("99.0.0");
  await setImmediate();
  assert.equal(check.prompts.length, 0);

  check.resolveExtensions(["example-extension"]);
  await setImmediate();
  assert.deepEqual(check.prompts, [{
    title: "Update pi 0.87.0 → 99.0.0 · extensions: example-extension",
    options: ["Update all", "Update pi only", "Update extensions only", "Skip"],
  }]);
});

test("a failed version fetch still falls back to the cache", async () => {
  const check = setup({ cachedVersion: "99.0.0" });
  await check.start();
  check.rejectVersion();
  check.resolveExtensions([]);
  await setImmediate();
  assert.deepEqual(check.prompts, [{
    title: "Update 0.87.0 → 99.0.0",
    options: ["Update now", "Skip", "Ignore 99.0.0"],
  }]);
});

test("a valid cache with dismissal and check time still falls back", async () => {
  const check = setup({
    cacheContent: JSON.stringify({ latestVersion: "99.0.0", dismissedVersion: "98.0.0", checkedAt: "2026-11-15T00:00:00.000Z" }),
  });
  await check.start();
  check.rejectVersion();
  check.resolveExtensions([]);
  await setImmediate();
  assert.equal(check.prompts.length, 1);
  assert.equal(check.prompts[0].title, "Update 0.87.0 → 99.0.0");
});

for (const cacheContent of [
  "not json",
  "null",
  "42",
  JSON.stringify("99.0.0"),
  JSON.stringify(["99.0.0"]),
  JSON.stringify({ latestVersion: 99 }),
  JSON.stringify({ latestVersion: "99.0.0", dismissedVersion: 5 }),
  JSON.stringify({ latestVersion: "99.0.0", checkedAt: {} }),
]) {
  test(`a damaged version cache is ignored: ${cacheContent}`, async () => {
    const check = setup({ cacheContent });
    await check.start();
    check.rejectVersion();
    check.resolveExtensions(["example-extension"]);
    await setImmediate();
    // No cached Pi offer, but the extension prompt still appears.
    assert.deepEqual(check.prompts, [{
      title: "Extension updates available: example-extension",
      options: ["Update now", "Skip"],
    }]);
  });
}

test("loading removes the cache file of the removed model hints", () => {
  const check = setup();
  assert.deepEqual(check.removals, [{ file: "/test/agent/model-update-cache.json", options: { force: true } }]);
});

test("a failed removal of the old model cache does not break loading", async () => {
  const check = setup({ removeError: new Error("EACCES") });
  assert.equal(check.removals.length, 1);
  await check.start();
  check.resolveVersion("99.0.0");
  check.resolveExtensions([]);
  await setImmediate();
  assert.equal(check.prompts.length, 1);
});

for (const [name, options, reason] of [
  ["offline", { env: { PI_OFFLINE: "1" } }, "startup"],
  ["user skip", { env: { PI_SKIP_VERSION_CHECK: "1" } }, "startup"],
  ["post-update restart", { env: { PI_UPDATER_SUPPRESS_STARTUP_CHECK: "1" } }, "startup"],
  ["headless", { hasUI: false }, "startup"],
  ["reload", {}, "reload"],
  ["fork", {}, "fork"],
]) {
  test(`${name} suppresses automatic checks`, async () => {
    const check = setup(options);
    await check.start(reason);
    await setImmediate();
    assert.deepEqual(check.effects, []);
  });
}

test("manual /update reports up to date as a plain notice, even with automatic checks disabled", async () => {
  const check = setup({ env: { PI_SKIP_VERSION_CHECK: "1" } });
  const command = check.command();
  check.resolveVersion("0.87.0");
  check.resolveExtensions([]);
  await command;
  await setImmediate();
  assert.deepEqual(check.notices, [{ message: "pi 0.87.0 · extensions up to date", type: "info" }]);
});

for (const [choice, latest, extensions, flags] of [
  ["Update all", "99.0.0", ["example-extension"], ["--all"]],
  ["Update pi only", "99.0.0", ["example-extension"], ["--self"]],
  ["Update extensions only", "99.0.0", ["example-extension"], ["--extensions"]],
  ["Update now", "99.0.0", [], ["--self"]],
  ["Update now", "0.87.0", ["example-extension"], ["--extensions"]],
]) {
  test(`ordinary updates still invoke the native installer: ${choice} ${flags}`, async () => {
    const check = setup({ choice, installResult: { code: 1, stdout: "", stderr: "fixture failure" } });
    const command = check.command();
    check.resolveVersion(latest);
    check.resolveExtensions(extensions);
    await command;
    assert.deepEqual(check.executions, [{
      program: "/test/node", args: ["/test/pi.js", "update", ...flags], options: { timeout: 300_000 },
    }]);
    assert.equal(check.env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(check.env.PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK, "1");
    assert.equal(check.notices.at(-1).type, "error");
    assert.match(check.notices.at(-1).message, /fixture failure/);
    assert.ok(!check.effects.some((effect) => ["reload", "restart", "shutdown"].includes(effect)));
  });
}

const success = { code: 0, stdout: "", stderr: "" };

for (const [choice, extensions] of [["Update now", []], ["Update all", ["example-extension"]]]) {
  test(`pi updates restart only when the installation on disk changed: ${choice}`, async () => {
    for (const options of [{ installedVersion: "0.87.0" }, {}, { installedVersion: "99.0.0", entryMissing: true }]) {
      const check = setup({ choice, installResult: success, ...options });
      const command = check.command();
      check.resolveVersion("99.0.0");
      check.resolveExtensions(extensions);
      await command;
      assert.equal(check.executions.length, 1);
      assert.equal(check.effects.includes("package read"), !options.entryMissing);
      assert.ok(!check.effects.some((effect) => ["reload", "restart", "shutdown"].includes(effect)));
      assert.deepEqual(check.notices.at(-1), {
        message: "Updated to 99.0.0! Please restart pi.\nTip: run `pi -c` to continue this session.",
        type: "info",
      });
    }

    const check = setup({ choice, installResult: success, installedVersion: "99.0.0", restartStatus: 0 });
    const command = check.command();
    check.resolveVersion("99.0.0");
    check.resolveExtensions(extensions);
    await command;
    assert.deepEqual(check.effects.slice(-2), ["restart", "shutdown"]);
    assert.ok(!check.effects.includes("reload"));
  });
}

for (const via of ["/update", "startup"]) {
  test(`extension updates that changed nothing warn with the output and skip reload: ${via}`, async () => {
    const check = setup({
      choice: "Update now",
      installResult: { code: 0, stdout: "  Warning: example-extension is still outdated\n", stderr: "" },
      changedPackage: "none",
    });
    const command = via === "startup" ? check.start() : check.command();
    check.resolveVersion("0.87.0");
    check.resolveExtensions(["example-extension"]);
    await command;
    await setImmediate();
    assert.deepEqual(check.executions.map(({ args }) => args), [["/test/pi.js", "update", "--extensions"]]);
    assert.deepEqual(check.notices.at(-1), {
      message: "Extensions were not updated: example-extension\n\nWarning: example-extension is still outdated",
      type: "warning",
    });
    assert.ok(!check.effects.some((effect) => ["reload", "restart", "shutdown"].includes(effect)));
  });
}

for (const changedPackage of ["npm", "git"]) {
  test(`extension updates that changed a package reload from /update and restart from startup: ${changedPackage}`, async () => {
    // The offered package stays outdated; an installed revision still changed.
    const manual = setup({ choice: "Update now", installResult: success, changedPackage });
    const command = manual.command();
    manual.resolveVersion("0.87.0");
    manual.resolveExtensions(["example-extension"]);
    await command;
    assert.equal(manual.effects.at(-1), "reload");
    assert.ok(!manual.effects.includes("restart"));
    // Installed revisions are compared locally, without a second update check.
    assert.equal(manual.effects.filter((effect) => effect === "extension check").length, 1);

    const startup = setup({ choice: "Update now", installResult: success, restartStatus: 0, changedPackage });
    await startup.start();
    startup.resolveVersion("0.87.0");
    startup.resolveExtensions(["example-extension"]);
    await setImmediate();
    await setImmediate();
    assert.deepEqual(startup.effects.slice(-2), ["restart", "shutdown"]);
    assert.ok(!startup.effects.includes("reload"));
  });
}

for (const unreadableRevision of ["manifest", "git"]) {
  test(`an unreadable installed revision counts as changed: ${unreadableRevision}`, async () => {
    const check = setup({
      choice: "Update now", installResult: success, changedPackage: "none", unreadableRevision,
    });
    const command = check.command();
    check.resolveVersion("0.87.0");
    check.resolveExtensions(["example-extension"]);
    await command;
    assert.equal(check.effects.at(-1), "reload");
    assert.ok(!check.notices.some(({ type }) => type === "warning"));
  });
}

async function restartAfterPiUpdate({ expectedRestart = true, ...options }) {
  const check = setup({
    choice: "Update now", installResult: success, installedVersion: "99.0.0", restartStatus: 0, ...options,
  });
  const command = check.command();
  check.resolveVersion("99.0.0");
  check.resolveExtensions([]);
  await command;
  assert.equal(check.restarts.length, expectedRestart ? 1 : 0);
  if (expectedRestart) {
    assert.equal(check.restarts[0].program, "/test/node");
    assert.equal(check.restarts[0].args[0], "/test/pi.js");
  } else {
    assert.ok(!check.effects.includes("shutdown"));
    assert.equal(check.notices.at(-1).type, "info");
    assert.match(check.notices.at(-1).message, /^Updated to 99\.0\.0! Please restart pi\./);
  }
  return check;
}

test("the restart keeps startup flags and drops prompt text, files, session selectors and model flags", async () => {
  const check = await restartAfterPiUpdate({
    sessionHasMessages: true,
    argv: [
      "-c", "--model", "anthropic/claude", "--provider", "anthropic", "--thinking", "high",
      "--no-mcp", "-e", "./ext.ts", "--plan-mode", "strict",
      "--session-id", "abc", "--fork", "old.jsonl", "-r", "--resume", "--continue",
      "--no-session", "--session", "other.jsonl",
      "@notes.md", "fix the bug", "--", "more text", "@more.md",
    ],
  });
  assert.deepEqual(check.restarts[0].args.slice(1), [
    "--session", "/test/session.json", "--no-mcp", "-e", "./ext.ts", "--plan-mode", "strict", "--",
  ]);
});

test("restart resolves original relative paths from the launch folder, not the resumed session folder", async () => {
  const check = await restartAfterPiUpdate({ argv: ["-r", "-e", "./ext.ts", "--session-dir", "./sessions"] });
  assert.equal(check.restarts[0].cwd, "/test/launch");
  assert.deepEqual(check.restarts[0].args.slice(1), [
    "--session", "/test/session.json", "-e", "./ext.ts", "--session-dir", "./sessions",
  ]);
});

test("a removed launch folder falls back to manual restart without stopping the terminal", async () => {
  const check = setup({
    choice: "Update now", installResult: success, installedVersion: "99.0.0",
    cwdError: Object.assign(new Error("cwd removed"), { code: "ENOENT" }),
  });
  const command = check.command();
  check.resolveVersion("99.0.0");
  check.resolveExtensions([]);
  await command;
  assert.equal(check.restarts.length, 0);
  assert.match(check.notices.at(-1).message, /Auto-restart failed/);
  assert.ok(!check.effects.includes("tui stop"));
});

for (const [argv, kept] of [
  // A flag value equal to the prompt text stays; the prompt goes.
  [["--name", "fix", "fix"], ["--name", "fix"]],
  // After a real "--" everything is prompt text; the "--" itself is harmless at the end.
  [["--no-mcp", "--", "fix", "-x"], ["--no-mcp", "--"]],
  // A "--" that is a flag value is not a separator.
  [["--name", "--", "--no-mcp"], ["--name", "--", "--no-mcp"]],
  [["-p", "fix", "--verbose"], ["-p", "--verbose"]],
]) {
  test(`the restart follows pi's argument grammar: ${argv.join(" ")}`, async () => {
    const check = await restartAfterPiUpdate({ argv });
    assert.deepEqual(check.restarts[0].args.slice(1), ["--session", "/test/session.json", ...kept]);
  });
}

for (const nameFlag of ["--name", "-n"]) {
  test(`restart preserves a persisted name on a branch without messages: ${nameFlag}`, async () => {
    const check = await restartAfterPiUpdate({
      argv: [nameFlag, "Initial", "--model", "claude"],
      sessionHasMessages: false, sessionPersisted: true,
    });
    assert.deepEqual(check.restarts[0].args.slice(1), [
      "--session", "/test/session.json", "--model", "claude",
    ]);
  });
}

for (const sessionHasMessages of [false, true]) {
  for (const sessionFile of [null, "/test/session.json"]) {
    for (const nameFlag of ["--name", "-n"]) {
      test(`restart restores saved state only: messages ${sessionHasMessages}, file ${sessionFile}, name ${nameFlag}`, async () => {
        const flags = ["--provider", "anthropic", "--model", "claude", "--thinking", "high", nameFlag, "Initial"];
        const check = await restartAfterPiUpdate({ argv: flags, sessionHasMessages, sessionFile });
        const selector = sessionFile ? ["--session", sessionFile] : ["--no-session"];
        const kept = sessionFile && sessionHasMessages ? [] : flags;
        assert.deepEqual(check.restarts[0].args.slice(1), [...selector, ...kept]);
      });
    }
  }
  for (const modelFlags of [["--model", "claude"], ["--models", "anthropic/*"], []]) {
    test(`an API key requires manual restart: messages ${sessionHasMessages}, flags ${modelFlags.join(" ")}`, async () => {
      const check = await restartAfterPiUpdate({
        argv: [...modelFlags, "--api-key", "test-placeholder"], sessionHasMessages, expectedRestart: false,
      });
      assert.ok(!check.notices.some(({ message }) => message.includes("test-placeholder")));
    });
  }
}

for (const argv of [
  ["--name", "-c"],
  ["--name", "-c", "--no-approve"],
  ["--system-prompt", "-c", "--no-mcp"],
  ["--plan-mode", "strict", "--system-prompt", "-c", "--plan-mode", "loose"],
  // A removed value can expose prompt text, not just swallow a safety flag.
  ["--system-prompt", "-c", "--session", "old.jsonl", "do not replay"],
]) {
  test(`unsafe argument removal requires manual restart: ${argv.join(" ")}`, async () => {
    await restartAfterPiUpdate({ argv, expectedRestart: false });
  });
}

test("startup extension updates fall back to /reload when restart arguments are unsafe", async () => {
  for (const argv of [["--models", "anthropic/*", "--api-key", "test-placeholder"], ["--name", "-c"]]) {
    const check = setup({ argv, choice: "Update now", installResult: success });
    await check.start();
    check.resolveVersion("0.87.0");
    check.resolveExtensions(["example-extension"]);
    await setImmediate();
    assert.equal(check.restarts.length, 0);
    assert.ok(!check.effects.includes("shutdown"));
    assert.deepEqual(check.notices.at(-1), {
      message: "Extensions updated. Run /reload to load them.", type: "info",
    });
  }
});

test("a failed ephemeral restart uses the manual tip without showing its arguments", async () => {
  const check = await restartAfterPiUpdate({
    argv: ["--no-session", "--system-prompt", "private text", "fix"], sessionFile: null, restartStatus: 1,
  });
  assert.deepEqual(check.restarts[0].args.slice(1), ["--no-session", "--system-prompt", "private text"]);
  assert.deepEqual(check.notices.at(-1), {
    message: "Updated to 99.0.0! Auto-restart failed. Please restart pi manually.\n"
      + "Tip: run `pi --no-session` to continue without a saved session.",
    type: "error",
  });
  assert.ok(!check.notices.some(({ message }) => message.includes("private text")));
});

test("the install loader cannot be cancelled; the check loader can", async () => {
  const check = setup({ choice: "Update now", installResult: success, installedVersion: "0.87.0" });
  const command = check.command();
  check.resolveVersion("99.0.0");
  check.resolveExtensions([]);
  await command;
  assert.deepEqual(check.loaders, ["Checking for updates...", "Running pi update --self..."]);
  const [checking, install] = check.loaderInstances;
  assert.equal(checking.options, undefined);
  assert.equal(typeof checking.loader.onAbort, "function");
  assert.deepEqual(install.options, { cancellable: false });
  assert.equal(install.loader.onAbort, undefined);
});

test("a busy session defers the automatic prompt until agent_settled", async () => {
  const check = setup({ idle: false });
  await check.start();
  check.resolveVersion("99.0.0");
  check.resolveExtensions(["example-extension"]);
  await setImmediate();
  assert.equal(check.prompts.length, 0);

  await check.settle();
  await setImmediate();
  assert.deepEqual(check.prompts, [{
    title: "Update pi 0.87.0 → 99.0.0 · extensions: example-extension",
    options: ["Update all", "Update pi only", "Update extensions only", "Skip"],
  }]);
  // Only one pending offer, and it is consumed once shown.
  await check.settle();
  await setImmediate();
  assert.equal(check.prompts.length, 1);
});

test("a manual /update check replaces a deferred automatic offer", async () => {
  const check = setup({ idle: false });
  await check.start();
  check.resolveVersion("0.87.0");
  check.resolveExtensions(["example-extension"]);
  await setImmediate();
  assert.equal(check.prompts.length, 0);

  // The agent settles while the manual check is still running.
  const command = check.command();
  await check.settle();
  await command;
  await setImmediate();
  assert.equal(check.prompts.length, 1);
  await check.settle();
  await setImmediate();
  assert.equal(check.prompts.length, 1);
});

test("an automatic check that finishes after /update started stays silent", async () => {
  const check = setup({ idle: false });
  await check.start();
  const command = check.command();
  check.resolveVersion("0.87.0");
  check.resolveExtensions(["example-extension"]);
  await command;
  await setImmediate();
  assert.equal(check.prompts.length, 1);
  await check.settle();
  await setImmediate();
  assert.equal(check.prompts.length, 1);
});

test("a deferred prompt with a stale context does not leak a rejection", async () => {
  const check = setup({ idle: false });
  await check.start();
  check.resolveVersion("99.0.0");
  check.resolveExtensions([]);
  await setImmediate();
  check.invalidate();
  await check.settle();
  await setImmediate();
  assert.equal(check.prompts.length, 0);
});

test("a busy session refuses to install from /update", async () => {
  const check = setup({ idle: false, choice: "Update now", installResult: success });
  const command = check.command();
  check.resolveVersion("99.0.0");
  check.resolveExtensions([]);
  await command;
  assert.equal(check.prompts.length, 1);
  assert.deepEqual(check.executions, []);
  assert.deepEqual(check.notices.at(-1), {
    message: "Pi is busy. Run /update again when the agent has finished.", type: "warning",
  });
  assert.ok(!check.effects.some((effect) => ["install", "reload", "restart", "shutdown"].includes(effect)));
});

for (const [choice, command] of [
  ["Update all", "pi update --all"],
  ["Update pi only", "pi update --self"],
  ["Update extensions only", "pi update --extensions"],
  ["Skip", undefined],
  [null, undefined],
]) {
  test(`demo shows all three update types without side effects: ${choice ?? "dismiss"}`, async () => {
    const check = setup({ choice });
    await check.command("--test");
    assert.deepEqual(check.prompts, [{
      title: "Update pi 0.87.0 → 99.0.0 · extensions: example-tools, example-prompts",
      options: ["Update all", "Update pi only", "Update extensions only", "Skip"],
    }]);
    const demoNotice = { message: "Demo only. Nothing will be changed.", type: "info" };
    if (command) {
      assert.deepEqual(check.loaders, [`Demo: ${command}...`]);
      assert.deepEqual(check.notices, [demoNotice, { message: "Demo complete. Nothing changed.", type: "info" }]);
    } else {
      assert.equal(check.loaders.length, 0);
      assert.deepEqual(check.notices, [demoNotice]);
    }
    assert.equal(check.timers.size, 0);
    assert.deepEqual(check.effects, []);
  });
}

test("demo progress can be cancelled without a late completion or side effects", async () => {
  const check = setup({ choice: "Update all", abortInstall: true });
  await check.command("--test");
  await setImmediate();
  assert.equal(check.timers.size, 0);
  assert.equal(check.notices.length, 2);
  assert.deepEqual(check.notices[1], { message: "Demo cancelled. Nothing changed.", type: "info" });
  assert.deepEqual(check.effects, []);
});

test("demo works offline without fetching or changing any state", async () => {
  const check = setup({ env: { PI_OFFLINE: "1" }, choice: "Update all" });
  await check.command("--test");
  assert.equal(check.prompts.length, 1);
  assert.match(check.notices.at(-1).message, /^Demo complete/);
  assert.deepEqual(check.effects, []);
});

for (const options of [{ hasUI: false }, { mode: "rpc" }]) {
  test(`demo requires an interactive terminal: ${JSON.stringify(options)}`, async () => {
    const check = setup(options);
    await check.command("--test");
    assert.equal(check.prompts.length, 0);
    assert.equal(check.loaders.length, 0);
    assert.deepEqual(check.notices, [{
      message: "The update demo requires an interactive terminal.", type: "warning",
    }]);
    assert.deepEqual(check.effects, []);
  });
}
