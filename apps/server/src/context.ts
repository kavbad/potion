// Server context (SPEC §8): everything the routes need, assembled ONCE at
// boot — db (PGlite default), price table, providers (mock world by default),
// embedder + centroid assigner, and the request-level assignment cache.
//
// Boot completes with ZERO network and ZERO services: PGlite + mock provider
// + mock embedder are the defaults; live providers/embeddings only engage
// when the matching *_API_KEY env vars are present.
import { fileURLToPath } from 'node:url';
import type { PriceTable, ProviderId, StrategyConfig } from '@potion/core';
import { sha256 } from '@potion/core';
import {
  CANONICAL_EMBED_DIMS,
  createAssigner,
  createCachingEmbedder,
  centroidsFromTaxonomy,
  loadTaxonomy,
  resolveEmbedder,
  type Assignment,
  type ClusterAssigner,
  type Embedder,
  type EmbedderMode,
  type ResolvedEmbedder,
} from '@potion/cluster';
import { createDb, listServableProviderKeys, migrate, type DbHandle } from '@potion/db';
import {
  createMockProvider,
  createProviders,
  loadPrices,
  type Provider,
  type ProviderFactoryOptions,
} from '@potion/providers';
import { createResolver } from '@potion/strategies';
import {
  createMasterKeyProvider,
  CustodyService,
  type MasterKeyProvider,
} from './custody/index.js';
// ---- M3 #26 observability (m3-observability) — appended imports ----
import { withMetrics, type ObservabilityHandle } from '@potion/observability';
import type { PotionQueue } from '@potion/queue';
// ---- end M3 #26 observability imports ----
// ---- M3 #27 HA (m3-ha) — appended imports ----
import {
  createCacheInvalidator,
  type CacheInvalidationHandle,
} from './cache-invalidation.js';
// ---- end M3 #27 HA imports ----

/** Actor recorded on serving-path decrypts (custody_audit.actor). */
export const SERVE_ACTOR = 'system:serve';

/** Per-org provider resolution cache TTL (BYOK serving path, ROADMAP #16).
 * 60s bounds decrypt/audit volume; revoke/rotate/register bust the cache
 * explicitly so lifecycle changes take effect IMMEDIATELY (not at TTL). */
export const ORG_PROVIDER_CACHE_TTL_MS = 60_000;

/** Repo-root prices.json — works from both src/ (tsx) and dist/ (node). */
export const DEFAULT_PRICES_PATH = fileURLToPath(
  new URL('../../../prices.json', import.meta.url),
);

/** Strategy used when the assigned cluster has NO frontier yet (e.g.
 * 'general'): a plain mid-tier single. Documented fallback; requests served
 * this way carry `fallback=1` and `frontier=v0` in the trace header. */
export const DEFAULT_STRATEGY: StrategyConfig = { type: 'single', model: 'mock-mid' };

export type EmbedderKind = EmbedderMode;

/** Embedder identity reported by /healthz (M1a): mode, model, dims. */
export type EmbedderInfo = Pick<ResolvedEmbedder, 'mode' | 'model' | 'dims'>;

/**
 * Per-request provider set (BYOK serving path, M2 Wave 2 ROADMAP #16). When
 * the request's org has active provider keys, `providers`/`resolve` are built
 * by the provider factory with the org's DECRYPTED keys (platform env keys
 * remain the per-provider fallback); otherwise they are the boot set.
 */
export interface OrgProviders {
  providers: Record<ProviderId, Provider>;
  resolve: (model: string) => { provider: Provider; entry: PriceTable['entries'][number] };
  /** true when ≥1 provider is served from an org-registered (BYOK) key. */
  byok: boolean;
  /** Provider ids served from org keys (empty when byok=false). */
  byokProviders: ProviderId[];
}

