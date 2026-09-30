import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_FILE = join(getAgentDir(), "model-update-cache.json");
const CACHE_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface ModelIdentity {
  provider: string;
  id: string;
  name: string;
}

interface CatalogModel {
  provider: string;
  id: string;
  family: string;
  releaseDate: string;
  canonicalId?: string;
}

interface ModelUpdateCache {
  checkedAt: number;
  models: CatalogModel[];
  notified: string[];
}

// Pi 0.74 supports ordinary updates but does not expose scopedModels yet.
type ScopedContext = ExtensionContext & {
  scopedModels?: readonly { model: ModelIdentity }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isReleaseDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isCatalogModel(value: unknown): value is CatalogModel {
  return isRecord(value) && isText(value.provider) && isText(value.id) &&
    isText(value.family) && isReleaseDate(value.releaseDate) &&
    (value.canonicalId === undefined || isText(value.canonicalId));
}

function parseCatalog(value: unknown): CatalogModel[] {
  if (!isRecord(value)) throw new Error("Invalid models.dev catalog");
  const models: CatalogModel[] = [];
  for (const [provider, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue;
    for (const [id, model] of Object.entries(entry.models)) {
      if (!isRecord(model) || !isText(model.family) || !isReleaseDate(model.release_date)) continue;
      if (model.status === "deprecated" || (model.type !== undefined && model.type !== "chat")) continue;
      models.push({
        provider,
        id,
        family: model.family,
        releaseDate: model.release_date,
        canonicalId: isText(model.canonical_model_id) ? model.canonical_model_id : undefined,
      });
    }
  }
  // Do not replace a good cache with an error page or an unrecognized response.
  if (models.length === 0) throw new Error("No model release metadata in catalog");
  return models;
}

function readCache(): ModelUpdateCache {
  try {
    const value: unknown = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (isRecord(value) && typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt) &&
      Array.isArray(value.models) && Array.isArray(value.notified)) {
      return {
        checkedAt: value.checkedAt,
        models: value.models.filter(isCatalogModel),
        notified: value.notified.filter(isText),
      };
    }
  } catch {}
  return { checkedAt: 0, models: [], notified: [] };
}

function writeCache(cache: ModelUpdateCache) {
  const temporary = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(temporary, JSON.stringify(cache) + "\n");
    renameSync(temporary, CACHE_FILE);
  } catch {
    try { unlinkSync(temporary); } catch {}
  }
}

let catalogRequest: Promise<CatalogModel[]> | undefined;

async function refreshCatalog(cache: ModelUpdateCache): Promise<CatalogModel[]> {
  let models = cache.models;
  try {
    const response = await fetch(CATALOG_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) models = parseCatalog(await response.json());
  } catch {}
  // Back off after failures too, rather than retrying on every Pi launch.
  // Read again because another check may have recorded a notice during the fetch.
  writeCache({ ...readCache(), checkedAt: Date.now(), models });
  return models;
}

function getCatalog(force: boolean): Promise<CatalogModel[]> {
  if (catalogRequest) return catalogRequest;
  const cache = readCache();
  if (!force && Date.now() - cache.checkedAt < CACHE_INTERVAL_MS) {
    return Promise.resolve(cache.models);
  }
  catalogRequest = refreshCatalog(cache).finally(() => { catalogRequest = undefined; });
  return catalogRequest;
}

function catalogKey(model: ModelIdentity): string {
  // Codex serves OpenAI model IDs, but models.dev has no openai-codex provider.
  const provider = model.provider === "openai-codex" ? "openai" : model.provider;
  return `${provider}/${model.id}`;
}

export function findModelUpdates(
  scoped: readonly ModelIdentity[],
  available: readonly ModelIdentity[],
  catalog: readonly CatalogModel[],
): ModelIdentity[] {
  const metadata = new Map(catalog.map((model) => [`${model.provider}/${model.id}`, model]));
  const scopedReleases = new Map<string, string>();
  const scopedIds = new Set<string>();
  for (const model of scoped) {
    const entry = metadata.get(catalogKey(model));
    if (!entry) continue;
    const family = `${model.provider}/${entry.family}`;
    scopedIds.add(`${model.provider}/${entry.canonicalId ?? entry.id}`);
    if (entry.releaseDate > (scopedReleases.get(family) ?? "")) {
      scopedReleases.set(family, entry.releaseDate);
    }
  }

  const candidates: { model: ModelIdentity; entry: CatalogModel; family: string }[] = [];
  const newestReleases = new Map(scopedReleases);
  for (const model of available) {
    const entry = metadata.get(catalogKey(model));
    if (!entry) continue;
    const family = `${model.provider}/${entry.family}`;
    const current = scopedReleases.get(family);
    if (!current || entry.releaseDate <= current) continue;
    if (scopedIds.has(`${model.provider}/${entry.canonicalId ?? entry.id}`)) continue;
    candidates.push({ model, entry, family });
    if (entry.releaseDate > newestReleases.get(family)!) {
      newestReleases.set(family, entry.releaseDate);
    }
  }

  const updates: ModelIdentity[] = [];
  const seen = new Set<string>();
  for (const { model, entry, family } of candidates) {
    const id = `${model.provider}/${entry.canonicalId ?? entry.id}`;
    if (entry.releaseDate !== newestReleases.get(family) || seen.has(id)) continue;
    seen.add(id);
    updates.push(model);
  }
  return updates;
}

export async function checkForModelUpdates(ctx: ScopedContext, force = false): Promise<void> {
  try {
    if (process.env.PI_OFFLINE || !ctx.hasUI || !ctx.scopedModels?.length) return;
    const catalog = await getCatalog(force);
    // Scope and availability can change while the request is in flight. Accessing
    // a replaced context throws; the catch also keeps that off the startup path.
    if (process.env.PI_OFFLINE || !ctx.hasUI) return;
    const updates = findModelUpdates(
      (ctx.scopedModels ?? []).map(({ model }) => model),
      ctx.modelRegistry.getAvailable(),
      catalog,
    );
    const cache = readCache();
    const notified = new Set(cache.notified);
    const unseen = updates.filter((model) => force || !notified.has(`${model.provider}/${model.id}`));
    if (unseen.length === 0) return;

    const names = unseen.map((model) => `${model.name} (${model.provider})`).join(", ");
    ctx.ui.notify(`Newer releases in your scoped model families: ${names}. Review with /scoped-models.`, "info");
    for (const model of unseen) notified.add(`${model.provider}/${model.id}`);
    writeCache({ ...cache, notified: [...notified] });
  } catch {
    // Model hints are advisory: catalog, cache, or stale-context failures must
    // never interfere with Pi or extension updates.
  }
}
