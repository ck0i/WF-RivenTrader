import type { SourceProvenance } from "./product.js";

export const FARMING_TTL_SECONDS = 5 * 60;
export const WORLDSTATE_URL = "https://api.warframestat.us/pc";
export const BROWSEWF_INCURSIONS_URL = "https://browse.wf/sp-incursions.txt";

const MAX_PLAUSIBLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Arbitration node → efficiency tier, published by browse.wf
 * (`supplemental-data/arbyTiers.js`), sourced from the Arbitration Goons
 * community. Nodes without a listed tier are unranked ("F" grade).
 */
export const ARBY_TIER_BY_NODE_KEY: Readonly<Record<string, string>> = Object.freeze({
  SolNode450: "S",
  SolNode106: "S",
  SolNode25: "S",
  SolNode719: "S",
  SolNode64: "S",
  SolNode147: "A",
  SolNode23: "A",
  SolNode172: "A",
  SolNode167: "B",
  ClanNode24: "B",
  SolNode149: "B",
  ClanNode22: "B",
  ClanNode18: "B",
  SolNode164: "B",
  SolNode707: "B",
  SolNode211: "B",
  SolNode42: "B",
  SolNode195: "B",
  SolNode408: "B",
  SolNode402: "B",
  SolNode412: "C",
  ClanNode2: "C",
  SolNode46: "C",
  ClanNode8: "C",
  SolNode212: "C",
  SolNode22: "C",
  SolNode224: "C",
  SolNode26: "C",
  ClanNode6: "C",
  SolNode122: "C",
  SolNode72: "C",
  SolNode130: "D",
  ClanNode15: "D",
  SolNode85: "D",
  SolNode18: "D",
  SolNode305: "D",
  ClanNode4: "D",
  SolNode125: "D",
});

/** Relative material score per arbitration tier, used to rank Endo cards. */
export const ARBY_TIER_MATERIAL: Readonly<Record<string, number>> = Object.freeze({
  S: 1000,
  A: 800,
  B: 600,
  C: 400,
  D: 200,
});

export type FarmingCategory = "kuva" | "endo" | "credits";

/**
 * A single actionable farming opportunity anchored to a currently-active
 * upstream event. Every field either comes from the live payload or is a
 * well-established, non-controversial description of the game feature. We
 * do NOT synthesize EV/min without upstream drop probabilities + a
 * defensible run duration. `source.url` and `expiry` are always cited so a
 * stale card is obvious.
 */
export interface FarmingCard {
  id: string;
  category: FarmingCategory;
  kind: string;
  title: string;
  node?: string | undefined;
  missionType?: string | undefined;
  faction?: string | undefined;
  rewards: string[];
  activation?: string | undefined;
  expiry?: string | undefined;
  eta?: string | undefined;
  tier?: string | undefined;
  /**
   * Best-effort ordering key. Higher = more material for the column's
   * category. Only present when we have a concrete number to sort on
   * (invasion credit payload, alert credits, arbitration tier, etc.);
   * cards without a score fall to the bottom of the column.
   */
  materialScore?: number | undefined;
  warnings: string[];
  source: SourceProvenance;
  detail?: string | undefined;
}

export interface FarmingDashboard {
  generatedAt: string;
  kuva: FarmingCard[];
  endo: FarmingCard[];
  credits: FarmingCard[];
  warnings: string[];
  sources: SourceProvenance[];
}

interface KuvaMission {
  id?: string;
  activation?: string;
  expiry?: string;
  node?: string;
  nodeKey?: string;
  enemy?: string;
  /**
   * WFCD's parser (`lib/models/Kuva.ts`) sets this to the node mission type
   * (Capture, Survival, etc.), NOT the Kuva variant. We cannot use it to
   * distinguish Siphon vs Flood without a second source.
   */
  type?: string;
  missionType?: string;
  archwing?: boolean;
  sharkwing?: boolean;
  eta?: string;
  expired?: boolean;
}

