import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the entire extension without real network, cache, or installer I/O.
const source = ts.transpileModule(
  readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const modelSource = ts.transpileModule(
  readFileSync(new URL("../model-updates.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup({ cachedVersion, rejectPrompt = false, env = {}, hasUI = true,
  choice = "Skip", abortInstall = false, mode = "tui", installResult,
  projectTrusted = true, idle = true, installedVersion, restartStatus,
  changedPackage = "npm", unreadableRevision, entryMissing = false } = {}) {
  const version = deferred();
  const extensions = deferred();
  const models = deferred();
  const modelChecks = [];
  const notices = [];
  const prompts = [];
  const effects = [];
  const executions = [];
  const loaders = [];
  const loaderInstances = [];
  const settingsCreates = [];
  const timers = new Set();
  const handlers = new Map();
  const commands = new Map();
  let cache = cachedVersion && JSON.stringify({ latestVersion: cachedVersion });
  let active = true;
  let installed = false;
  const tui = { stop() {}, start() {}, requestRender() {} };
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
    sessionManager: { getSessionFile: () => "/test/session.json" },
  };
  const modules = {
    "@earendil-works/pi-coding-agent": {
      VERSION: "0.87.0",
      getAgentDir: () => "/test/agent",
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
    "./model-updates.js": {
      checkForModelUpdates: (ctx, force = false, notify = (message) => ctx.ui.notify(message, "info")) => {
        modelChecks.push({ force });
        return models.promise.then((message) => {
          if (message) notify(message);
        }).catch(() => {});
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
      existsSync: (file) => ["/test/agent/git/other-extension/.git", "/test/pi/package.json"].includes(file),
      // The entrypoint is a symlink into the package, as with npm and pnpm bin links.
      realpathSync: (file) => {
        assert.equal(file, "/test/pi.js");
        if (entryMissing) throw new Error("ENOENT");
        return "/test/pi/dist/bundle/cli.js";
      },
      mkdirSync: () => { effects.push("mkdir"); },
      writeFileSync: (_path, value) => { effects.push("cache write"); cache = value; },
    },
    "node:path": path,
    "node:child_process": {
      spawnSync: () => {
        effects.push("restart");
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
      execPath: "/test/node", argv: ["/test/node", "/test/pi.js"] },
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
  const modelExports = {};
  runInNewContext(modelSource, { ...sandbox, exports: modelExports }, { filename: "model-updates.js" });
  modules["./model-updates.js"].formatModelUpdates = modelExports.formatModelUpdates;
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
    prompts, notices, modelChecks, effects, executions, loaders, loaderInstances, timers, settingsCreates,
    env: sandbox.process.env,
    start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx),
    // Pi passes the current ctx to agent_settled; the run is over by then.
    settle: () => { idle = true; return handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, ctx); },
    setIdle: (value) => { idle = value; },
    command: (args = "") => commands.get("update").handler(args, ctx),
    invalidate: () => { active = false; },
    resolveVersion: (latest) => version.resolve({ ok: true, json: async () => ({ version: latest }) }),
    rejectVersion: () => version.reject(new Error("Network unavailable")),
    resolveModels: (message) => models.resolve(message),
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
  // The model check stays unresolved: it must not delay the update prompt.
  assert.deepEqual(check.modelChecks, [{ force: false }]);
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

for (const [name, options, reason] of [
  ["offline", { env: { PI_OFFLINE: "1" } }, "startup"],
  ["user skip", { env: { PI_SKIP_VERSION_CHECK: "1" } }, "startup"],
  ["post-update restart", { env: { PI_UPDATER_SUPPRESS_STARTUP_CHECK: "1" } }, "startup"],
  ["headless", { hasUI: false }, "startup"],
  ["reload", {}, "reload"],
  ["fork", {}, "fork"],
]) {
  test(`${name} suppresses automatic model checks`, async () => {
    const check = setup(options);
    await check.start(reason);
    assert.equal(check.modelChecks.length, 0);
  });
}

test("manual /update forces model checks without awaiting them, even with automatic checks disabled", async () => {
  const check = setup({ env: { PI_SKIP_VERSION_CHECK: "1" } });
  const command = check.command();
  check.resolveVersion("0.87.0");
  check.resolveExtensions([]);
  await command;
  assert.deepEqual(check.modelChecks, [{ force: true }]);
  assert.equal(check.notices[0].message, "pi 0.87.0 · extensions up to date");
});

for (const order of ["models first", "versions first"]) {
  test(`manual /update keeps both status and model hint visible: ${order}`, async () => {
    const check = setup();
    const modelNotice = "Scoped models · 1 update available\nGPT-6 Sol → GPT-6.1 Sol openai\n\n/scoped-models to review";
    const command = check.command();
    if (order === "models first") {
      check.resolveModels(modelNotice);
      await setImmediate();
      assert.equal(check.notices.at(-1).message, modelNotice);
    }
    check.resolveVersion("0.87.0");
    check.resolveExtensions([]);
    await command;
    if (order === "versions first") {
      assert.equal(check.notices.at(-1).message, "pi 0.87.0 · extensions up to date");
      check.resolveModels(modelNotice);
      await setImmediate();
    }
    // Pi displays the last info notice in place of the previous one.
    assert.equal(check.notices.at(-1).message,
      `pi 0.87.0 · extensions up to date\n\n${modelNotice}`);
  });
}

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
    const modelNotice = [
      "Scoped models · 2 updates available",
      "GPT-6 Sol → GPT-6.1 Sol openai-codex",
      "Claude Sonnet 5 → Claude Sonnet 5.5 anthropic",
      "",
      "/scoped-models to review",
    ].join("\n");
    assert.equal(check.notices[0].message, `Demo only. Nothing will be changed.\n\n${modelNotice}`);
    if (command) {
      assert.deepEqual(check.loaders, [`Demo: ${command}...`]);
      assert.equal(check.notices.length, 2);
      assert.equal(check.notices[1].message, `Demo complete. Nothing changed.\n\n${modelNotice}`);
    } else {
      assert.equal(check.loaders.length, 0);
      assert.equal(check.notices.length, 1);
    }
    assert.equal(check.timers.size, 0);
    assert.deepEqual(check.effects, []);
    assert.deepEqual(check.modelChecks, []);
  });
}

test("demo progress can be cancelled without a late completion or side effects", async () => {
  const check = setup({ choice: "Update all", abortInstall: true });
  await check.command("--test");
  await setImmediate();
  assert.equal(check.timers.size, 0);
  assert.equal(check.notices.length, 2);
  assert.match(check.notices[1].message, /^Demo cancelled\. Nothing changed\./);
  assert.match(check.notices[1].message, /Scoped models · 2 updates available/);
  assert.deepEqual(check.effects, []);
  assert.deepEqual(check.modelChecks, []);
});

test("demo works offline without fetching or changing any state", async () => {
  const check = setup({ env: { PI_OFFLINE: "1" }, choice: "Update all" });
  await check.command("--test");
  assert.equal(check.prompts.length, 1);
  assert.match(check.notices.at(-1).message, /^Demo complete/);
  assert.deepEqual(check.effects, []);
  assert.deepEqual(check.modelChecks, []);
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
    assert.deepEqual(check.modelChecks, []);
  });
}

test("manual offline and --test flows do not fetch model metadata", async () => {
  const offline = setup({ env: { PI_OFFLINE: "1" } });
  await offline.command();
  assert.equal(offline.modelChecks.length, 0);
  const simulation = setup();
  await simulation.command("--test");
  assert.equal(simulation.modelChecks.length, 0);
});
