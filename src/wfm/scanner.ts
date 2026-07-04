import { WarframeMarketClient } from "./client.js";
import type { PriceHistoryStore, SignatureValuation as SignatureValuationResult, SignatureVelocity as SignatureVelocityResult } from "./history.js";
import { analyzeMarket, DEFAULT_CONFIG, normalizeConfig, slugify, type MarketAnalysis } from "./opportunities.js";
import type { DashboardState, ReferenceSnapshot, RivenAuction, RivenWeapon, ScanStatus, TraderConfig } from "./types.js";

export type ScanTier = "hot" | "cold" | "full";
export type ScanMode = "tiered" | "full" | "remote";

export interface ScannerOptions {
  client: WarframeMarketClient;
  config?: Partial<TraderConfig>;
  refreshMs?: number;
  concurrency?: number;
  weaponLimit?: number | null;
  scanMode?: ScanMode;
  hotSize?: number;
  coldSliceSize?: number;
  hotIntervalMs?: number;
  coldIntervalMs?: number;
  emitDebounceMs?: number;
  history?: PriceHistoryStore;
  remoteDataUrl?: string;
  remotePollMs?: number;
}

type StateListener = (state: DashboardState) => void;

const HOT_SCORE_MIN_HOURS_BETWEEN_RESCANS = 3;

export class RivenTraderService {
  private readonly client: WarframeMarketClient;
  private readonly history: PriceHistoryStore | undefined;
  private readonly listeners = new Set<StateListener>();
  private readonly auctionsByWeapon = new Map<string, RivenAuction[]>();
  private readonly scannedAtByWeapon = new Map<string, string>();
  private reference: ReferenceSnapshot | null = null;
  private config: TraderConfig;
  private timers: NodeJS.Timeout[] = [];
  private emitTimer: NodeJS.Timeout | undefined;
  private activeRefresh: Promise<void> | null = null;
  private cachedAnalysis: { key: string; analysis: MarketAnalysis } | null = null;
  private auctionsRevision = 0;
  private configRevision = 0;
  private coldCursor = 0;
  private status: ScanStatus = {
    initialized: false,
    running: false,
    reason: "startup",
    scannedWeapons: 0,
    totalWeapons: 0,
    lastMessage: "Waiting for launch",
  };

  readonly refreshMs: number;
  readonly concurrency: number;
  readonly weaponLimit: number | null;
  private mode: ScanMode;
  readonly hotSize: number;
  readonly coldSliceSize: number;
  readonly hotIntervalMs: number;
  readonly coldIntervalMs: number;
  readonly emitDebounceMs: number;
  readonly remoteDataUrl: string | undefined;
  readonly remotePollMs: number;
  private remoteState: DashboardState | null = null;
  private lastRemoteFetchAt = 0;
  private scanGeneration = 0;

  constructor(options: ScannerOptions) {
    this.client = options.client;
    this.history = options.history;
    this.config = normalizeConfig(options.config ?? DEFAULT_CONFIG);
    this.refreshMs = Math.max(60_000, options.refreshMs ?? 60_000);
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    this.weaponLimit = options.weaponLimit === undefined ? null : options.weaponLimit;
    this.mode = options.scanMode ?? "tiered";
    this.hotSize = Math.max(1, Math.floor(options.hotSize ?? 40));
    this.coldSliceSize = Math.max(1, Math.floor(options.coldSliceSize ?? 150));
    this.hotIntervalMs = Math.max(60_000, options.hotIntervalMs ?? 5 * 60_000);
    this.coldIntervalMs = Math.max(this.hotIntervalMs, options.coldIntervalMs ?? 60 * 60_000);
    this.emitDebounceMs = Math.max(100, options.emitDebounceMs ?? 1500);
    this.remoteDataUrl = options.remoteDataUrl;
    this.remotePollMs = Math.max(15_000, options.remotePollMs ?? 45_000);
    this.hydrateFromHistory();
  }

  get scanMode(): ScanMode {
    return this.mode;
  }

  setMode(next: ScanMode): ScanMode {
    if (next === this.mode) return this.mode;
    if (next === "remote" && !this.remoteDataUrl) throw new Error("remote mode requires a data URL");
    this.stop();
    this.activeRefresh = null;
    this.scanGeneration += 1;
    this.mode = next;
    this.remoteState = null;
    this.status = {
      ...this.status,
      running: false,
      reason: `switching-to-${next}`,
      scannedWeapons: 0,
      totalWeapons: 0,
      lastMessage: `Switched to ${next} mode`,
    };
    delete this.status.lastError;
    this.start();
    return this.mode;
  }