interface Arbitration {
  id?: string;
  node?: string;
  nodeKey?: string;
  activation?: string;
  expiry?: string;
  enemy?: string;
  type?: string;
  archwing?: boolean;
  sharkwing?: boolean;
  expired?: boolean;
}

interface SortieVariant {
  missionType?: string;
  modifier?: string;
  node?: string;
}

interface Sortie {
  id?: string;
  activation?: string;
  expiry?: string;
  rewardPool?: string;
  boss?: string;
  faction?: string;
  variants?: SortieVariant[];
  expired?: boolean;
}

interface ArchonHunt {
  id?: string;
  activation?: string;
  expiry?: string;
  rewardPool?: string;
  boss?: string;
  faction?: string;
  missions?: Array<{ node?: string; type?: string }>;
  expired?: boolean;
}

interface InvasionSideReward {
  items?: Array<{ type?: string; count?: number }>;
  countedItems?: Array<{ type?: string; count?: number }>;
  credits?: number;
}

interface InvasionSide {
  reward?: InvasionSideReward;
  faction?: string;
}

interface Invasion {
  id?: string;
  activation?: string;
  node?: string;
  desc?: string;
  attacker?: InvasionSide;
  defender?: InvasionSide;
  completion?: number;
  completed?: boolean;
  eta?: string;
}

interface DarkSector {
  id?: string;
  node?: string;
  planet?: string;
  factionKey?: string;
  faction?: string;
  defenderName?: string;
  creditsTaxRate?: number;
  memberCreditsTax?: number;
  memberCreditsTaxRate?: number;
}

interface SteelPath {
  currentReward?: { name?: string; cost?: number };
  activation?: string;
  expiry?: string;
  remaining?: string;
  rotation?: Array<{ name?: string; cost?: number }>;
  incursions?: { id?: string; activation?: string; expiry?: string };
}

interface Worldstate {
  timestamp?: string;
  kuva?: KuvaMission[];
  arbitration?: Arbitration;
  sortie?: Sortie;
  archonHunt?: ArchonHunt;
  alerts?: Array<{ id?: string; mission?: { reward?: InvasionSideReward; node?: string; type?: string }; expiry?: string; eta?: string }>;
  invasions?: Invasion[];
  darkSectors?: DarkSector[];
  steelPath?: SteelPath;
}

export interface FarmingContext {
  incursions?: {
    activation: string;
    expiry: string;
    nodeKeys: string[];
    source: SourceProvenance;
  } | null;
}

export async function fetchFarmingDashboard(userAgent: string, fetcher: typeof fetch = fetch, now = new Date()): Promise<FarmingDashboard> {
  const fetchedAt = now.toISOString();
  const warnings: string[] = [];
  const sources: SourceProvenance[] = [];
  const wsSource: SourceProvenance = {
    source: "warframestat",
    url: WORLDSTATE_URL,
    fetchedAt,
    ttlSeconds: FARMING_TTL_SECONDS,
    confidence: "low",
    warnings: [],
  };
  let worldstate: Worldstate | null = null;
  try {
    const response = await fetcher(WORLDSTATE_URL, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
    if (!response.ok) throw new Error(`worldstate ${response.status}`);
    worldstate = (await response.json()) as Worldstate;
    wsSource.confidence = "medium";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Live worldstate unavailable: ${message}`);
    wsSource.warnings.push(message);
  }
  sources.push(wsSource);

  const context: FarmingContext = {};
  const incursionsSource: SourceProvenance = {
    source: "warframestat",
    url: BROWSEWF_INCURSIONS_URL,
    fetchedAt,
    ttlSeconds: FARMING_TTL_SECONDS,
    confidence: "low",
    warnings: [],
  };
  try {
    const response = await fetcher(BROWSEWF_INCURSIONS_URL, { headers: { "User-Agent": userAgent, Accept: "text/plain" } });
    if (!response.ok) throw new Error(`sp-incursions ${response.status}`);
    const text = await response.text();
    const parsed = parseIncursionsForNow(text, now);
    if (parsed) {
      context.incursions = { ...parsed, source: incursionsSource };
      incursionsSource.confidence = "medium";
    } else {
      incursionsSource.warnings.push("no active incursion window in sp-incursions.txt for the current time");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Steel Path incursions unavailable: ${message}`);
    incursionsSource.warnings.push(message);
  }
  sources.push(incursionsSource);

  const kuva = worldstate ? rankFarmingCards(extractKuvaCards(worldstate, wsSource, now)) : [];
  const endo = worldstate ? rankFarmingCards(extractEndoCards(worldstate, wsSource, context, now)) : [];
  const credits = worldstate ? rankFarmingCards(extractCreditCards(worldstate, wsSource, context, now)) : [];
  return { generatedAt: fetchedAt, kuva, endo, credits, warnings, sources };
}

