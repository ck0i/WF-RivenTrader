import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { attributeSignature } from "./opportunities.js";
import type { RivenAuction, RivenWeapon } from "./types.js";

export interface SignatureValuation {
  weapon_slug: string;
  signature: string;
  window_days: number;
  sample_count: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  last_seen_price: number | null;
  last_seen_at: number | null;
  confidence: number;
}

export interface SignatureVelocity {
  weapon_slug: string;
  signature: string;
  observed_listings: number;
  vanished_listings: number;
  vanish_rate: number;
  avg_time_on_market_days: number | null;
  classification: "fast_moving" | "stuck" | "unknown";
}

export interface PriceSampleRow {
  weapon_slug: string;
  ts: number;
  listings: number;
  direct_listings: number;
  online_listings: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  disposition: number | null;
}

export interface ScanWriteInput {
  tsSeconds: number;
  scannedSlugs: Iterable<string>;
  auctionsByWeapon: ReadonlyMap<string, readonly RivenAuction[]>;
  dispositionBySlug: ReadonlyMap<string, number>;
}

export interface WarmStartSnapshot {
  auctionsByWeapon: Map<string, RivenAuction[]>;
  scannedAtByWeapon: Map<string, string>;
  latestSnapshotTs: number | null;
  restoredWeaponCount: number;
}

interface AuctionEventRow {
  auction_id: string;
  last_price: number;
}

interface WeaponSnapshotRow {
  weapon_slug: string;
  ts: number;
  auctions_json: string;
}

export class PriceHistoryStore {
  private readonly db: DatabaseSync;
  private readonly insertPriceSample: StatementSync;
  private readonly upsertSnapshot: StatementSync;
  private readonly getAuctionEvent: StatementSync;
  private readonly insertAuctionEvent: StatementSync;
  private readonly touchAuctionEvent: StatementSync;
  private readonly updateAuctionEventPrice: StatementSync;
  private readonly insertSignatureSample: StatementSync;
  private readonly closeVanished: StatementSync;
  private readonly selectSnapshots: StatementSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = OFF;

