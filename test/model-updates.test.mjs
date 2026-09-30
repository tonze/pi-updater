import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(new URL("../model-updates.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const CACHE_FILE = "/test/agent/model-update-cache.json";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const sol = { provider: "openai", id: "gpt-6-sol", name: "GPT-6 Sol" };
const newerSol = { provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
const terra = { provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra" };
const astra = { provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" };
const newerSonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const local = { provider: "llama.cpp", id: "local-model", name: "Local model" };
const catalog = [
  { ...sol, family: "gpt-sol", releaseDate: "2026-09-22" },
  { ...newerSol, family: "gpt-sol", releaseDate: "2026-09-29" },
  { ...terra, family: "gpt-terra", releaseDate: "2026-07-09" },
  { ...astra, family: "gpt-astra", releaseDate: "2026-09-04" },
  { ...sonnet, family: "claude-sonnet", releaseDate: "2026-06-30" },
  { ...newerSonnet, family: "claude-sonnet", releaseDate: "2026-09-28" },
];
const available = [sol, newerSol, terra, astra, sonnet, newerSonnet, local];

function apiCatalog(entries = catalog) {
  const result = {};
  for (const model of entries) {
    result[model.provider] ??= { models: {} };
    result[model.provider].models[model.id] = {
      family: model.family,
      release_date: model.releaseDate,
      canonical_model_id: model.canonicalId,
      status: model.deprecated ? "deprecated" : undefined,
    };
  }
  return result;
}

function setup({
  cache,
  files = new Map(),
  now = NOW,
  scope = [sol],
  models = available,
  env = {},
  hasUI = true,
  mode = "tui",
  fetchResult = { ok: true, json: async () => apiCatalog() },
  failWrites = false,
} = {}) {
  if (cache !== undefined) files.set(CACHE_FILE, typeof cache === "string" ? cache : JSON.stringify(cache));
  const requests = [], notices = [];
  let active = true;
  let rejectNotice = false;
  const ctx = {
    mode,
    get hasUI() { assertActive(); return hasUI; },
    get scopedModels() { assertActive(); return scope?.map((model) => ({ model })); },
    get modelRegistry() { assertActive(); return { getAvailable: () => models }; },
    get ui() {
      assertActive();
      return {
        theme: {
          fg: (color, text) => `<${color}>${text}</${color}>`,
          bold: (text) => `<bold>${text}</bold>`,
        },
        notify: (message, type) => {
          if (rejectNotice) throw new Error("UI unavailable");
          notices.push({ message, type });
        },
      };
    },
  };
  function assertActive() {
    if (!active) throw new Error("This extension ctx is stale after session replacement or reload.");
  }
  const modules = {
    "@earendil-works/pi-coding-agent": { getAgentDir: () => "/test/agent" },
    "node:path": path,
    "node:fs": {
      readFileSync: (file) => {
        if (!files.has(file)) throw new Error("ENOENT");
        return files.get(file);
      },
      mkdirSync: () => {},
      writeFileSync: (file, content) => {
        if (failWrites) throw new Error("EACCES");
        files.set(file, content);
      },
      renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
      unlinkSync: (file) => { files.delete(file); },
    },
  };
  const exports = {};
  runInNewContext(source, {
    exports,
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
      return modules[name];
    },
    process: { env, pid: 1234 },
    Date: class extends Date { static now() { return now; } },
    AbortSignal,
    fetch: (url, options) => {
      requests.push({ url, options });
      return typeof fetchResult === "function" ? fetchResult() : fetchResult;
    },
  });
  return {
    requests, notices, files, env,
    check: (force = false, notify) => exports.checkForModelUpdates(ctx, force, notify),
    find: (scope, models = available, metadata = catalog) => Array.from(exports.findModelUpdates(scope, models, metadata), ({ latest }) => latest),
    findPairs: (scope, models = available, metadata = catalog) => Array.from(exports.findModelUpdates(scope, models, metadata), ({ current, latest }) => ({ current, latest })),
    cache: () => JSON.parse(files.get(CACHE_FILE)),
    invalidate: () => { active = false; },
    setScope: (value) => { scope = value; },
    setAvailable: (value) => { models = value; },
    rejectNotice: () => { rejectNotice = true; },
  };
}

function cached(overrides = {}) {
  return { checkedAt: NOW, models: catalog, notified: [], ...overrides };
}

for (const [name, scope, expected] of [
  ["Sol release", [sol], [newerSol]],
  ["newer version already scoped", [sol, newerSol], []],
  ["Terra is not Sol", [terra], []],
  ["Astra is not Sol", [astra], []],
  ["multiple families", [sol, sonnet], [newerSol, newerSonnet]],
  ["local model only", [local], []],
  ["mixed local and cloud", [local, sol], [newerSol]],
  ["no scope", [], []],
]) {
  test(`matching: ${name}`, () => {
    assert.deepEqual(setup().find(scope), expected);
  });
}

test("only suggests available models through the scoped provider", () => {
  const otherRoute = { ...newerSol, provider: "other-provider" };
  const check = setup();
  assert.deepEqual(check.find([sol], [sol, otherRoute], [...catalog, { ...catalog[1], provider: "other-provider" }]), []);
  assert.deepEqual(check.find([sol], [sol]), []);
  assert.deepEqual(check.find([{ ...sol, provider: "local" }]), []);
});

test("OpenAI Codex uses OpenAI metadata, without changing the serving provider", () => {
  const scoped = { ...sol, provider: "openai-codex" };
  const candidate = { ...newerSol, provider: "openai-codex" };
  assert.deepEqual(setup().find([scoped], [scoped, candidate, newerSol]), [candidate]);
});

test("only offers the newest available release, not every intermediate version", () => {
  const oldest = { ...sol, id: "gpt-5.6-sol" };
  const metadata = [...catalog, { ...oldest, family: "gpt-sol", releaseDate: "2026-07-09" }];
  assert.deepEqual(setup().find([oldest], available, metadata), [newerSol]);
});

test("the old-to-new pair starts from the newest scoped release, regardless of scope order", () => {
  const oldest = { ...sol, id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
  const metadata = [...catalog, { ...oldest, family: "gpt-sol", releaseDate: "2026-07-09" }];
  const check = setup();
  for (const scope of [[oldest, sol], [sol, oldest]]) {
    assert.deepEqual(check.findPairs(scope, available, metadata), [{ current: sol, latest: newerSol }]);
  }
});

test("canonical aliases are deduplicated and are not offered if already scoped", () => {
  const alias = { ...newerSol, id: "sol-latest" };
  // The canonical target deliberately omits its optional canonicalId.
  const metadata = [...catalog, {
    ...alias, family: "gpt-sol", releaseDate: "2026-09-30", canonicalId: "openai/gpt-6.1-sol",
  }];
  const check = setup();
  assert.deepEqual(check.find([sol], [...available, alias], metadata), [alias]);
  assert.deepEqual(check.find([sol, newerSol], [...available, alias], metadata), []);
  metadata.at(-1).releaseDate = "2026-09-29";
  assert.deepEqual(check.find([sol], [...available, alias], metadata), [newerSol]);
});

test("fresh catalog cache avoids the network and notices persist across launches", async () => {
  const files = new Map([["/test/agent/update-cache.json", "untouched"]]);
  const check = setup({ files, cache: cached() });
  await check.check();
  assert.equal(check.requests.length, 0);
  assert.equal(check.notices.length, 1);
  assert.equal(check.notices[0].message, [
    "<text>Scoped models</text><dim> · 1 update available</dim>",
    "<dim>GPT-6 Sol → </dim><accent>GPT-6.1 Sol</accent><dim> openai</dim>",
    "",
    "<text>/scoped-models</text><dim> to review</dim>",
  ].join("\n"));
  assert.equal(check.notices[0].type, "info");
  assert.deepEqual(check.cache().notified, ["openai/openai/gpt-6.1-sol"]);
  assert.equal(files.get("/test/agent/update-cache.json"), "untouched");
  assert.equal([...files.keys()].some((name) => name.endsWith(".tmp")), false);
  const nextLaunch = setup({ files });
  await nextLaunch.check();
  assert.equal(nextLaunch.requests.length, 0);
  assert.equal(nextLaunch.notices.length, 0);
});

test("automatic notices stay deduplicated when the available alias changes", async () => {
  const alias = { ...newerSol, id: "sol-latest" };
  const metadata = [...catalog, {
    ...alias, family: "gpt-sol", releaseDate: "2026-09-29", canonicalId: "openai/gpt-6.1-sol",
  }];
  const first = setup({ cache: cached({ models: metadata }), models: [sol, newerSol] });
  await first.check();
  assert.equal(first.notices.length, 1);
  const next = setup({ files: first.files, models: [sol, alias] });
  await next.check();
  assert.equal(next.notices.length, 0);
});

test("canonical release notices stay separate for each serving provider", async () => {
  const codexScope = { ...sol, provider: "openai-codex" };
  const codexLatest = { ...newerSol, provider: "openai-codex" };
  const check = setup({ cache: cached(), models: [...available, codexLatest] });
  await check.check();
  assert.equal(check.notices.length, 1);
  check.setScope([codexScope]);
  await check.check();
  assert.equal(check.notices.length, 2);
  assert.match(check.notices[1].message, /openai-codex/);
  await check.check();
  assert.equal(check.notices.length, 2);
});

test("adding canonical metadata does not repeat an automatic notice", async () => {
  const first = setup({ cache: cached() });
  await first.check();
  const metadata = catalog.map((model) => ({ ...model, canonicalId: `${model.provider}/${model.id}` }));
  const next = setup({
    files: first.files, now: NOW + FOUR_HOURS,
    fetchResult: { ok: true, json: async () => apiCatalog(metadata) },
  });
  await next.check();
  assert.equal(next.notices.length, 0);
});

test("a later release still notifies after an earlier release was shown", async () => {
  const first = setup({ cache: cached() });
  await first.check();
  const latest = { ...newerSol, id: "gpt-6.2-sol", name: "GPT-6.2 Sol" };
  const metadata = [...catalog, { ...latest, family: "gpt-sol", releaseDate: "2026-09-30" }];
  const next = setup({
    files: first.files, now: NOW + FOUR_HOURS,
    models: [...available, latest],
    fetchResult: { ok: true, json: async () => apiCatalog(metadata) },
  });
  await next.check();
  assert.equal(next.notices.length, 1);
  assert.match(next.notices[0].message, /GPT-6\.2 Sol/);
});

test("adding the suggested release to scope suppresses even manual hints", async () => {
  const check = setup({ cache: cached() });
  await check.check();
  check.setScope([sol, newerSol]);
  await check.check(true);
  assert.equal(check.notices.length, 1);
});

test("multiple updates use one compact block with a line per model", async () => {
  const check = setup({ cache: cached(), scope: [sol, sonnet] });
  await check.check();
  assert.equal(check.notices.length, 1);
  assert.equal(check.notices[0].message, [
    "<text>Scoped models</text><dim> · 2 updates available</dim>",
    "<dim>GPT-6 Sol → </dim><accent>GPT-6.1 Sol</accent><dim> openai</dim>",
    "<dim>Claude Sonnet 5 → </dim><accent>Claude Sonnet 5.5</accent><dim> anthropic</dim>",
    "",
    "<text>/scoped-models</text><dim> to review</dim>",
  ].join("\n"));
});

test("RPC notices retain the short layout without terminal styling", async () => {
  const check = setup({ cache: cached(), mode: "rpc" });
  await check.check();
  assert.equal(check.notices[0].message, "Scoped models · 1 update available\nGPT-6 Sol → GPT-6.1 Sol openai\n\n/scoped-models to review");
});

test("manual checks refresh and show eligible hints even if previously notified", async () => {
  const check = setup({ cache: cached({ notified: ["openai/openai/gpt-6.1-sol"] }) });
  await check.check(true);
  assert.equal(check.requests.length, 1);
  const [{ url, options }] = check.requests;
  assert.equal(url, "https://models.dev/api.json");
  assert.deepEqual(Object.keys(options.headers), ["accept"]);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(check.notices.length, 1);
});

test("cache expires after four hours", async () => {
  const check = setup({ cache: cached(), now: NOW + FOUR_HOURS });
  await check.check();
  assert.equal(check.requests.length, 1);
  assert.equal(check.cache().checkedAt, NOW + FOUR_HOURS);
});

for (const [name, fetchResult] of [
  ["network rejection", () => Promise.reject(new Error("network unavailable"))],
  ["timeout", () => Promise.reject(new DOMException("timeout", "TimeoutError"))],
  ["HTTP failure", { ok: false }],
  ["invalid JSON", { ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } }],
  ["invalid catalog", { ok: true, json: async () => ({ error: "unavailable" }) }],
]) {
  test(`${name} preserves the cache and backs off across launches`, async () => {
    const check = setup({ cache: cached({ checkedAt: NOW - FOUR_HOURS }), fetchResult });
    await check.check();
    assert.equal(check.cache().models.length, catalog.length);
    assert.equal(check.cache().checkedAt, NOW);
    const nextLaunch = setup({ files: check.files });
    await nextLaunch.check();
    assert.equal(nextLaunch.requests.length, 0);
    assert.equal(nextLaunch.notices.length, 0);
  });
}

test("a failed first request is silent and is not retried at every startup", async () => {
  const check = setup({ fetchResult: { ok: false } });
  await check.check();
  assert.equal(check.notices.length, 0);
  const nextLaunch = setup({ files: check.files });
  await nextLaunch.check();
  assert.equal(nextLaunch.requests.length, 0);
});

for (const source of ["network", "cache"]) {
  test(`deprecated scoped models still provide release baselines (${source})`, async () => {
    const metadata = catalog.map((model) => ({ ...model, deprecated: model.id === sol.id }));
    const check = setup(source === "cache"
      ? { cache: cached({ models: metadata }) }
      : { fetchResult: { ok: true, json: async () => apiCatalog(metadata) } });
    await check.check();
    assert.equal(check.requests.length, source === "cache" ? 0 : 1);
    assert.equal(check.notices.length, 1);
    assert.match(check.notices[0].message, /GPT-6\.1 Sol/);
    assert.equal(check.cache().models.find((model) => model.id === sol.id).deprecated, true);
  });

  test(`deprecated candidates do not hide the newest active upgrade (${source})`, async () => {
    const deprecated = { ...newerSol, id: "deprecated-sol", name: "Deprecated Sol" };
    const metadata = [...catalog, {
      ...deprecated, family: "gpt-sol", releaseDate: "2026-09-30", deprecated: true,
    }];
    const options = source === "cache"
      ? { cache: cached({ models: metadata }) }
      : { fetchResult: { ok: true, json: async () => apiCatalog(metadata) } };
    const check = setup({ ...options, models: [...available, deprecated] });
    await check.check();
    assert.equal(check.requests.length, source === "cache" ? 0 : 1);
    assert.equal(check.notices.length, 1);
    assert.match(check.notices[0].message, /GPT-6\.1 Sol/);
    assert.doesNotMatch(check.notices[0].message, /Deprecated Sol/);
  });

  test(`no hint when the only newer release is deprecated (${source})`, async () => {
    const metadata = catalog.map((model) => ({ ...model, deprecated: model.id === newerSol.id }));
    const check = setup(source === "cache"
      ? { cache: cached({ models: metadata }) }
      : { fetchResult: { ok: true, json: async () => apiCatalog(metadata) } });
    await check.check();
    assert.equal(check.notices.length, 0);
    assert.deepEqual(check.cache().notified, []);
  });
}

test("malformed entries are skipped without hiding valid model updates", async () => {
  const data = apiCatalog();
  Object.assign(data.openai.models, {
    null: null,
    unknown: {},
    missingFamily: { release_date: "2026-09-30" },
    missingDate: { family: "gpt-sol" },
    partialDate: { family: "gpt-sol", release_date: "2026-09" },
    invalidDate: { family: "gpt-sol", release_date: "2026-02-30" },
    decision: { family: "gpt-sol", release_date: "2026-09-30", type: "decision" },
  });
  data.invalidProvider = null;
  const check = setup({ fetchResult: { ok: true, json: async () => data } });
  await check.check();
  assert.equal(check.notices.length, 1);
  assert.equal(check.cache().models.length, catalog.length);
});

for (const cache of ["{", "null", "[]", { checkedAt: "bad", models: [], notified: [] }]) {
  test(`corrupt cache is refetched: ${JSON.stringify(cache)}`, async () => {
    const check = setup({ cache });
    await check.check();
    assert.equal(check.requests.length, 1);
    assert.equal(check.notices.length, 1);
  });
}

test("malformed cached entries do not break valid cached hints", async () => {
  const check = setup({ cache: cached({ models: [null, {}, ...catalog], notified: [null, 42] }) });
  await check.check();
  assert.equal(check.requests.length, 0);
  assert.equal(check.notices.length, 1);
});

for (const [name, options] of [
  ["offline", { env: { PI_OFFLINE: "1" } }],
  ["headless", { hasUI: false }],
  ["no scoped models", { scope: [] }],
]) {
  test(`${name} skips both network and notices, including manual checks`, async () => {
    const check = setup({ ...options, cache: cached() });
    await check.check();
    await check.check(true);
    assert.equal(check.requests.length, 0);
    assert.equal(check.notices.length, 0);
  });
}

test("older Pi without scopedModels retains ordinary updater compatibility", async () => {
  const check = setup();
  check.setScope(undefined);
  await check.check();
  assert.equal(check.requests.length, 0);
});

test("failed cache writes do not prevent a hint or leak an error", async () => {
  const check = setup({ failWrites: true });
  await check.check();
  assert.equal(check.notices.length, 1);
});

test("concurrent checks share one catalog request and only one automatic notice", async () => {
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const check = setup({ fetchResult: () => response });
  const first = check.check();
  const second = check.check();
  assert.equal(check.requests.length, 1);
  resolve({ ok: true, json: async () => apiCatalog() });
  await Promise.all([first, second]);
  assert.equal(check.notices.length, 1);
});

for (const change of ["stale", "scope", "availability", "offline"]) {
  test(`${change} changing during fetch suppresses an obsolete notice`, async () => {
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const check = setup({ fetchResult: () => response });
    const checking = check.check();
    if (change === "stale") check.invalidate();
    if (change === "scope") check.setScope([terra]);
    if (change === "availability") check.setAvailable([sol]);
    if (change === "offline") check.env.PI_OFFLINE = "1";
    resolve({ ok: true, json: async () => apiCatalog() });
    await checking;
    assert.equal(check.notices.length, 0);
    assert.deepEqual(check.cache().notified, []);
  });
}

test("manual updater can compose the hint without emitting a separate notice", async () => {
  const check = setup({ cache: cached(), mode: "rpc" });
  const messages = [];
  await check.check(false, (message) => messages.push(`Update status\n\n${message}`));
  assert.equal(check.notices.length, 0);
  assert.deepEqual(messages, ["Update status\n\nScoped models · 1 update available\nGPT-6 Sol → GPT-6.1 Sol openai\n\n/scoped-models to review"]);
  assert.deepEqual(check.cache().notified, ["openai/openai/gpt-6.1-sol"]);
});

test("a failed composed notification is not recorded as shown", async () => {
  const check = setup({ cache: cached() });
  await check.check(false, () => { throw new Error("Stale manual command"); });
  assert.deepEqual(check.cache().notified, []);
});

test("a failed notification is not recorded as shown", async () => {
  const check = setup({ cache: cached() });
  check.rejectNotice();
  await check.check();
  assert.deepEqual(check.cache().notified, []);
});
