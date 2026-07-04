/*
 * MCP-over-legacy-SSE transport with a versioned response envelope.
 *
 * Every tool returns { version, data, meta } — the meta block advertises
 * data freshness, coverage, and a quality tier (green/yellow/red) so clients
 * (and agents) can decide "is this trash?" without guessing.
 *
 * Legacy `content: [{type:"text", text:"<json>"}]` is preserved alongside
 * `structuredContent` so older MCP clients still work.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  computeMeta,
  enrichOpportunity,
  markEnvelopeInvalid,
  outputSchemas,
  toEnvelope,
  validateEnvelope,
  type EnrichedOpportunity,
  type Envelope,
  type EnvelopeMeta,
  type MetaComputeInput,
} from "./mcp/schemas.js";
import { isRecord, readNumber, readPositiveInteger, readString, readStringArray } from "./wfm/guards.js";
import { attributeSignature } from "./wfm/opportunities.js";
import type { RivenTraderService } from "./wfm/scanner.js";
import type { DashboardState, Opportunity, TraderConfig } from "./wfm/types.js";

interface McpSession {
  id: string;
  response: ServerResponse;
  createdAt: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: unknown;
  method: string;
  params?: unknown;
}

const LIVE_WINDOW_MS = 5 * 60_000;

export class McpSseServer {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly service: RivenTraderService) {}

  handleSse(request: IncomingMessage, response: ServerResponse): void {
    const sessionId = randomUUID();
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const session: McpSession = { id: sessionId, response, createdAt: Date.now() };
    this.sessions.set(sessionId, session);
    this.writeEvent(response, "endpoint", `/mcp/messages?sessionId=${encodeURIComponent(sessionId)}`);
    this.writeEvent(response, "message", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: { server: "wf-riventrader" } }));
    request.on("close", () => {
      this.sessions.delete(sessionId);
    });
  }

  async handleMessage(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const session = this.sessions.get(sessionId);
    if (!session) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Unknown MCP SSE session");
      return;
    }

    const body = await readRequestJson(request);
    const messages = Array.isArray(body) ? body : [body];
    for (const candidate of messages) {
      const parsed = parseJsonRpcRequest(candidate);
      if (!parsed) {
        this.sendMessage(session, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } });
        continue;
      }
      const result = await this.dispatch(parsed);
      if (result !== null) this.sendMessage(session, result);
    }

    response.writeHead(202, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("accepted");
  }

  private async dispatch(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    if (request.method.startsWith("notifications/")) return null;
    if (request.method === "initialize") {
      return ok(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: "wf-riventrader", version: "0.1.0" },
      });
    }
    if (request.method === "ping") return ok(request.id, {});
    if (request.method === "tools/list") return ok(request.id, { tools: this.tools() });
    if (request.method === "tools/call") return this.handleToolCall(request);
    if (request.method === "resources/list") {
      return ok(request.id, { resources: [{ uri: "wf-riventrader://snapshot", name: "Current riven trader snapshot", mimeType: "application/json" }] });
    }
    if (request.method === "resources/read") {
      return ok(request.id, { contents: [{ uri: "wf-riventrader://snapshot", mimeType: "application/json", text: JSON.stringify(this.service.getState(), null, 2) }] });
    }
    return err(request.id, -32601, `Unsupported MCP method: ${request.method}`, { retryable: false });
  }

  private async handleToolCall(request: JsonRpcRequest): Promise<Record<string, unknown>> {
    if (!isRecord(request.params)) return err(request.id, -32602, "tools/call requires params", { retryable: false });
    const name = readString(request.params, "name");
    const argumentsRecord = readRecordFromParams(request.params, "arguments");
    if (name === "riven_trader_snapshot") return this.snapshotTool(request.id, argumentsRecord);
    if (name === "riven_opportunities") return this.opportunitiesTool(request.id, argumentsRecord);
    if (name === "riven_refresh") return this.refreshTool(request.id);
    if (name === "riven_set_watchlist") return this.watchlistTool(request.id, argumentsRecord);
    if (name === "riven_health") return this.healthTool(request.id);
    if (name === "riven_signature_value") return this.signatureValueTool(request.id, argumentsRecord);
    if (name === "riven_instant_wins") return this.instantWinsTool(request.id, argumentsRecord);
    return err(request.id, -32602, `Unknown tool: ${name ?? "missing"}`, { retryable: false });
  }

  private buildSignatureLookup(): (weaponSlug: string, signature: string) => { valuation: null | { sample_count: number; confidence: number; p25: number | null; p50: number | null }; velocity: null | { classification: "fast_moving" | "stuck" | "unknown" } } {
    return (weaponSlug: string, signature: string) => {
      const valuation = this.service.getSignatureValuation(weaponSlug, signature);
      const velocity = this.service.getSignatureVelocity(weaponSlug, signature);
      return {
        valuation: valuation ? { sample_count: valuation.sample_count, confidence: valuation.confidence, p25: valuation.p25, p50: valuation.p50 } : null,
        velocity: velocity ? { classification: velocity.classification } : null,
      };
    };
  }

  private signatureValueTool(id: unknown, args: Record<string, unknown>): Record<string, unknown> {
    const weaponSlug = readString(args, "weapon_slug") ?? readString(args, "weaponSlug");
    if (!weaponSlug) return err(id, -32602, "weapon_slug is required", { retryable: false });
    const explicitSignature = readString(args, "signature");
    const positives = readStringArray(args, "positives");
    const negatives = readStringArray(args, "negatives");
    const signature = explicitSignature ?? attributeSignature([
      ...positives.map((urlName) => ({ urlName, value: 1, positive: true })),
      ...negatives.map((urlName) => ({ urlName, value: -1, positive: false })),
    ]);
    const windowDays = Math.max(1, Math.floor(readNumber(args, "window_days") ?? readNumber(args, "windowDays") ?? 30));
    const valuation = this.service.getSignatureValuation(weaponSlug, signature, windowDays);
    const velocity = this.service.getSignatureVelocity(weaponSlug, signature, windowDays);
    const state = this.service.getState();
    const meta = this.buildMeta(state);
    if (!valuation) {
      return ok(id, this.finalizeEnvelope(toEnvelope({
        weapon_slug: weaponSlug,
        signature,
        window_days: windowDays,
        sample_count: 0,
        p25: null, p50: null, p75: null, p90: null, min: null, max: null,
        last_seen_price: null, last_seen_at: null,
        confidence: 0,
        velocity: null,
        note: "history disabled or no samples available yet",
      }, meta)));
    }
    const data = { ...valuation, velocity };
    return ok(id, this.finalizeEnvelope(toEnvelope(data, meta)));
  }

  private instantWinsTool(id: unknown, args: Record<string, unknown>): Record<string, unknown> {
    const limit = readPositiveInteger(args, "limit", 25);
    const minConfidence = readNumber(args, "minConfidence") ?? readNumber(args, "min_confidence") ?? 0.6;
    const state = this.service.getState();
    const meta = this.buildMeta(state);
    const dispositionSignals = this.service.getDispositionSignals();
    const signatureLookup = this.buildSignatureLookup();
    const hits: Array<{ opportunity: Opportunity; signature_value: unknown; expected_uplift: number }> = [];
    for (const opportunity of state.opportunities) {
      const valuation = this.service.getSignatureValuation(opportunity.weaponSlug, opportunity.signature);
      if (!valuation || valuation.sample_count < 8) continue;
      if (valuation.confidence < minConfidence) continue;
      if (valuation.p25 === null || valuation.p50 === null) continue;
      if (opportunity.buyPrice >= valuation.p25) continue;
      const velocity = this.service.getSignatureVelocity(opportunity.weaponSlug, opportunity.signature);
      const uplift = (valuation.p50 - opportunity.buyPrice) * valuation.confidence;
      hits.push({
        opportunity: enrichOpportunity(opportunity, Date.parse(state.generatedAt), { dispositionSignals, signatureLookup }),
        signature_value: { ...valuation, velocity },
        expected_uplift: Math.round(uplift * 100) / 100,
      });
    }
    hits.sort((a, b) => b.expected_uplift - a.expected_uplift);
    return ok(id, this.finalizeEnvelope(toEnvelope(hits.slice(0, limit), meta)));
  }

  private snapshotTool(id: unknown, args: Record<string, unknown>): Record<string, unknown> {
    const limit = readPositiveInteger(args, "limit", 25);
    const state = this.service.getState();
    const meta = this.buildMeta(state);
    const dispositionSignals = this.service.getDispositionSignals();
    const signatureLookup = this.buildSignatureLookup();
    const enriched = state.opportunities.slice(0, limit).map((opportunity) => enrichOpportunity(opportunity, Date.parse(state.generatedAt), { dispositionSignals, signatureLookup }));
    const data = {
      totals: state.totals,
      opportunities: enriched,
      weaponSummaries: state.weaponSummaries.slice(0, limit),
      config: state.config,
      status: state.status,
    };
    return ok(id, this.finalizeEnvelope(toEnvelope(data, meta)));
  }

  private opportunitiesTool(id: unknown, args: Record<string, unknown>): Record<string, unknown> {
    const limit = readPositiveInteger(args, "limit", 25);
    const configUpdate: Partial<TraderConfig> = {};
    const minProfit = readNumber(args, "minProfit");
    const minRoi = readNumber(args, "minRoi");
    const minBuyPrice = readNumber(args, "minBuyPrice");
    const maxSellPrice = readNumber(args, "maxSellPrice");
    if (minProfit !== undefined) configUpdate.minProfit = minProfit;
    if (minRoi !== undefined) configUpdate.minRoi = minRoi;
    if (minBuyPrice !== undefined) configUpdate.minBuyPrice = minBuyPrice;
    if (maxSellPrice !== undefined) configUpdate.maxSellPrice = maxSellPrice;
    if (Object.keys(configUpdate).length > 0) this.service.updateConfig(configUpdate);
    const state = this.service.getState();
    const meta = this.buildMeta(state);
    const dispositionSignals = this.service.getDispositionSignals();
    const signatureLookup = this.buildSignatureLookup();
    const enriched: EnrichedOpportunity[] = state.opportunities
      .slice(0, limit)
      .map((opportunity) => enrichOpportunity(opportunity, Date.parse(state.generatedAt), { dispositionSignals, signatureLookup }));
    return ok(id, this.finalizeEnvelope(toEnvelope(enriched, meta)));
  }

  private refreshTool(id: unknown): Record<string, unknown> {
    void this.service.refresh("mcp");
    const state = this.service.getState();
    const meta = this.buildMeta(state);
    return ok(id, this.finalizeEnvelope(toEnvelope({ accepted: true, reason: "refresh scheduled" }, meta)));
  }

  private watchlistTool(id: unknown, args: Record<string, unknown>): Record<string, unknown> {
    const watchlist = parseWatchlist(args);
    this.service.updateConfig({ watchlist });
    void this.service.refresh("mcp-watchlist");
    const state = this.service.getState();
    const meta = this.buildMeta(state);
    return ok(id, this.finalizeEnvelope(toEnvelope({ accepted: true, watchlist }, meta)));
  }

  private healthTool(id: unknown): Record<string, unknown> {
    const state = this.service.getState();
    const meta = this.buildMeta(state);
    return ok(id, this.finalizeEnvelope(toEnvelope(null, meta)));
  }

  private buildMeta(state: DashboardState): EnvelopeMeta {
    const nowMs = Date.parse(state.generatedAt);
    const lastSampleAt = state.status.finishedAt ?? state.status.startedAt;
    const freshness = lastSampleAt ? Math.max(0, nowMs - Date.parse(lastSampleAt)) : Number.MAX_SAFE_INTEGER;
    const dataSource: EnvelopeMeta["data_source"] = state.status.running || freshness < LIVE_WINDOW_MS ? "live" : "cache";
    const totalTargets = state.status.totalWeapons > 0 ? state.status.totalWeapons : state.reference.weapons;
    const input: MetaComputeInput = {
      generated_at: state.generatedAt,
      data_source: dataSource,
      freshness_ms: freshness,
      scanned: state.status.scannedWeapons,
      total: totalTargets,
      scan_running: state.status.running,
    };
    return computeMeta(input);
  }

  private finalizeEnvelope<T>(envelope: Envelope<T>): Record<string, unknown> {
    const validation = validateEnvelope(envelope);
    const safe = validation.ok ? envelope : markEnvelopeInvalid(envelope, validation.ok ? "" : validation.message);
    return {
      content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
      structuredContent: safe,
    };
  }

  describeTools(): Array<{ name: string; description: string }> {
    return this.tools().map((tool) => ({
      name: String(tool.name),
      description: String(tool.description ?? ""),
    }));
  }

  private tools(): Array<Record<string, unknown>> {
    return [
      {
        name: "riven_trader_snapshot",
        description: "Return the current Warframe.market riven trader dashboard snapshot wrapped in a versioned envelope. Inspect `meta.quality` and `meta.warnings` before consuming `data.opportunities` — red means don't trust.",
        inputSchema: { type: "object", properties: { limit: { type: "number", minimum: 1, default: 25 } }, additionalProperties: false },
        outputSchema: outputSchemas.snapshot,
      },
      {
        name: "riven_opportunities",
        description: "Return ranked buy-low/sell-high riven opportunities. Each opportunity carries a `quality` block (tier A–D and signal tags like low_comparables/new_seller/stale_seller).",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", minimum: 1, default: 25 }, minProfit: { type: "number", minimum: 0 }, minRoi: { type: "number", minimum: 0 }, minBuyPrice: { type: "number", minimum: 0 }, maxSellPrice: { type: "number", minimum: 0 } },
          additionalProperties: false,
        },
        outputSchema: outputSchemas.opportunities,
      },
      {
        name: "riven_refresh",
        description: "Start a non-overlapping Warframe.market riven refresh through the shared server-side token bucket.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: outputSchemas.action,
      },
      {
        name: "riven_set_watchlist",
        description: "Set a riven weapon watchlist and start a refresh. Empty watchlist scans all riven weapons.",
        inputSchema: {
          type: "object",
          properties: { watchlist: { type: "array", items: { type: "string" } }, watchlistText: { type: "string" } },
          additionalProperties: false,
        },
        outputSchema: outputSchemas.action,
      },
      {
        name: "riven_health",
        description: "Return only the meta block (freshness, coverage, quality, warnings). Cheap probe for agents to check trust before calling other tools.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: outputSchemas.health,
      },
      {
        name: "riven_signature_value",
        description: "Look up the trailing p25/p50/p75/p90 sell price for a specific riven trait signature (positives + negatives) on a weapon, plus a velocity block estimating how fast listings with that signature actually move. Returns confidence 0..1; ignore when confidence is low.",
        inputSchema: {
          type: "object",
          properties: {
            weapon_slug: { type: "string" },
            positives: { type: "array", items: { type: "string" } },
            negatives: { type: "array", items: { type: "string" } },
            signature: { type: "string" },
            window_days: { type: "number", minimum: 1, default: 30 },
          },
          additionalProperties: false,
        },
        outputSchema: outputSchemas.signatureValue,
      },
      {
        name: "riven_instant_wins",
        description: "Return current listings priced below their same-signature p25 (with enough history to trust). Ranked by (p50 - buy) * confidence. This is the 'snipe candidates' feed.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 1, default: 25 },
            minConfidence: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
          },
          additionalProperties: false,
        },
        outputSchema: outputSchemas.instantWins,
      },
    ];
  }

  private sendMessage(session: McpSession, payload: Record<string, unknown>): void {
    this.writeEvent(session.response, "message", JSON.stringify(payload));
  }

  private writeEvent(response: ServerResponse, event: string, data: string): void {
    response.write(`event: ${event}\n`);
    response.write(`data: ${data}\n\n`);
  }
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  if (body.trim().length === 0) return {};
  return JSON.parse(body);
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest | null {
  if (!isRecord(value)) return null;
  const method = readString(value, "method");
  if (!method) return null;
  const parsed: JsonRpcRequest = { jsonrpc: "2.0", method };
  if (value.id !== undefined) parsed.id = value.id;
  if (value.params !== undefined) parsed.params = value.params;
  return parsed;
}

function readRecordFromParams(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function parseWatchlist(record: Record<string, unknown>): string[] {
  const arrayValues = readStringArray(record, "watchlist");
  const text = readString(record, "watchlistText");
  const textValues = text ? text.split(/[\n,]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0) : [];
  return [...arrayValues, ...textValues];
}

function ok(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(id: unknown, code: number, message: string, data?: { retryable?: boolean; retry_after_s?: number }): Record<string, unknown> {
  const errorBody: Record<string, unknown> = { code, message };
  if (data !== undefined) errorBody.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error: errorBody };
}