      CREATE TABLE IF NOT EXISTS price_samples (
        weapon_slug TEXT NOT NULL,
        ts INTEGER NOT NULL,
        listings INTEGER NOT NULL,
        direct_listings INTEGER NOT NULL,
        online_listings INTEGER NOT NULL,
        p25 REAL, p50 REAL, p75 REAL, p90 REAL, min REAL, max REAL,
        disposition REAL,
        PRIMARY KEY (weapon_slug, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_price_samples_ts ON price_samples(ts);

      CREATE TABLE IF NOT EXISTS auction_events (
        auction_id TEXT PRIMARY KEY,
        weapon_slug TEXT NOT NULL,
        signature TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        closed_at INTEGER,
        first_price REAL NOT NULL,
        last_price REAL NOT NULL,
        seller_slug TEXT,
        seller_status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auction_events_weapon ON auction_events(weapon_slug, last_seen);
      CREATE INDEX IF NOT EXISTS idx_auction_events_sig ON auction_events(weapon_slug, signature, closed_at);

      CREATE TABLE IF NOT EXISTS signature_samples (
        auction_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        weapon_slug TEXT NOT NULL,
        signature TEXT NOT NULL,
        buyout_price REAL NOT NULL,
        PRIMARY KEY (auction_id, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_sig_samples_lookup ON signature_samples(weapon_slug, signature, ts);

      CREATE TABLE IF NOT EXISTS weapon_snapshots (
        weapon_slug TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        auctions_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS disposition_changes (
        ts INTEGER NOT NULL,
        weapon_slug TEXT NOT NULL,
        old_dispo REAL,
        new_dispo REAL,
        PRIMARY KEY (ts, weapon_slug)
      );
    `);

    this.insertPriceSample = this.db.prepare(`
      INSERT OR REPLACE INTO price_samples
        (weapon_slug, ts, listings, direct_listings, online_listings, p25, p50, p75, p90, min, max, disposition)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertSnapshot = this.db.prepare(`
      INSERT INTO weapon_snapshots (weapon_slug, ts, auctions_json) VALUES (?, ?, ?)
      ON CONFLICT(weapon_slug) DO UPDATE SET ts = excluded.ts, auctions_json = excluded.auctions_json
    `);
    this.getAuctionEvent = this.db.prepare(`SELECT auction_id, last_price FROM auction_events WHERE auction_id = ?`);
    this.insertAuctionEvent = this.db.prepare(`
      INSERT INTO auction_events (auction_id, weapon_slug, signature, first_seen, last_seen, first_price, last_price, seller_slug, seller_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.touchAuctionEvent = this.db.prepare(`
      UPDATE auction_events SET last_seen = ?, seller_status = ?, closed_at = NULL WHERE auction_id = ?
    `);
    this.updateAuctionEventPrice = this.db.prepare(`
      UPDATE auction_events SET last_seen = ?, last_price = ?, seller_status = ?, closed_at = NULL WHERE auction_id = ?
    `);
    this.insertSignatureSample = this.db.prepare(`
      INSERT OR REPLACE INTO signature_samples (auction_id, ts, weapon_slug, signature, buyout_price)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.closeVanished = this.db.prepare(`
      UPDATE auction_events SET closed_at = ? WHERE weapon_slug = ? AND closed_at IS NULL AND last_seen < ?
    `);
    this.selectSnapshots = this.db.prepare(`SELECT weapon_slug, ts, auctions_json FROM weapon_snapshots`);
  }

  writeScan(input: ScanWriteInput): void {
    const scannedSlugs = new Set(input.scannedSlugs);
    if (scannedSlugs.size === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const slug of scannedSlugs) {
        const auctions = input.auctionsByWeapon.get(slug) ?? [];
        this.writeWeapon(slug, auctions, input.tsSeconds, input.dispositionBySlug.get(slug));
        this.closeVanished.run(input.tsSeconds, slug, input.tsSeconds);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private writeWeapon(slug: string, auctions: readonly RivenAuction[], ts: number, disposition: number | undefined): void {
    const directPrices = auctions
      .filter((auction) => auction.visible && !auction.closed && auction.isDirectSell && auction.buyoutPrice > 0)
      .map((auction) => auction.buyoutPrice)
      .sort((a, b) => a - b);
    const directListings = directPrices.length;
    const onlineListings = auctions.filter((auction) =>
      auction.visible && !auction.closed && auction.isDirectSell && (auction.owner.status === "ingame" || auction.owner.status === "online"),
    ).length;
    const stats = directListings > 0 ? percentileStats(directPrices) : null;
    this.insertPriceSample.run(
      slug,
      ts,
      auctions.length,
      directListings,
      onlineListings,
      stats?.p25 ?? null,
      stats?.p50 ?? null,
      stats?.p75 ?? null,
      stats?.p90 ?? null,
      stats?.min ?? null,
      stats?.max ?? null,
      disposition ?? null,
    );

    this.upsertSnapshot.run(slug, ts, JSON.stringify(auctions));

    for (const auction of auctions) {
      const signature = attributeSignature(auction.attributes);
      const existing = this.getAuctionEvent.get(auction.id) as unknown as AuctionEventRow | undefined;
      if (existing) {
        if (existing.last_price !== auction.buyoutPrice) {
          this.updateAuctionEventPrice.run(ts, auction.buyoutPrice, auction.owner.status, auction.id);
          this.insertSignatureSample.run(auction.id, ts, slug, signature, auction.buyoutPrice);
        } else {
          this.touchAuctionEvent.run(ts, auction.owner.status, auction.id);
        }
      } else {
        this.insertAuctionEvent.run(auction.id, slug, signature, ts, ts, auction.buyoutPrice, auction.buyoutPrice, auction.owner.slug, auction.owner.status);
        this.insertSignatureSample.run(auction.id, ts, slug, signature, auction.buyoutPrice);
      }
    }
  }

  warmStart(): WarmStartSnapshot {
    const rows = this.selectSnapshots.all() as unknown as WeaponSnapshotRow[];
    const auctionsByWeapon = new Map<string, RivenAuction[]>();
    const scannedAtByWeapon = new Map<string, string>();
    let latest: number | null = null;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.auctions_json) as RivenAuction[];
        if (!Array.isArray(parsed)) continue;
        auctionsByWeapon.set(row.weapon_slug, parsed);
        scannedAtByWeapon.set(row.weapon_slug, new Date(row.ts * 1000).toISOString());
        if (latest === null || row.ts > latest) latest = row.ts;
      } catch {
        continue;
      }
    }
    return {
      auctionsByWeapon,
      scannedAtByWeapon,
      latestSnapshotTs: latest,
      restoredWeaponCount: auctionsByWeapon.size,
    };
  }

  recordDispositionChanges(tsSeconds: number, changes: Array<{ weaponSlug: string; oldDispo: number | null; newDispo: number }>): void {
    if (changes.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO disposition_changes (ts, weapon_slug, old_dispo, new_dispo) VALUES (?, ?, ?, ?)
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const change of changes) stmt.run(tsSeconds, change.weaponSlug, change.oldDispo, change.newDispo);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recentPriceSamples(sinceTsSeconds: number, weaponSlug?: string): PriceSampleRow[] {
    if (weaponSlug !== undefined) {
      const stmt = this.db.prepare(`SELECT * FROM price_samples WHERE weapon_slug = ? AND ts >= ? ORDER BY ts ASC`);
      return stmt.all(weaponSlug, sinceTsSeconds) as unknown as PriceSampleRow[];
    }
    const stmt = this.db.prepare(`SELECT * FROM price_samples WHERE ts >= ? ORDER BY ts ASC`);
    return stmt.all(sinceTsSeconds) as unknown as PriceSampleRow[];
  }

  signatureValuation(weaponSlug: string, signature: string, windowDays: number = 30): SignatureValuation {
    const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
    const rows = this.db.prepare(`
      SELECT buyout_price, ts FROM signature_samples
      WHERE weapon_slug = ? AND signature = ? AND ts >= ?
      ORDER BY ts ASC
    `).all(weaponSlug, signature, since) as unknown as Array<{ buyout_price: number; ts: number }>;
    if (rows.length === 0) {
      return {
        weapon_slug: weaponSlug,
        signature,
        window_days: windowDays,
        sample_count: 0,
        p25: null, p50: null, p75: null, p90: null, min: null, max: null,
        last_seen_price: null, last_seen_at: null,
        confidence: 0,
      };
    }
    const sorted = [...rows].map((row) => row.buyout_price).sort((a, b) => a - b);
    const last = rows[rows.length - 1] ?? null;
    return {
      weapon_slug: weaponSlug,
      signature,
      window_days: windowDays,
      sample_count: rows.length,
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.9),
      min: sorted[0] ?? null,
      max: sorted[sorted.length - 1] ?? null,
      last_seen_price: last?.buyout_price ?? null,
      last_seen_at: last?.ts ?? null,
      confidence: 1 - Math.exp(-rows.length / 10),
    };
  }

  signatureVelocity(weaponSlug: string, signature: string, windowDays: number = 30): SignatureVelocity {
    const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS observed,
        SUM(CASE WHEN closed_at IS NOT NULL THEN 1 ELSE 0 END) AS vanished,
        AVG(CASE WHEN closed_at IS NOT NULL THEN closed_at - first_seen END) AS avg_ttm_seconds
      FROM auction_events
      WHERE weapon_slug = ? AND signature = ? AND first_seen >= ?
    `).get(weaponSlug, signature, since) as { observed: number; vanished: number; avg_ttm_seconds: number | null } | undefined;
    const observed = row?.observed ?? 0;
    const vanished = row?.vanished ?? 0;
    const vanishRate = observed > 0 ? vanished / observed : 0;
    const avgTtmDays = row?.avg_ttm_seconds !== null && row?.avg_ttm_seconds !== undefined ? row.avg_ttm_seconds / 86400 : null;
    let classification: SignatureVelocity["classification"] = "unknown";
    if (observed >= 8 && vanishRate >= 0.5 && avgTtmDays !== null && avgTtmDays < 3) classification = "fast_moving";
    else if (observed >= 10 && vanishRate < 0.2) classification = "stuck";
    return {
      weapon_slug: weaponSlug,
      signature,
      observed_listings: observed,
      vanished_listings: vanished,
      vanish_rate: vanishRate,
      avg_time_on_market_days: avgTtmDays,
      classification,
    };
  }

  recentDispositionChanges(sinceTsSeconds: number): Array<{ weapon_slug: string; delta: number }> {
    const stmt = this.db.prepare(`
      WITH ranked AS (
        SELECT weapon_slug, disposition, ts,
               LAG(disposition) OVER (PARTITION BY weapon_slug ORDER BY ts) AS prev_dispo
        FROM price_samples
        WHERE disposition IS NOT NULL
      )
      SELECT weapon_slug, MAX(disposition - prev_dispo) AS delta
      FROM ranked
      WHERE prev_dispo IS NOT NULL AND disposition != prev_dispo AND ts >= ?
      GROUP BY weapon_slug
    `);
    return stmt.all(sinceTsSeconds) as unknown as Array<{ weapon_slug: string; delta: number }>;
  }

  close(): void {
    this.db.close();
  }
}

interface Percentiles {
  min: number; max: number; p25: number; p50: number; p75: number; p90: number;
}

function percentileStats(sortedPrices: readonly number[]): Percentiles {
  return {
    min: sortedPrices[0] ?? 0,
    max: sortedPrices[sortedPrices.length - 1] ?? 0,
    p25: percentile(sortedPrices, 0.25),
    p50: percentile(sortedPrices, 0.5),
    p75: percentile(sortedPrices, 0.75),
    p90: percentile(sortedPrices, 0.9),
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  const index = clamped * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sortedValues[lower] ?? 0;
  const upperValue = sortedValues[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}