export interface PotionContext {
  db: DbHandle;
  prices: PriceTable;
  providers: Record<ProviderId, Provider>;
  resolve: (model: string) => { provider: Provider; entry: PriceTable['entries'][number] };
  /** BYOK custody boundary (encrypt/decrypt/rotate + custody_audit). */
  custody: CustodyService;
  /** Per-request provider resolution for an org (BYOK #16): org keys win per
   * provider, platform env keys stay the fallback, boot mock set when no
   * org-key factory exists (pure mock world). Cached per org (60s TTL);
   * every cache (re)build decrypts + audits. */
  providersForOrg: (orgId: string) => Promise<OrgProviders>;
  /** Bust the per-org provider cache — called by the key lifecycle routes on
   * register/rotate/revoke so changes serve IMMEDIATELY. */
  invalidateOrgProviders: (orgId: string) => void;
  /** true when org-registered keys can actually serve (a provider factory is
   * available: live mode, or a test-injected factory). */
  byokServingEnabled: boolean;
  /** The factory behind providersForOrg (undefined in the pure mock world).
   * Exposed for the key-validation route: it builds a one-off provider from
   * a single decrypted key to probe it end-to-end. */
  providerFactory?: (opts: ProviderFactoryOptions) => Record<ProviderId, Provider>;
  assigner: ClusterAssigner;
  /** The platform embedder itself (cache-wrapped, dimension-guarded to the
   * canonical 384-dim space) — exposed for POST /v1/embeddings (M3 #25). */
  embedder: Embedder;
  /** Assignment cache: sha256(first 512 chars of concatenated user content)
   * → Assignment (SPEC §8). Unbounded in the MVP (process-lifetime Map). */
  assignCache: Map<string, Assignment>;
  embedderKind: EmbedderKind;
  embedderInfo: EmbedderInfo;
  providerMode: 'mock' | 'live';
  /** true when this boot seeded the demo data (tables were empty). */
  seeded: boolean;
  /** true when the db handle is owned by the caller (tests) and must NOT be
   * closed on app.close(). */
  externalDb: boolean;
  /** M3 #26 observability handle (undefined only when a test builds a raw
   * context without one). Carries the meter used by the serving path. */
  observability?: ObservabilityHandle;
  // ---- M3 #27 HA (m3-ha) ----
  /** Cross-instance providersForOrg cache invalidation (redis pub/sub on
   * `potion:invalidate:keys` when REDIS_URL is set, memory-only otherwise —
   * see cache-invalidation.ts). invalidateOrgProviders publishes through
   * this handle; the handle's subscription busts THIS instance's cache. */
  cacheInvalidation: CacheInvalidationHandle;
  // ---- end M3 #27 HA ----
  // ---- M4 #33/#35 alerts + budget (m4-alerts-budget) ----
  /** Job queue handle — buildServer assigns it after creation. Routes emit
   * alerts:dispatch events through it (alerts.ts); when absent (raw-context
   * tests) emission falls back to in-process dispatch. */
  queue?: PotionQueue;
  // ---- end M4 #33/#35 ----
}

