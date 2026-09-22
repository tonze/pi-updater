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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup({ cachedVersion, rejectPrompt = false } = {}) {
  const version = deferred();
  const extensions = deferred();
  const prompts = [];
  const handlers = new Map();
  let cache = cachedVersion && JSON.stringify({ latestVersion: cachedVersion });
  let active = true;
  const ui = {
    async select(title, options) {
      prompts.push({ title, options: Array.from(options) });
      if (rejectPrompt) throw new Error("Prompt failed");
      return "Skip";
    },
  };
  function assertActive() {
    if (!active) throw new Error("This extension ctx is stale after session replacement or reload.");
  }
  // pi guards even hasUI with assertActive(), not just UI operations.
  const ctx = {
    get hasUI() { assertActive(); return true; },
    get ui() { assertActive(); return ui; },
    cwd: "/test/project",
  };
  const modules = {
    "@earendil-works/pi-coding-agent": {
      VERSION: "0.87.0",
      getAgentDir: () => "/test/agent",
      BorderedLoader: class { constructor() { throw new Error("Unexpected install"); } },
      SettingsManager: { create: () => ({}) },
      DefaultPackageManager: class {
        checkForAvailableUpdates() { return extensions.promise; }
      },
    },
    "node:fs": {
      readFileSync: () => {
        if (!cache) throw new Error("ENOENT");
        return cache;
      },
      mkdirSync: () => {},
      writeFileSync: (_path, value) => { cache = value; },
    },
    "node:path": path,
    "node:child_process": {
      spawnSync: () => { throw new Error("Unexpected restart"); },
    },
  };
  const exports = {};
  runInNewContext(source, {
    exports,
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
      return modules[name];
    },
    process: { env: {}, versions: process.versions, version: process.version, platform: process.platform, arch: process.arch },
    AbortSignal,
    fetch: () => version.promise,
  }, { filename: "index.js" });
  exports.default({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    exec: () => { throw new Error("Unexpected install"); },
  });

  return {
    prompts,
    start: () => handlers.get("session_start")({ reason: "startup" }, ctx),
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
