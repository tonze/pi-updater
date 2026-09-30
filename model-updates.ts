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

interface ModelUpdate {
  current: ModelIdentity;
  latest: ModelIdentity;
  noticeId: string;
}

interface CatalogModel {
  provider: string;
  id: string;
  family: string;
  releaseDate: string;
  canonicalId?: string;
  deprecated?: boolean;
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
    (value.canonicalId === undefined || isText(value.canonicalId)) &&
    (value.deprecated === undefined || typeof value.deprecated === "boolean");
}

function parseCatalog(value: unknown): CatalogModel[] {
  if (!isRecord(value)) throw new Error("Invalid models.dev catalog");
  const models: CatalogModel[] = [];
  for (const [provider, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue;
    for (const [id, model] of Object.entries(entry.models)) {
      if (!isRecord(model) || !isText(model.family) || !isReleaseDate(model.release_date)) continue;
      if (model.type !== undefined && model.type !== "chat") continue;
      models.push({
        provider,
        id,
        family: model.family,
        releaseDate: model.release_date,
        canonicalId: isText(model.canonical_model_id) ? model.canonical_model_id : undefined,
        deprecated: model.status === "deprecated",
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

function releaseKey(provider: string, entry: CatalogModel): string {
  // Canonical IDs are provider-qualified. Keep that same form for the fallback,
  // then namespace by serving provider so separate routes notify independently.
  return `${provider}/${entry.canonicalId ?? `${entry.provider}/${entry.id}`}`;
}

export function findModelUpdates(
  scoped: readonly ModelIdentity[],
  available: readonly ModelIdentity[],
  catalog: readonly CatalogModel[],
): ModelUpdate[] {
  const metadata = new Map(catalog.map((model) => [`${model.provider}/${model.id}`, model]));
  const scopedReleases = new Map<string, { model: ModelIdentity; releaseDate: string }>();
  const scopedIds = new Set<string>();
  for (const model of scoped) {
    const entry = metadata.get(catalogKey(model));
    if (!entry) continue;
    const family = `${model.provider}/${entry.family}`;
    scopedIds.add(releaseKey(model.provider, entry));
    if (entry.releaseDate > (scopedReleases.get(family)?.releaseDate ?? "")) {
      scopedReleases.set(family, { model, releaseDate: entry.releaseDate });
    }
  }

  const candidates: { model: ModelIdentity; current: ModelIdentity; entry: CatalogModel; family: string }[] = [];
  const newestReleases = new Map([...scopedReleases].map(([family, current]) => [family, current.releaseDate]));
  for (const model of available) {
    const entry = metadata.get(catalogKey(model));
    // Deprecated releases remain valid scope baselines, but never upgrade targets.
    if (!entry || entry.deprecated) continue;
    const family = `${model.provider}/${entry.family}`;
    const current = scopedReleases.get(family);
    if (!current || entry.releaseDate <= current.releaseDate) continue;
    if (scopedIds.has(releaseKey(model.provider, entry))) continue;
    candidates.push({ model, current: current.model, entry, family });
    if (entry.releaseDate > newestReleases.get(family)!) {
      newestReleases.set(family, entry.releaseDate);
    }
  }

  const updates: ModelUpdate[] = [];
  const seen = new Set<string>();
  for (const { model, current, entry, family } of candidates) {
    const id = releaseKey(model.provider, entry);
    if (entry.releaseDate !== newestReleases.get(family) || seen.has(id)) continue;
    seen.add(id);
    updates.push({ current, latest: model, noticeId: id });
  }
  return updates;
}

export function formatModelUpdates(
  ctx: ExtensionContext,
  updates: readonly Pick<ModelUpdate, "current" | "latest">[],
): string {
  // Keep RPC notifications plain. "dim" matches Pi's status and resource lists.
  const theme = "mode" in ctx && ctx.mode === "tui" ? ctx.ui.theme : undefined;
  const fg = (color: "text" | "dim" | "accent", text: string) => theme ? theme.fg(color, text) : text;
  return [
    fg("text", "Scoped models") + fg("dim", ` · ${updates.length} update${updates.length === 1 ? "" : "s"} available`),
    ...updates.map(({ current, latest }) =>
      fg("dim", `${current.name} → `) + fg("accent", latest.name) + fg("dim", ` ${latest.provider}`)),
    "",
    fg("text", "/scoped-models") + fg("dim", " to review"),
  ].join("\n");
}

export async function checkForModelUpdates(
  ctx: ScopedContext,
  force = false,
  notify: (message: string) => void = (message) => ctx.ui.notify(message, "info"),
): Promise<void> {
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
    const unseen = updates.filter(({ noticeId }) => force || !notified.has(noticeId));
    if (unseen.length === 0) return;

    notify(formatModelUpdates(ctx, unseen));
    for (const { noticeId } of unseen) notified.add(noticeId);
    writeCache({ ...cache, notified: [...notified] });
  } catch {
    // Model hints are advisory: catalog, cache, or stale-context failures must
    // never interfere with Pi or extension updates.
  }
}