/**
 * The public farming feed shows only the top-N most material cards per
 * category. Callers that need the raw list can hit the extractor functions
 * directly.
 */
export const FARMING_TOP_N = 5;

function rankFarmingCards(cards: FarmingCard[]): FarmingCard[] {
  return [...cards]
    .sort((left, right) => {
      const leftScore = left.materialScore ?? -Infinity;
      const rightScore = right.materialScore ?? -Infinity;
      if (leftScore !== rightScore) return rightScore - leftScore;
      const leftExpiry = left.expiry ? Date.parse(left.expiry) : Number.POSITIVE_INFINITY;
      const rightExpiry = right.expiry ? Date.parse(right.expiry) : Number.POSITIVE_INFINITY;
      return leftExpiry - rightExpiry;
    })
    .slice(0, FARMING_TOP_N);
}

export function extractKuvaCards(worldstate: Worldstate, source: SourceProvenance, now: Date): FarmingCard[] {
  const cards: FarmingCard[] = [];
  const list = Array.isArray(worldstate.kuva) ? worldstate.kuva : [];
  for (const mission of list) {
    if (!isCurrentlyActive(mission.activation, mission.expiry, mission.expired, now)) continue;
    const nodeMissionType = (mission.type ?? mission.missionType ?? "").trim();
    const node = (mission.node ?? "").trim();
    if (!node) continue;
    cards.push({
      id: `kuva-${mission.id ?? `${node}-${mission.expiry}`}`,
      category: "kuva",
      kind: "kuva_mission",
      title: `Kuva mission at ${node}${nodeMissionType ? ` (${nodeMissionType})` : ""}`,
      node,
      missionType: nodeMissionType || undefined,
      faction: mission.enemy,
      rewards: [
        "Kuva payout on mission complete (see wiki for the current Siphon/Flood values — the worldstate payload does not distinguish variants)",
        "Kuva Booster and Squad Kuva Booster multiply the completion reward; Resource Drop Chance mods do not affect it",
      ],
      activation: mission.activation,
      expiry: mission.expiry,
      eta: mission.eta,
      warnings: [],
      source: { ...source },
    });
  }
  return cards;
}