export interface ContextOptions {
  /** Injected db handle (tests); when absent one is created from dbUrl /
   * DATABASE_URL / PGlite default. */
  db?: DbHandle;
  dbUrl?: string;
  pricesPath?: string;
  /** 'mock' → mock provider behind every provider id; 'live' → real factory
   * with env keys; 'auto' (default) → live when any provider key is set,
   * else mock. */
  providerMode?: 'mock' | 'live' | 'auto';
  /** Override providers entirely (tests). */
  providers?: Record<ProviderId, Provider>;
  /** Override the embedder (tests). */
  embedder?: Embedder;
  /** Centroid cosine threshold override (assigner default: 0.62). */
  assignThreshold?: number;
  /** Run the demo seed when the tables are empty (default true). */
  seed?: boolean;
  log?: (msg: string) => void;
  // ---- BYOK custody + serving (M2 Wave 2, ROADMAP #15/#16) ----
  /** Master-key provider override (tests). Default: POTION_MASTER_KEY env,
   * else the dev fallbacks (see custody/master.ts). */
  masterKeyProvider?: MasterKeyProvider;
  /** Full custody service override (tests). */
  custody?: CustodyService;
  /** Provider factory used to build PER-ORG provider sets from decrypted
   * org keys (tests inject a spy; live mode defaults to createProviders).
   * In the pure mock world with no injection, org keys are custodied but the
   * boot mock set keeps serving (documented — there is no network in mock
   * mode). */
  providerFactory?: (opts: ProviderFactoryOptions) => Record<ProviderId, Provider>;
  /** Per-org provider cache TTL override in ms (tests; default 60s). */
  orgProviderCacheTtlMs?: number;
  /** M3 #26: observability handle. When present, every provider set produced
   * by providersForOrg is wrapped with the withMetrics proxy. */
  observability?: ObservabilityHandle;
  // ---- M3 #27 HA (m3-ha) ----
  /** Cache-invalidation handle override (tests inject a stub/spy). Default:
   * built from REDIS_URL (redis pub/sub) with memory-only fallback. */
  cacheInvalidation?: CacheInvalidationHandle;
  // ---- end M3 #27 HA ----
}

/** sha256 cache key of the FIRST 512 chars of the concatenated user content
 * (SPEC §8). Falls back to all message content when no user role exists. */
export function assignmentCacheKey(contents: string[]): string {
  return sha256(contents.join('\n').slice(0, 512));
}

function envApiKeys(): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  if (process.env.ANTHROPIC_API_KEY) out.anthropic = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) out.openai = process.env.OPENAI_API_KEY;
  if (process.env.GOOGLE_API_KEY) out.google = process.env.GOOGLE_API_KEY;
  if (process.env.OPENROUTER_API_KEY) out.openrouter = process.env.OPENROUTER_API_KEY;
  return out;
}

/** Platform embedder for centroid building + assignment (M1a item 3):
 * resolveEmbedder picks OpenAI text-embedding-3-small (dimensions:384) when
 * POTION_EMBEDDER=openai + OPENAI_API_KEY (or a key with no explicit choice),
 * else the deterministic mock embedder with a loud startup warning. In the
 * mock provider world POTION_EMBEDDER defaults to 'mock' (an explicit
 * POTION_EMBEDDER value is still honored so tests can inject providers). */
function pickEmbedder(
  providers: Record<ProviderId, Provider>,
  providerMode: 'mock' | 'live',
  override?: Embedder,
  warn: (msg: string) => void = () => {},
): { embedder: Embedder; info: EmbedderInfo } {
  if (override) {
    return {
      embedder: override,
      info: { mode: 'mock', model: 'injected-embedder', dims: CANONICAL_EMBED_DIMS },
    };
  }
  const env =
    providerMode === 'live'
      ? process.env
      : { ...process.env, POTION_EMBEDDER: process.env.POTION_EMBEDDER ?? 'mock' };
  const resolved = resolveEmbedder(env, providers, { warn });
  return {
    embedder: resolved.embedder,
    info: { mode: resolved.mode, model: resolved.model, dims: resolved.dims },
  };
}

/**
 * Assignment threshold env override (M1a item 3): POTION_CLUSTER_THRESHOLD,
 * a number in (0,1). NOTE: the default 0.62 is tuned for the MOCK embedder's
 * geometry; M1b re-tunes it on real OpenAI embeddings (Gate-2 rerun against
 * the held-out set) — do NOT retune it now, this knob exists so the M1b
 * experiment doesn't need a code change.
 */
function envAssignThreshold(): number | undefined {
  const raw = process.env.POTION_CLUSTER_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`POTION_CLUSTER_THRESHOLD must be a number in (0,1), got '${raw}'`);
  }
  return value;
}