  private hydrateFromHistory(): void {
    if (!this.history) return;
    const snapshot = this.history.warmStart();
    if (snapshot.restoredWeaponCount === 0) return;
    for (const [slug, auctions] of snapshot.auctionsByWeapon) this.auctionsByWeapon.set(slug, auctions);
    for (const [slug, scannedAt] of snapshot.scannedAtByWeapon) this.scannedAtByWeapon.set(slug, scannedAt);
    this.auctionsRevision += 1;
    const latestIso = snapshot.latestSnapshotTs !== null ? new Date(snapshot.latestSnapshotTs * 1000).toISOString() : undefined;
    this.status = {
      ...this.status,
      lastMessage: `Warm-started ${snapshot.restoredWeaponCount} weapons from history (${latestIso ?? "unknown time"})`,
    };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.timers.length > 0) return;
    if (this.mode === "remote") {
      this.startRemotePolling();
      return;
    }
    if (this.mode === "tiered") {
      this.scheduleNextRefreshAt();
      this.timers.push(setInterval(() => {
        this.scheduleNextRefreshAt();
        void this.refresh("hot-scheduled", "hot");
      }, this.hotIntervalMs));
      this.timers.push(setInterval(() => {
        void this.refresh("cold-scheduled", "cold");
      }, this.coldIntervalMs));
      void this.refresh("startup-hot", "hot");
    } else {
      this.scheduleNextRefreshAt();
      this.timers.push(setInterval(() => {
        this.scheduleNextRefreshAt();
        void this.refresh("scheduled", "full");
      }, this.refreshMs));
      void this.refresh("startup", "full");
    }
  }

  private startRemotePolling(): void {
    if (!this.remoteDataUrl) {
      this.status = {
        ...this.status,
        running: false,
        reason: "remote",
        lastMessage: "Remote mode requested but no WFM_DATA_URL set. No data source active.",
      };
      this.emitStateImmediate();
      return;
    }
    this.status = {
      initialized: this.status.initialized,
      running: true,
      reason: "remote",
      startedAt: new Date().toISOString(),
      scannedWeapons: 0,
      totalWeapons: 0,
      lastMessage: `Polling ${this.remoteDataUrl} every ${Math.round(this.remotePollMs / 1000)}s`,
    };
    this.emitStateImmediate();
    void this.pollRemote();
    this.timers.push(setInterval(() => void this.pollRemote(), this.remotePollMs));
  }

  private async pollRemote(): Promise<void> {
    if (!this.remoteDataUrl) return;
    try {
      const response = await fetch(this.remoteDataUrl);
      if (!response.ok) {
        this.status.lastError = `remote ${response.status}`;
        this.emitStateImmediate();
        return;
      }
      const parsed = await response.json();
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.opportunities)) {
        this.status.lastError = "remote payload malformed";
        this.emitStateImmediate();
        return;
      }
      this.remoteState = parsed as DashboardState;
      this.lastRemoteFetchAt = Date.now();
      this.status = {
        initialized: true,
        running: false,
        reason: "remote",
        finishedAt: new Date().toISOString(),
        scannedWeapons: parsed.status?.scannedWeapons ?? 0,
        totalWeapons: parsed.status?.totalWeapons ?? 0,
        lastMessage: `Remote snapshot fetched: ${parsed.totals?.opportunities ?? 0} opportunities`,
      };
      delete this.status.lastError;
      this.emitStateImmediate();
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.emitStateImmediate();
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
  }

  updateConfig(update: Partial<TraderConfig>): TraderConfig {
    this.config = normalizeConfig({ ...this.config, ...update });
    this.configRevision += 1;
    this.emitStateImmediate();
    return this.config;
  }

  async refresh(reason: string, tier: ScanTier = "full"): Promise<void> {
    if (this.activeRefresh) {
      this.status.lastMessage = `Skipped overlapping ${reason} refresh; current ${this.status.reason} scan is still running`;
      this.emitStateImmediate();
      return this.activeRefresh;
    }
    this.activeRefresh = this.runRefresh(reason, tier);
    try {
      await this.activeRefresh;
    } finally {
      this.activeRefresh = null;
    }
  }

  getSignatureValuation(weaponSlug: string, signature: string, windowDays: number = 30): SignatureValuationResult | null {
    if (!this.history) return null;
    try {
      return this.history.signatureValuation(weaponSlug, signature, windowDays);
    } catch {
      return null;
    }
  }

  getSignatureVelocity(weaponSlug: string, signature: string, windowDays: number = 30): SignatureVelocityResult | null {
    if (!this.history) return null;
    try {
      return this.history.signatureVelocity(weaponSlug, signature, windowDays);
    } catch {
      return null;
    }
  }

  getAllWeapons(): RivenWeapon[] {
    return this.reference?.rivenWeapons ?? [];
  }

  getDispositionSignals(sinceSeconds: number = 30 * 24 * 60 * 60): Map<string, "rising" | "falling"> {
    const map = new Map<string, "rising" | "falling">();
    if (!this.history) return map;
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
    try {
      const rows = this.history.recentDispositionChanges(cutoff);
      for (const row of rows) map.set(row.weapon_slug, row.delta > 0 ? "rising" : "falling");
    } catch {
      // history query failure is non-fatal
    }
    return map;
  }

  getState(): DashboardState {
    if (this.mode === "remote") {
      if (this.remoteState) {
        return {
          ...this.remoteState,
          scanMode: "remote",
          generatedAt: new Date().toISOString(),
          status: { ...this.status },
        };
      }
      return {
        generatedAt: new Date().toISOString(),
        refreshMs: this.remotePollMs,
        apiBase: this.remoteDataUrl ?? "remote",
        scanMode: "remote",
        config: this.config,
        status: { ...this.status },
        reference: { weapons: 0, attributes: 0 },
        totals: { weaponsWithAuctions: 0, auctions: 0, opportunities: 0 },
        opportunities: [],
        weaponSummaries: [],
      };
    }
    const weapons = this.reference?.rivenWeapons ?? [];
    const key = this.analysisKey();
    let analysis = this.cachedAnalysis && this.cachedAnalysis.key === key ? this.cachedAnalysis.analysis : null;
    if (!analysis) {
      analysis = analyzeMarket(weapons, this.auctionsByWeapon, this.config, this.scannedAtByWeapon);
      this.cachedAnalysis = { key, analysis };
    }
    let auctionCount = 0;
    for (const auctions of this.auctionsByWeapon.values()) auctionCount += auctions.length;
    const reference: DashboardState["reference"] = {
      weapons: weapons.length,
      attributes: this.reference?.rivenAttributes.length ?? 0,
    };
    if (this.reference?.versionsUpdatedAt) reference.versionsUpdatedAt = this.reference.versionsUpdatedAt;
    return {
      generatedAt: new Date().toISOString(),
      refreshMs: this.mode === "tiered" ? this.hotIntervalMs : this.refreshMs,
      apiBase: this.client.baseUrl,
      scanMode: this.mode,
      config: this.config,
      status: { ...this.status },
      reference,
      totals: {
        weaponsWithAuctions: this.auctionsByWeapon.size,
        auctions: auctionCount,
        opportunities: analysis.opportunities.length,
      },
      opportunities: analysis.opportunities,
      weaponSummaries: analysis.weaponSummaries,
    };
  }

  private analysisKey(): string {
    return `${this.auctionsRevision}|${this.configRevision}`;
  }

  private scheduleNextRefreshAt(): void {
    const next = this.scanMode === "tiered" ? this.hotIntervalMs : this.refreshMs;
    this.status.nextRefreshAt = new Date(Date.now() + next).toISOString();
  }

  private async runRefresh(reason: string, tier: ScanTier): Promise<void> {
    const myGeneration = this.scanGeneration;
    const stillCurrent = () => this.scanGeneration === myGeneration && this.mode !== "remote";
    const startedAt = new Date().toISOString();
    this.status = {
      initialized: this.status.initialized,
      running: true,
      reason,
      startedAt,
      scannedWeapons: 0,
      totalWeapons: 0,
      lastMessage: "Loading Warframe.market reference data",
    };
    this.emitStateImmediate();

    try {
      if (!this.reference) {
        this.reference = await this.client.loadReference();
        if (!stillCurrent()) return;
        this.status.initialized = true;
        this.auctionsRevision += 1;
      }

      const targets = this.scanTargets(this.reference.rivenWeapons, tier);
      if (!stillCurrent()) return;
      this.status.totalWeapons = targets.length;
      const tierLabel = this.scanMode === "tiered" && tier !== "full" ? ` (${tier})` : "";
      this.status.lastMessage = targets.length === 0
        ? `No weapons matched the current watchlist${tierLabel}`
        : `Scanning ${targets.length} riven weapon auction books${tierLabel}`;
      this.emitStateImmediate();

      const scannedThisCycle: string[] = [];
      await this.runWithConcurrency(targets, async (weapon) => {
        if (!stillCurrent()) return;
        this.status.lastMessage = `Scanning ${weapon.name}${tierLabel}`;
        const auctions = await this.client.searchRivenAuctions(weapon.slug);
        if (!stillCurrent()) return;
        this.auctionsByWeapon.set(weapon.slug, auctions);
        this.scannedAtByWeapon.set(weapon.slug, new Date().toISOString());
        this.status.scannedWeapons += 1;
        this.auctionsRevision += 1;
        scannedThisCycle.push(weapon.slug);
        this.emitStateDebounced();
      });

      if (!stillCurrent()) return;
      this.persistScan(scannedThisCycle);

      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      this.scheduleNextRefreshAt();
      this.status.lastMessage = `Finished ${reason} scan: ${this.status.scannedWeapons}/${this.status.totalWeapons} weapon books refreshed`;
      this.emitStateImmediate();
    } catch (error) {
      if (!stillCurrent()) return;
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.status.lastMessage = `Refresh failed: ${this.status.lastError}`;
      this.emitStateImmediate();
    }
  }

  private persistScan(scannedSlugs: string[]): void {
    if (!this.history || scannedSlugs.length === 0 || !this.reference) return;
    const dispositionBySlug = new Map<string, number>();
    for (const weapon of this.reference.rivenWeapons) dispositionBySlug.set(weapon.slug, weapon.disposition);
    try {
      this.history.writeScan({
        tsSeconds: Math.floor(Date.now() / 1000),
        scannedSlugs,
        auctionsByWeapon: this.auctionsByWeapon,
        dispositionBySlug,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.lastError = `history write failed: ${message}`;
    }
  }

  private scanTargets(weapons: RivenWeapon[], tier: ScanTier): RivenWeapon[] {
    const requested = this.config.watchlist.map(slugify);
    let candidates: RivenWeapon[];
    if (requested.length === 0) {
      candidates = this.config.scanAllWhenWatchlistEmpty ? weapons : [];
    } else {
      const requestedSet = new Set(requested);
      candidates = weapons.filter((weapon) => {
        const nameSlug = slugify(weapon.name);
        for (const request of requestedSet) {
          if (weapon.slug === request || nameSlug === request || weapon.slug.includes(request) || nameSlug.includes(request)) return true;
        }
        return false;
      });
    }
    if (this.weaponLimit !== null && this.weaponLimit > 0) candidates = candidates.slice(0, this.weaponLimit);
    if (this.scanMode !== "tiered" || tier === "full") return candidates;
    if (requested.length > 0) return candidates;
    return tier === "hot" ? this.pickHot(candidates) : this.pickCold(candidates);
  }

  private pickHot(pool: RivenWeapon[]): RivenWeapon[] {
    if (pool.length === 0) return [];
    const oppSlugs = new Set(
      (this.cachedAnalysis?.analysis.opportunities ?? []).map((opportunity) => opportunity.weaponSlug),
    );
    const now = Date.now();
    const rescanThresholdMs = HOT_SCORE_MIN_HOURS_BETWEEN_RESCANS * 60 * 60_000;
    const scored = pool.map((weapon) => {
      let score = 0;
      if (oppSlugs.has(weapon.slug)) score += 10;
      const listings = this.auctionsByWeapon.get(weapon.slug)?.length ?? 0;
      if (listings > 0) score += Math.min(2, Math.log2(listings + 1) / 4);
      const lastScan = this.scannedAtByWeapon.get(weapon.slug);
      if (!lastScan) score += 1.5;
      else {
        const ageMs = now - Date.parse(lastScan);
        if (Number.isFinite(ageMs) && ageMs > rescanThresholdMs) score += 0.5;
      }
      return { weapon, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.min(this.hotSize, scored.length)).map((entry) => entry.weapon);
  }

  private pickCold(pool: RivenWeapon[]): RivenWeapon[] {
    if (pool.length === 0) return [];
    const hotSet = new Set(this.pickHot(pool).map((weapon) => weapon.slug));
    const cold = pool.filter((weapon) => !hotSet.has(weapon.slug));
    if (cold.length === 0) return [];
    const size = Math.min(this.coldSliceSize, cold.length);
    const start = ((this.coldCursor % cold.length) + cold.length) % cold.length;
    const slice: RivenWeapon[] = [];
    for (let i = 0; i < size; i += 1) {
      const item = cold[(start + i) % cold.length];
      if (item !== undefined) slice.push(item);
    }
    this.coldCursor = (start + size) % cold.length;
    return slice;
  }

  private async runWithConcurrency<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workerCount = Math.min(this.concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        if (item !== undefined) await worker(item);
      }
    });
    await Promise.all(workers);
  }

  private emitStateImmediate(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    this.deliverState();
  }

  private emitStateDebounced(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.deliverState();
    }, this.emitDebounceMs);
  }

  private deliverState(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