export function extractEndoCards(worldstate: Worldstate, source: SourceProvenance, context: FarmingContext, now: Date): FarmingCard[] {
  const cards: FarmingCard[] = [];
  const arbitration = worldstate.arbitration;
  if (arbitration && isCurrentlyActive(arbitration.activation, arbitration.expiry, arbitration.expired, now)) {
    const missionType = (arbitration.type ?? "").trim();
    const node = (arbitration.node ?? "").trim();
    if (node && missionType.toLowerCase() !== "unknown") {
      const tier = arbitration.nodeKey ? ARBY_TIER_BY_NODE_KEY[arbitration.nodeKey] : undefined;
      const tierScore = tier ? ARBY_TIER_MATERIAL[tier] ?? 100 : 100;
      cards.push({
        id: `arbitration-${arbitration.id ?? `${node}-${arbitration.expiry}`}`,
        category: "endo",
        kind: "arbitration",
        title: `Arbitration · ${missionType} at ${node}`,
        node,
        missionType,
        faction: arbitration.enemy,
        rewards: [
          "Rotation rewards can include Endo caches, Ayatan sculptures, and Vitus Essence (see wiki for current probabilities)",
          "Anasa Ayatan sculpture dissolves for 2,000 Endo empty and 3,450 Endo fully socketed with Ayatan Stars",
        ],
        activation: arbitration.activation,
        expiry: arbitration.expiry,
        tier,
        materialScore: tierScore,
        warnings: tier ? [] : ["Node is unranked in the arbys.txt tier list; efficiency depends on your build."],
        source: { ...source },
        detail: tier ? `Community tier: ${tier} (browse.wf arbyTiers via Arbitration Goons).` : undefined,
      });
    }
  }
  const sortie = worldstate.sortie;
  if (sortie && isCurrentlyActive(sortie.activation, sortie.expiry, sortie.expired, now)) {
    cards.push({
      id: `sortie-${sortie.id ?? sortie.expiry ?? "current"}`,
      category: "endo",
      kind: "sortie",
      title: `Daily Sortie · ${sortie.boss ?? "Boss"} (${sortie.faction ?? "Faction"})`,
      rewards: [
        "Sortie reward pool includes one Endo cache tier and one Ayatan Anasa sculpture among rotating rewards (a single random reward per daily completion)",
      ],
      activation: sortie.activation,
      expiry: sortie.expiry,
      materialScore: 300,
      warnings: [],
      source: { ...source },
      detail: (sortie.variants ?? []).map((variant) => `${variant.missionType ?? "?"} @ ${variant.node ?? "?"}`).join(" · ").trim() || undefined,
    });
  }
  const archon = worldstate.archonHunt;
  if (archon && isCurrentlyActive(archon.activation, archon.expiry, archon.expired, now)) {
    cards.push({
      id: `archon-${archon.id ?? archon.expiry ?? "current"}`,
      category: "endo",
      kind: "archon_hunt",
      title: `Weekly Archon Hunt · ${archon.boss ?? "Archon"} (${archon.faction ?? "Faction"})`,
      rewards: [
        "Weekly completion grants an Archon Shard (Crimson / Amber / Azure, tied to the current Archon)",
        "Additional reward pool contains a mix of Rivens, Kuva, and Endo — see the upstream drop table for current probabilities",
      ],
      activation: archon.activation,
      expiry: archon.expiry,
      materialScore: 500,
      warnings: [],
      source: { ...source },
      detail: (archon.missions ?? []).map((m) => `${m.type ?? "?"} @ ${m.node ?? "?"}`).join(" · ") || undefined,
    });
  }
  const steelPath = worldstate.steelPath;
  const steelRotation = steelPath?.rotation ?? [];
  const endoInRotation = steelRotation.find((entry) => /\bendo\b/i.test(entry.name ?? ""));
  const currentReward = steelPath?.currentReward;
  if (steelPath && isCurrentlyActive(steelPath.activation, steelPath.expiry, undefined, now) && currentReward?.name && /endo/i.test(currentReward.name)) {
    cards.push({
      id: `steel-endo-${steelPath.expiry ?? "current"}`,
      category: "endo",
      kind: "steel_path_teshin",
      title: `Teshin's shop · ${currentReward.name}`,
      rewards: [`${currentReward.name} available for ${currentReward.cost ?? "?"} Steel Essence this rotation`],
      activation: steelPath.activation,
      expiry: steelPath.expiry,
      materialScore: 400,
      warnings: [],
      source: { ...source },
      detail: endoInRotation && endoInRotation.name !== currentReward.name
        ? `Rotation also cycles ${endoInRotation.name} for ${endoInRotation.cost} SE.`
        : undefined,
    });
  }
  const incursions = context.incursions;
  if (incursions && incursions.nodeKeys.length > 0) {
    cards.push({
      id: `sp-incursions-endo-${incursions.expiry}`,
      category: "endo",
      kind: "steel_path_incursions",
      title: "Steel Path Daily Incursions · Steel Essence",
      rewards: [
        `${incursions.nodeKeys.length} daily incursions each grant Steel Essence on first completion`,
        "Steel Essence trades to Teshin's shop (Umbra Forma, Rifle/Shotgun/Zaw/Kitgun Rivens, 30k Endo, 50k Kuva rotations)",
      ],
      activation: incursions.activation,
      expiry: incursions.expiry,
      materialScore: 600,
      warnings: [],
      source: { ...incursions.source },
      detail: `Incursion nodes today: ${incursions.nodeKeys.join(", ")}`,
    });
  }
  return cards;
}