function pickProviders(
  prices: PriceTable,
  mode: 'mock' | 'live' | 'auto',
): { providers: Record<ProviderId, Provider>; mode: 'mock' | 'live' } {
  const keys = envApiKeys();
  const effective = mode === 'auto' ? (Object.keys(keys).length > 0 ? 'live' : 'mock') : mode;
  if (effective === 'live') {
    return { providers: createProviders({ prices, apiKeys: keys }), mode: effective };
  }
  // Mock world (SPEC §5 createRunProviders semantics): the deterministic mock
  // answers behind EVERY provider id so live-priced aliases still cost
  // against their real price entries.
  const mock = createMockProvider(prices);
  return {
    providers: { anthropic: mock, openai: mock, google: mock, openrouter: mock, mock },
    mode: effective,
  };
}

/** Extract the PGlite data dir from a 'pglite://<dir>' url (for the dev
 * master-key fallback persistence); null for in-memory/node-postgres. */
export function pgliteDataDirFromUrl(url: string | undefined): string | null {
  if (!url || !url.startsWith('pglite://')) return null;
  const dir = url.slice('pglite://'.length).trim();
  return dir === '' ? null : dir;
}

export async function buildContext(opts: ContextOptions = {}): Promise<PotionContext> {
  const log = opts.log ?? (() => {});
  const { table: prices } = loadPrices(opts.pricesPath ?? process.env.POTION_PRICES_PATH ?? DEFAULT_PRICES_PATH);

  const externalDb = opts.db !== undefined;
  const db = opts.db ?? (await createDb(opts.dbUrl));
  await migrate(db.db);
  log(`db ready (${db.driver})`);

  const { providers, mode } = opts.providers
    ? { providers: opts.providers, mode: 'mock' as const }
    : pickProviders(prices, opts.providerMode ?? 'auto');

  // ---- BYOK custody + per-org provider resolution (M2 Wave 2, #15/#16) ----
  const custody =
    opts.custody ??
    new CustodyService({
      db: db.db,
      master:
        opts.masterKeyProvider ??
        createMasterKeyProvider({
          persistDir: pgliteDataDirFromUrl(opts.dbUrl ?? process.env.DATABASE_URL),
          warn: log,
        }),
    });
  log(`custody ready (master: ${custody.describeMaster()})`);

  // Factory for org-key provider sets: injected (tests) or the live factory
  // in live mode. In the pure mock world there is no network, so org keys
  // stay custodied/audited but the boot mock set keeps serving.
  const orgFactory =
    opts.providerFactory ?? (mode === 'live' ? createProviders : undefined);
  const ttl = opts.orgProviderCacheTtlMs ?? ORG_PROVIDER_CACHE_TTL_MS;
  const platformResolve = createResolver(providers, prices);
  const platform: OrgProviders = {
    providers,
    resolve: platformResolve,
    byok: false,
    byokProviders: [],
  };
  const orgProviderCache = new Map<string, { expiresAt: number; value: OrgProviders }>();
  const resolveOrgProviders = async (orgId: string): Promise<OrgProviders> => {
    if (!orgFactory) return platform;
    const rows = await listServableProviderKeys(db.db, orgId);
    if (rows.length === 0) return platform;
    // Platform env keys are the per-provider fallback; org keys override.
    const apiKeys: Partial<Record<ProviderId, string>> = { ...envApiKeys() };
    const byokProviders: ProviderId[] = [];
    for (const row of rows) {
      try {
        // Every decrypt writes a custody_audit row (custody service).
        apiKeys[row.provider as ProviderId] = await custody.decryptKey(row, SERVE_ACTOR);
        byokProviders.push(row.provider as ProviderId);
      } catch (err) {
        // Tampered/legacy row: loud + fall back to the platform key for this
        // provider — never serve garbage, never crash the chat path.
        log(
          `custody: decrypt failed for provider key '${row.id}' (org ${orgId}): ` +
            `${(err as Error).message} — falling back to the platform key`,
        );
      }
    }
    if (byokProviders.length === 0) return platform;
    const orgProviders = orgFactory({ prices, apiKeys });
    return {
      providers: orgProviders,
      resolve: createResolver(orgProviders, prices),
      byok: true,
      byokProviders,
    };
  };
  // ---- M3 #26 observability (m3-observability) ----
  // Wrap an org's provider set with the transparent withMetrics proxy (call
  // duration/cost/errors observed; behavior identical). Applied to BOTH the
  // platform boot set and BYOK sets, at the cache boundary, so every
  // providersForOrg consumer is observed exactly once.
  const meter = opts.observability?.meter;
  const observeOrgProviders = (value: OrgProviders): OrgProviders => {
    if (!meter) return value;
    const observed = withMetrics(value.providers, meter, { prices });
    return { ...value, providers: observed, resolve: createResolver(observed, prices) };
  };
  // ---- end M3 #26 observability wrap ----
  const providersForOrg = async (orgId: string): Promise<OrgProviders> => {
    const hit = orgProviderCache.get(orgId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = observeOrgProviders(await resolveOrgProviders(orgId));
    orgProviderCache.set(orgId, { expiresAt: Date.now() + ttl, value });
    return value;
  };
  // ---- M3 #27 HA (m3-ha): cross-instance cache invalidation ----
  // Redis pub/sub (channel `potion:invalidate:keys`) when REDIS_URL is set;
  // memory-only no-op otherwise. The subscription busts THIS instance's
  // cache entry for the published org; invalidateOrgProviders additionally
  // PUBLISHES so peer replicas drop the same org immediately (SPEC §12.8).
  // Wired centrally here (not per-route) so every create/rotate/revoke call
  // site in routes/keys.ts — and any future one — fans out automatically.
  const cacheInvalidation =
    opts.cacheInvalidation ??
    (await createCacheInvalidator({
      redisUrl: process.env.REDIS_URL,
      onInvalidate: (orgId) => orgProviderCache.delete(orgId),
      log,
    }));
  // ---- end M3 #27 HA cache invalidation ----
  const invalidateOrgProviders = (orgId: string): void => {
    orgProviderCache.delete(orgId);
    // M3 #27: fan out to peer replicas (no-op in memory mode, never throws).
    void cacheInvalidation.publish(orgId);
  };

  // ---- taxonomy → centroids → assigner (embedder resolved per M1a item 3) ----
  const taxonomy = loadTaxonomy();
  const { embedder, info } = pickEmbedder(providers, mode, opts.embedder, log);
  const caching = createCachingEmbedder(embedder);
  const centroids = await centroidsFromTaxonomy(taxonomy, caching);
  const assigner = createAssigner(caching, centroids, opts.assignThreshold ?? envAssignThreshold());
  log(
    `assigner ready (${taxonomy.clusters.length} clusters, embedder mode=${info.mode} ` +
      `model=${info.model} dims=${info.dims})`,
  );

  const ctx: PotionContext = {
    db,
    prices,
    providers,
    resolve: platformResolve,
    custody,
    providersForOrg,
    invalidateOrgProviders,
    byokServingEnabled: orgFactory !== undefined,
    ...(orgFactory !== undefined ? { providerFactory: orgFactory } : {}),
    assigner,
    embedder: caching,
    assignCache: new Map<string, Assignment>(),
    embedderKind: info.mode,
    embedderInfo: info,
    providerMode: mode,
    seeded: false,
    externalDb,
    // M3 #26: carry the handle for the serving path (frontier decisions).
    ...(opts.observability !== undefined ? { observability: opts.observability } : {}),
    // M3 #27: cross-instance cache invalidation handle (memory-only default).
    cacheInvalidation,
  };

  if (opts.seed !== false) {
    const { seedIfEmpty } = await import('./seed.js');
    ctx.seeded = await seedIfEmpty(ctx, { log });
  }
  return ctx;
}
