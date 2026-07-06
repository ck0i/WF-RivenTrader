import assert from "node:assert/strict";
import {
  computeMeta,
  enrichOpportunity,
  ENVELOPE_VERSION,
  markEnvelopeInvalid,
  outputSchemas,
  toEnvelope,
  validateEnvelope,
} from "../src/mcp/schemas.js";
import type { Opportunity } from "../src/wfm/types.js";

const nowIso = "2026-07-04T20:00:00.000Z";
const nowMs = Date.parse(nowIso);

const fresh = computeMeta({
  generated_at: nowIso,
  data_source: "live",
  freshness_ms: 30_000,
  scanned: 40,
  total: 40,
  scan_running: false,
});
assert.equal(fresh.quality, "green");
assert.equal(fresh.warnings.length, 0);
assert.equal(fresh.coverage.pct, 1);

const partial = computeMeta({
  generated_at: nowIso,
  data_source: "live",
  freshness_ms: 30_000,
  scanned: 20,
  total: 40,
  scan_running: false,
});
assert.equal(partial.quality, "red", "coverage < 60% with no scan running must be red");
assert(partial.warnings.some((warning) => warning.code === "partial_scan"), "partial_scan warning missing");

const stale = computeMeta({
  generated_at: nowIso,
  data_source: "cache",
  freshness_ms: 45 * 60_000,
  scanned: 40,
  total: 40,
  scan_running: false,
});
assert.equal(stale.quality, "red");
assert(stale.warnings.some((warning) => warning.code === "stale_data"), "stale_data warning missing");

const running = computeMeta({
  generated_at: nowIso,
  data_source: "live",
  freshness_ms: 10 * 60_000,
  scanned: 5,
  total: 40,
  scan_running: true,
});
assert.equal(running.quality, "yellow", "scan running with mid-freshness should be yellow, not red");

const envelope = toEnvelope({ ok: true }, fresh);
assert.equal(envelope.version, ENVELOPE_VERSION);
const validated = validateEnvelope(envelope);
assert(validated.ok, "well-formed envelope must validate");

const bad = { version: "the-plat-exchange/1" as const, data: {}, meta: { ...fresh, quality: "purple" as unknown as "red" } };
const badResult = validateEnvelope(bad);
assert(!badResult.ok, "invalid quality must fail validation");

const flagged = markEnvelopeInvalid(envelope, "test failure");
assert.equal(flagged.meta.quality, "red");
assert(flagged.meta.warnings.some((warning) => warning.code === "validation_failed"), "validation_failed warning missing");

const opportunity: Opportunity = {
  auctionId: "test-1",
  weaponSlug: "war",
  weaponName: "War",
  rivenName: "War test",
  buyPrice: 100,
  targetSellPrice: 200,
  conservativeSellPrice: 150,
  expectedProfit: 100,
  roi: 1,
  buyToSellRatio: 2,
  confidence: 0.9,
  score: 80,
  seller: { id: "s1", ingameName: "seller-1", slug: "seller-1", reputation: 2, status: "ingame", platform: "pc", crossplay: true },
  status: "ingame",
  groupType: "exact-stats",
  comparableListings: 4,
  pricePercentile: 0.1,
  signature: "+cc+cd|-zoom",
  positives: ["critical_chance", "critical_damage"],
  negatives: ["zoom"],
  reasons: [],
  updated: new Date(nowMs - 5000).toISOString(),
  url: "https://warframe.market/auctions",
};
const enriched = enrichOpportunity(opportunity, nowMs);
assert.equal(enriched.quality.tier, "C", "confidence 0.9 with 4 comparables sits in the C bucket per deriveTier");
assert(enriched.quality.signals.includes("low_comparables"), "signals must flag low_comparables at 4");
assert(enriched.quality.signals.includes("new_seller"), "signals must flag new_seller at reputation 2");
assert(enriched.quality.data_age_seconds >= 5, "data_age_seconds should reflect updated timestamp");

const outSchemaKeys = Object.keys(outputSchemas);
assert.deepEqual(outSchemaKeys.sort(), ["action", "arcaneDetail", "arcaneDissolveRecommendations", "arcaneMarket", "arcanePacks", "health", "instantWins", "opportunities", "signatureValue", "snapshot"]);

console.log("envelope + meta + opportunity enrichment tests passed");