export function extractCreditCards(worldstate: Worldstate, source: SourceProvenance, context: FarmingContext, now: Date): FarmingCard[] {
  const cards: FarmingCard[] = [];
  const invasions = Array.isArray(worldstate.invasions) ? worldstate.invasions : [];
  for (const invasion of invasions) {
    if (invasion.completed === true) continue;
    if (Math.abs(invasion.completion ?? 0) >= 100) continue;
    const node = (invasion.node ?? "").trim();
    if (!node) continue;
    const credits = Math.max(invasion.attacker?.reward?.credits ?? 0, invasion.defender?.reward?.credits ?? 0);
    const attackerCounted = (invasion.attacker?.reward?.countedItems ?? [])
      .filter((entry) => entry?.type)
      .map((entry) => `${entry?.count ?? 1} × ${entry?.type}`)
      .join(", ");
    const defenderCounted = (invasion.defender?.reward?.countedItems ?? [])
      .filter((entry) => entry?.type)
      .map((entry) => `${entry?.count ?? 1} × ${entry?.type}`)
      .join(", ");
    const rewards: string[] = [];
    if (credits > 0) rewards.push(`${credits.toLocaleString("en-US")} credit battle-pay after 3 successful runs on the chosen side`);
    if (attackerCounted) rewards.push(`Attacker side battle-pay after 3 wins: ${attackerCounted}`);
    if (defenderCounted) rewards.push(`Defender side battle-pay after 3 wins: ${defenderCounted}`);
    if (credits <= 0) continue;
    cards.push({
      id: `invasion-${invasion.id ?? node}`,
      category: "credits",
      kind: "invasion",
      title: `${invasion.desc ?? "Invasion"} · ${node}`,
      node,
      rewards,
      activation: invasion.activation,
      eta: invasion.eta,
      warnings: [],
      source: { ...source },
      materialScore: credits > 0 ? credits : undefined,
      detail: "Battle-pay is delivered by inbox after 3 wins on the chosen side. Use the ETA to pick invasions that will still be up when you queue.",
    });
  }
  const sortie = worldstate.sortie;
  if (sortie && isCurrentlyActive(sortie.activation, sortie.expiry, sortie.expired, now)) {
    cards.push({
      id: `sortie-credits-${sortie.id ?? sortie.expiry ?? "current"}`,
      category: "credits",
      kind: "sortie",
      title: `Daily Sortie · ${sortie.boss ?? "Boss"} (${sortie.faction ?? "Faction"})`,
      rewards: [
        "Stage credit rewards: 20,000 (stage 1) + 30,000 (stage 2) + 50,000 (stage 3) = 100,000 guaranteed credits over the three stages",
      ],
      activation: sortie.activation,
      expiry: sortie.expiry,
      materialScore: 100000,
      warnings: [],
      source: { ...source },
      detail: (sortie.variants ?? []).map((variant) => `${variant.missionType ?? "?"} @ ${variant.node ?? "?"}`).join(" · ").trim() || undefined,
    });
  }
  const alerts = Array.isArray(worldstate.alerts) ? worldstate.alerts : [];
  for (const alert of alerts) {
    const credits = alert.mission?.reward?.credits ?? 0;
    if (!credits || credits <= 0) continue;
    cards.push({
      id: `alert-${alert.id ?? alert.expiry ?? "current"}`,
      category: "credits",
      kind: "alert",
      title: `Alert · ${alert.mission?.node ?? "Node"}`,
      node: alert.mission?.node,
      missionType: alert.mission?.type,
      rewards: [`${credits.toLocaleString("en-US")} credits on completion`],
      expiry: alert.expiry,
      eta: alert.eta,
      warnings: [],
      source: { ...source },
      materialScore: credits,
    });
  }
  const darkSectors = Array.isArray(worldstate.darkSectors) ? worldstate.darkSectors : [];
  const highYieldSectors = darkSectors
    .filter((sector) => (sector.creditsTaxRate ?? 0) === 0 || (sector.memberCreditsTaxRate ?? 0) === 0)
    .slice(0, 4);
  for (const sector of highYieldSectors) {
    if (!sector.node) continue;
    cards.push({
      id: `darksector-${sector.id ?? sector.node}`,
      category: "credits",
      kind: "dark_sector",
      title: `Dark Sector · ${sector.node}`,
      node: sector.node,
      faction: sector.faction,
      rewards: [
        "Dark sector missions apply a rail-owner credit bonus on top of the base mission credit reward (rate is set by the controlling clan)",
      ],
      warnings: [],
      source: { ...source },
      materialScore: 1,
      detail: sector.defenderName ? `Rail controlled by ${sector.defenderName}.` : undefined,
    });
  }
  const incursions = context.incursions;
  if (incursions && incursions.nodeKeys.length > 0) {
    cards.push({
      id: `sp-incursions-credits-${incursions.expiry}`,
      category: "credits",
      kind: "steel_path_incursions",
      title: "Steel Path Daily Incursions · Steel Essence → Credits",
      rewards: [
        `${incursions.nodeKeys.length} daily incursions each grant Steel Essence on first completion`,
        "Steel Essence rotates to a large Credit cache stall in Teshin's shop (check the current Steel Path shop rotation)",
      ],
      activation: incursions.activation,
      expiry: incursions.expiry,
      materialScore: 30000,
      warnings: [],
      source: { ...incursions.source },
    });
  }
  return cards;
}

