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
  choice = "Skip", abortInstall = false, mode = "tui", installResult } = {}) {
  const version = deferred();
  const extensions = deferred();
  const models = deferred();
  const modelChecks = [];
  const notices = [];
  const prompts = [];
  const effects = [];
  const executions = [];
  const loaders = [];
  const timers = new Set();
  const handlers = new Map();
  const commands = new Map();
  let cache = cachedVersion && JSON.stringify({ latestVersion: cachedVersion });
  let active = true;
  const ui = {
    async select(title, options) {
      prompts.push({ title, options: Array.from(options) });
      if (rejectPrompt) throw new Error("Prompt failed");
      return choice;
    },
    theme: { fg: (_color, text) => text, bold: (text) => text },
    notify: (message, type) => notices.push({ message, type }),
    custom: (factory) => new Promise((done) => {
      const loader = factory({}, ui.theme, {}, done);
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
    reload: async () => { effects.push("reload"); },
    shutdown: () => { effects.push("shutdown"); },
    sessionManager: { getSessionFile: () => "/test/session.json" },
  };
  const modules = {
    "@earendil-works/pi-coding-agent": {
      VERSION: "0.87.0",
      getAgentDir: () => "/test/agent",
      BorderedLoader: class {
        constructor(_tui, _theme, message) { loaders.push(message); }
      },
      SettingsManager: { create: () => ({}) },
      DefaultPackageManager: class {
        checkForAvailableUpdates() { effects.push("extension check"); return extensions.promise; }
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
      readFileSync: () => {
        effects.push("cache read");
        if (!cache) throw new Error("ENOENT");
        return cache;
      },
      mkdirSync: () => { effects.push("mkdir"); },
      writeFileSync: (_path, value) => { effects.push("cache write"); cache = value; },
    },
    "node:path": path,
    "node:child_process": {
      spawnSync: () => { effects.push("restart"); throw new Error("Unexpected restart"); },
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
      effects.push("install");
      executions.push({ program, args: Array.from(args), options: { ...options } });
      if (!installResult) throw new Error("Unexpected install");
      assert.equal(sandbox.process.env.PI_SKIP_VERSION_CHECK, undefined);
      assert.equal(sandbox.process.env.PI_UPDATER_SUPPRESSED_NATIVE_VERSION_CHECK, undefined);
      return installResult;
    },
  });

  return {
    prompts, notices, modelChecks, effects, executions, loaders, timers,
    env: sandbox.process.env,
    start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx),
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
  ["Update all", "99.0.0", ["example-extension"], ["--self", "--extensions"]],
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

for (const [choice, command] of [
  ["Update all", "pi update --self --extensions"],
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
