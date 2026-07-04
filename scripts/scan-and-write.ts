/*
 * scripts/scan-and-write.ts — one-shot CI scanner.
 *
 * Runs a single hot/cold/reference pass, writes JSONL rows and JSON snapshots
 * into a `data` directory that CI commits to the `data` branch.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WarframeMarketClient } from "../src/wfm/client.js";
import { attributeSignature, analyzeMarket, DEFAULT_CONFIG, normalizeConfig } from "../src/wfm/opportunities.js";
import type { DashboardState, Opportunity, RivenAuction, RivenWeapon, ReferenceSnapshot, ScanStatus } from "../src/wfm/types.js";

type Tier = "hot" | "cold" | "reference";

interface Args {
  tier: Tier;
  dataDir: string;
  hotSize: number;
  coldSize: number;
  ratePerSecond: number;
  burst: number;
  concurrency: number;
  userAgent: string;
}

interface IndexFile {
  schema_version: 1;
  updated_at: string;
  tiers: {
    hot?: { last_run_at: string; scanned_slugs: string[] };
    cold?: { last_run_at: string; cursor: number; scanned_slugs: string[] };
    reference?: { last_run_at: string; weapons: number; attributes: number; version_hash?: string };
  };
}

interface CiStateExtras {
  schemaVersion: 1;
  tier: Tier;
  scannedWeaponSlugs: string[];
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const arg = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const tierRaw = (arg("--tier") ?? env.WFM_TIER ?? "hot").toLowerCase();
  const tier: Tier = tierRaw === "cold" ? "cold" : tierRaw === "reference" ? "reference" : "hot";
  return {
    tier,
    dataDir: arg("--data-dir") ?? env.WFM_DATA_DIR ?? "data",
    hotSize: numberOr(arg("--hot-size") ?? env.WFM_HOT_SIZE, 40),
    coldSize: numberOr(arg("--cold-size") ?? env.WFM_COLD_SLICE_SIZE, 150),
    ratePerSecond: numberOr(env.WFM_RATE_PER_SEC, 2),
    burst: numberOr(env.WFM_BURST, 10),
    concurrency: numberOr(env.WFM_CONCURRENCY, 3),
    userAgent: env.WFM_USER_AGENT ?? "wf-riventrader-ci/0.1 (+https://github.com/ck0i/WF-RivenTrader)",
  };
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function loadOrRefreshReference(args: Args, client: WarframeMarketClient): Promise<ReferenceSnapshot> {
  const cachedPath = join(args.dataDir, "reference", "current.json");
  const cached = await readJsonIfExists<ReferenceSnapshot>(cachedPath);
  if (cached && Array.isArray(cached.rivenWeapons) && cached.rivenWeapons.length > 0 && args.tier !== "reference") {
    return cached;
  }
  const fresh = await client.loadReference();
  await ensureDir(join(args.dataDir, "reference"));
  await writeFile(cachedPath, JSON.stringify(fresh, null, 2));
  if (cached && args.tier === "reference") {
    const changes = diffDispositions(cached.rivenWeapons, fresh.rivenWeapons);
    if (changes.length > 0) await appendEvents(args.dataDir, "disposition", changes);
  }
  return fresh;
}

function diffDispositions(previous: RivenWeapon[], current: RivenWeapon[]): Array<Record<string, unknown>> {
  const priorBySlug = new Map(previous.map((weapon) => [weapon.slug, weapon]));
  const events: Array<Record<string, unknown>> = [];
  const nowIso = new Date().toISOString();
  for (const weapon of current) {
    const prior = priorBySlug.get(weapon.slug);
    if (!prior) continue;
    if (prior.disposition !== weapon.disposition) {
      events.push({
        ts: nowIso,
        source: "reference-diff",
        weapon_slug: weapon.slug,
        weapon_name: weapon.name,
        old_disposition: prior.disposition,
        new_disposition: weapon.disposition,
        delta_pct: weapon.disposition === 0 ? 0 : (weapon.disposition - prior.disposition) / prior.disposition,
      });
    }
  }
  return events;
}

async function appendEvents(dataDir: string, kind: string, events: Array<Record<string, unknown>>): Promise<void> {
  if (events.length === 0) return;
  await ensureDir(join(dataDir, "events"));
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dataDir, "events", `${date}.jsonl`);
  const enriched = events.map((event) => JSON.stringify({ kind, ...event }));
  await appendFile(path, enriched.join("\n") + "\n", "utf8");
}

async function pickTargets(args: Args, weapons: RivenWeapon[], index: IndexFile | null): Promise<{ targets: RivenWeapon[]; nextCursor: number }> {
  if (args.tier === "hot") {
    const previousOpportunities = await readJsonIfExists<Opportunity[]>(join(args.dataDir, "latest", "opportunities.json"));
    const opportunitySlugs = new Set((previousOpportunities ?? []).map((opportunity) => opportunity.weaponSlug));
    const preferred = weapons.filter((weapon) => opportunitySlugs.has(weapon.slug));
    const fillers = weapons
      .filter((weapon) => !opportunitySlugs.has(weapon.slug))
      .sort((a, b) => b.disposition - a.disposition);
    const combined = [...preferred, ...fillers];
    return { targets: combined.slice(0, args.hotSize), nextCursor: index?.tiers.cold?.cursor ?? 0 };
  }
  const cursor = index?.tiers.cold?.cursor ?? 0;
  const start = weapons.length === 0 ? 0 : ((cursor % weapons.length) + weapons.length) % weapons.length;
  const size = Math.min(args.coldSize, weapons.length);
  const targets: RivenWeapon[] = [];
  for (let i = 0; i < size; i += 1) {
    const weapon = weapons[(start + i) % weapons.length];
    if (weapon !== undefined) targets.push(weapon);
  }
  return { targets, nextCursor: weapons.length === 0 ? 0 : (start + size) % weapons.length };
}

async function runInParallel<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function computePriceSample(slug: string, auctions: readonly RivenAuction[], disposition: number | undefined, tsIso: string): Record<string, unknown> {
  const direct = auctions.filter((auction) => auction.visible && !auction.closed && auction.isDirectSell && auction.buyoutPrice > 0);
  const online = direct.filter((auction) => auction.owner.status === "ingame" || auction.owner.status === "online");
  const sortedPrices = direct.map((auction) => auction.buyoutPrice).sort((a, b) => a - b);
  const stats = sortedPrices.length > 0 ? {
    min: sortedPrices[0],
    max: sortedPrices[sortedPrices.length - 1],
    p25: percentile(sortedPrices, 0.25),
    p50: percentile(sortedPrices, 0.5),
    p75: percentile(sortedPrices, 0.75),
    p90: percentile(sortedPrices, 0.9),
  } : null;
  return {
    ts: tsIso,
    weapon_slug: slug,
    listings: auctions.length,
    direct_listings: direct.length,
    online_listings: online.length,
    disposition: disposition ?? null,
    price_stats: stats,
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  const idx = clamped * (sortedValues.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  const lo = sortedValues[lower] ?? 0;
  const hi = sortedValues[upper] ?? lo;
  return lo + (hi - lo) * (idx - lower);
}

function computeSignatureSamples(slug: string, auctions: readonly RivenAuction[], tsIso: string): Array<Record<string, unknown>> {
  return auctions
    .filter((auction) => auction.visible && !auction.closed && auction.isDirectSell && auction.buyoutPrice > 0)
    .map((auction) => ({
      ts: tsIso,
      auction_id: auction.id,
      weapon_slug: slug,
      signature: attributeSignature(auction.attributes),
      buyout_price: auction.buyoutPrice,
    }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  await ensureDir(args.dataDir);
  const cacheDir = process.env.WFM_CACHE_DIR ?? join(args.dataDir, ".wfm-cache");
  const client = new WarframeMarketClient({
    ratePerSecond: args.ratePerSecond,
    burst: args.burst,
    userAgent: args.userAgent,
    cacheDir,
  });
  const reference = await loadOrRefreshReference(args, client);

  if (args.tier === "reference") {
    console.log(`Reference refresh: ${reference.rivenWeapons.length} weapons, ${reference.rivenAttributes.length} attributes.`);
    const referenceIndex: NonNullable<IndexFile["tiers"]["reference"]> = {
      last_run_at: new Date().toISOString(),
      weapons: reference.rivenWeapons.length,
      attributes: reference.rivenAttributes.length,
    };
    if (reference.versions.rivens) referenceIndex.version_hash = reference.versions.rivens;
    await updateIndex(args.dataDir, { reference: referenceIndex });
    return;
  }

  const index = await readJsonIfExists<IndexFile>(join(args.dataDir, "index.json"));
  const { targets, nextCursor } = await pickTargets(args, reference.rivenWeapons, index);

  const auctionsByWeapon = new Map<string, RivenAuction[]>();
  await runInParallel(targets, args.concurrency, async (weapon) => {
    try {
      const auctions = await client.searchRivenAuctions(weapon.slug);
      auctionsByWeapon.set(weapon.slug, auctions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`skip ${weapon.slug}: ${message}`);
    }
  });

  const merged = new Map<string, RivenAuction[]>();
  for (const [slug, entries] of auctionsByWeapon) merged.set(slug, entries);

  const config = normalizeConfig(DEFAULT_CONFIG);
  const analysis = analyzeMarket(reference.rivenWeapons, merged, config);
  const nowIso = new Date().toISOString();
  const status: ScanStatus = {
    initialized: true,
    running: false,
    reason: `ci-${args.tier}`,
    startedAt: nowIso,
    finishedAt: nowIso,
    scannedWeapons: auctionsByWeapon.size,
    totalWeapons: auctionsByWeapon.size,
    lastMessage: `CI ${args.tier} scan wrote ${auctionsByWeapon.size} weapons`,
  };
  const dashboardReference: DashboardState["reference"] = {
    weapons: reference.rivenWeapons.length,
    attributes: reference.rivenAttributes.length,
  };
  if (reference.versionsUpdatedAt) dashboardReference.versionsUpdatedAt = reference.versionsUpdatedAt;
  const state: DashboardState & CiStateExtras = {
    schemaVersion: 1,
    tier: args.tier,
    scannedWeaponSlugs: [...auctionsByWeapon.keys()],
    generatedAt: nowIso,
    refreshMs: 15 * 60_000,
    apiBase: "https://api.warframe.market",
    config,
    status,
    reference: dashboardReference,
    totals: {
      weaponsWithAuctions: merged.size,
      auctions: Array.from(merged.values()).reduce((sum, entries) => sum + entries.length, 0),
      opportunities: analysis.opportunities.length,
    },
    opportunities: analysis.opportunities,
    weaponSummaries: analysis.weaponSummaries,
  };

  await ensureDir(join(args.dataDir, "latest"));
  await writeFile(join(args.dataDir, "latest", "state.json"), JSON.stringify(state, null, 2));
  await writeFile(join(args.dataDir, "latest", "opportunities.json"), JSON.stringify(analysis.opportunities, null, 2));

  await ensureDir(join(args.dataDir, "samples"));
  const dispositionBySlug = new Map(reference.rivenWeapons.map((weapon) => [weapon.slug, weapon.disposition]));
  const samples: string[] = [];
  const signatures: string[] = [];
  for (const [slug, auctions] of auctionsByWeapon) {
    samples.push(JSON.stringify(computePriceSample(slug, auctions, dispositionBySlug.get(slug), nowIso)));
    for (const row of computeSignatureSamples(slug, auctions, nowIso)) signatures.push(JSON.stringify(row));
  }
  if (samples.length > 0) {
    const date = nowIso.slice(0, 10);
    await appendFile(join(args.dataDir, "samples", `${date}.jsonl`), samples.join("\n") + "\n", "utf8");
    await ensureDir(join(args.dataDir, "signatures"));
    if (signatures.length > 0) {
      await appendFile(join(args.dataDir, "signatures", `${date}.jsonl`), signatures.join("\n") + "\n", "utf8");
    }
  }

  const tierIndex = args.tier === "hot"
    ? { hot: { last_run_at: nowIso, scanned_slugs: [...auctionsByWeapon.keys()] } }
    : { cold: { last_run_at: nowIso, cursor: nextCursor, scanned_slugs: [...auctionsByWeapon.keys()] } };
  await updateIndex(args.dataDir, tierIndex);

  console.log(`${args.tier} scan: ${auctionsByWeapon.size} weapons, ${analysis.opportunities.length} opportunities, ${samples.length} price samples appended.`);
}

async function updateIndex(dataDir: string, patch: Partial<IndexFile["tiers"]>): Promise<void> {
  const path = join(dataDir, "index.json");
  const current = (await readJsonIfExists<IndexFile>(path)) ?? { schema_version: 1 as const, updated_at: new Date().toISOString(), tiers: {} };
  const next: IndexFile = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    tiers: { ...current.tiers, ...patch },
  };
  await writeFile(path, JSON.stringify(next, null, 2));
}

main().catch((error) => {
  console.error("scan-and-write failed:", error);
  process.exit(1);
});