/**
 * Parse the `browse.wf/sp-incursions.txt` schedule and return the row that
 * covers `now`. Each row is `<epoch_seconds>;<node_key>,...` where the epoch
 * is the START of the 24-hour incursion window (UTC).
 */
export function parseIncursionsForNow(text: string, now: Date): { activation: string; expiry: string; nodeKeys: string[] } | null {
  const nowMs = now.getTime();
  const lines = text.split(/\r?\n/);
  let match: { epochMs: number; nodeKeys: string[] } | null = null;
  for (const line of lines) {
    if (!line) continue;
    const [epochRaw, nodesRaw] = line.split(";");
    const epochSeconds = Number(epochRaw);
    if (!Number.isFinite(epochSeconds)) continue;
    const epochMs = epochSeconds * 1000;
    if (epochMs > nowMs) continue;
    const nodeKeys = (nodesRaw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    if (nodeKeys.length === 0) continue;
    match = { epochMs, nodeKeys };
  }
  if (!match) return null;
  const activation = new Date(match.epochMs);
  const expiry = new Date(match.epochMs + 24 * 60 * 60 * 1000);
  if (expiry.getTime() <= nowMs) return null;
  return {
    activation: activation.toISOString(),
    expiry: expiry.toISOString(),
    nodeKeys: match.nodeKeys,
  };
}

function isCurrentlyActive(activation: string | undefined, expiry: string | undefined, expired: boolean | undefined, now: Date): boolean {
  if (expired === true) return false;
  const nowMs = now.getTime();
  const activationMs = Date.parse(activation ?? "");
  const expiryMs = Date.parse(expiry ?? "");
  if (Number.isFinite(activationMs) && activationMs > nowMs + 60_000) return false;
  if (!Number.isFinite(expiryMs)) return false;
  if (expiryMs <= nowMs) return false;
  // Guard against nonsense expiries (e.g. year 275760) that mean "no upstream schedule set".
  if (expiryMs - nowMs > MAX_PLAUSIBLE_EXPIRY_MS) return false;
  return true;
}
