import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PriceHistoryStore } from "../src/wfm/history.js";
import type { AuctionAttribute, RivenAuction, SellerStatus } from "../src/wfm/types.js";

function makeAuction(id: string, price: number, status: SellerStatus, attrs: AuctionAttribute[], patch: Partial<RivenAuction> = {}): RivenAuction {
  return {
    id,
    weaponSlug: "war",
    name: id,
    buyoutPrice: price,
    startingPrice: price,
    topBid: null,
    isDirectSell: true,
    visible: true,
    closed: false,
    platform: "pc",
    crossplay: true,
    created: "2026-07-01T00:00:00.000Z",
    updated: "2026-07-03T00:00:00.000Z",
    owner: {
      id: `${id}-owner`,
      ingameName: `${id}-seller`,
      slug: `${id}-seller`,
      reputation: 10,
      status,
      platform: "pc",
      crossplay: true,
    },
    masteryLevel: 16,
    modRank: 0,
    reRolls: 0,
    polarity: "madurai",
    attributes: attrs,
    noteRaw: "",
    ...patch,
  };
}

const attrs: AuctionAttribute[] = [
  { urlName: "critical_chance", value: 120, positive: true },
  { urlName: "critical_damage", value: 90, positive: true },
  { urlName: "zoom", value: -30, positive: false },
];

const tempDir = await mkdtemp(join(tmpdir(), "wf-riventrader-history-"));
try {
  const dbPath = join(tempDir, "history.db");
  const store = new PriceHistoryStore(dbPath);
  const t0 = 1_800_000_000;

  const firstAuctions = [
    makeAuction("a-1", 100, "ingame", attrs),
    makeAuction("a-2", 150, "online", attrs),
    makeAuction("a-3", 200, "online", attrs),
    makeAuction("a-4", 300, "online", attrs),
  ];
  store.writeScan({
    tsSeconds: t0,
    scannedSlugs: ["war"],
    auctionsByWeapon: new Map([["war", firstAuctions]]),
    dispositionBySlug: new Map([["war", 0.9]]),
  });

  const priceRow = store.recentPriceSamples(t0 - 1, "war")[0];
  assert(priceRow, "first scan should produce a price_samples row");
  assert.equal(priceRow.direct_listings, 4);
  assert.equal(priceRow.min, 100);
  assert.equal(priceRow.max, 300);
  assert.equal(priceRow.disposition, 0.9);

  const warmA = store.warmStart();
  assert.equal(warmA.restoredWeaponCount, 1);
  const restoredFirst = warmA.auctionsByWeapon.get("war");
  assert(restoredFirst, "warmStart must restore war auctions");
  assert.equal(restoredFirst.length, 4);
  assert.equal(restoredFirst[0]?.id, "a-1");

  const secondAuctions = [
    makeAuction("a-1", 90, "ingame", attrs),
    makeAuction("a-2", 150, "online", attrs),
    makeAuction("a-3", 200, "online", attrs),
    makeAuction("a-5", 250, "online", attrs),
  ];
  const t1 = t0 + 300;
  store.writeScan({
    tsSeconds: t1,
    scannedSlugs: ["war"],
    auctionsByWeapon: new Map([["war", secondAuctions]]),
    dispositionBySlug: new Map([["war", 0.9]]),
  });

  const samples = store.recentPriceSamples(t0 - 1, "war");
  assert.equal(samples.length, 2, "second scan should append a price_samples row");

  const rawDb = (store as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).db;
  const eventRows = rawDb.prepare("SELECT auction_id, first_price, last_price, first_seen, last_seen, closed_at FROM auction_events ORDER BY auction_id").all() as Array<{
    auction_id: string; first_price: number; last_price: number; first_seen: number; last_seen: number; closed_at: number | null;
  }>;
  const eventsByAuction = new Map(eventRows.map((row) => [row.auction_id, row]));

  const a1 = eventsByAuction.get("a-1");
  assert(a1, "a-1 event missing");
  assert.equal(a1.first_price, 100, "a-1 first_price frozen");
  assert.equal(a1.last_price, 90, "a-1 last_price updated");
  assert.equal(a1.first_seen, t0, "a-1 first_seen frozen");
  assert.equal(a1.last_seen, t1, "a-1 last_seen updated");
  assert.equal(a1.closed_at, null, "a-1 still open");

  const a4 = eventsByAuction.get("a-4");
  assert(a4, "a-4 event missing");
  assert.equal(a4.closed_at, t1, "a-4 vanished from second scan → closed_at set");

  const a5 = eventsByAuction.get("a-5");
  assert(a5, "a-5 event missing");
  assert.equal(a5.first_seen, t1, "a-5 first_seen = second scan ts");
  assert.equal(a5.closed_at, null, "a-5 still open");

  const sigSamples = rawDb.prepare("SELECT auction_id, ts, buyout_price FROM signature_samples ORDER BY auction_id, ts").all() as Array<{
    auction_id: string; ts: number; buyout_price: number;
  }>;
  const a1Samples = sigSamples.filter((row) => row.auction_id === "a-1");
  assert.equal(a1Samples.length, 2, "a-1 price changed → two signature samples");
  assert.deepEqual(a1Samples.map((row) => row.buyout_price), [100, 90]);

  const a2Samples = sigSamples.filter((row) => row.auction_id === "a-2");
  assert.equal(a2Samples.length, 1, "a-2 unchanged price → single signature sample");

  const signature = "+critical_chance+critical_damage|-zoom";
  const valuation = store.signatureValuation("war", signature, 30);
  assert(valuation.sample_count >= 4, "signatureValuation must count both scans across shared auctions");
  assert(valuation.p25 !== null && valuation.p50 !== null, "signatureValuation must produce percentiles");
  assert(valuation.confidence > 0, "confidence must be > 0 with samples present");

  const velocity = store.signatureVelocity("war", signature, 30);
  assert.equal(velocity.observed_listings, 5, "one vanished auction + four still-open = 5 observed");
  assert.equal(velocity.vanished_listings, 1, "a-4 vanished between scans");

  const zeroValuation = store.signatureValuation("war", "+nothing|", 30);
  assert.equal(zeroValuation.sample_count, 0);
  assert.equal(zeroValuation.confidence, 0);

  store.close();

  const reopen = new PriceHistoryStore(dbPath);
  const warmB = reopen.warmStart();
  assert.equal(warmB.restoredWeaponCount, 1, "reopened store must reproduce warm-start state");
  const restoredSecond = warmB.auctionsByWeapon.get("war");
  assert(restoredSecond, "war auctions must restore from persisted snapshot");
  assert.equal(restoredSecond.length, 4);
  assert(restoredSecond.some((auction) => auction.id === "a-5"), "warm-start reflects latest scan");
  reopen.close();

  console.log("history persistence tests passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
