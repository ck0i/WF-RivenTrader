/*
 * scripts/sentiment-fetch.ts — one-shot mention scraper for weapon names.
 *
 * Sources:
 *   - Steam news for the Warframe app (patch notes, dev posts).
 *   - Reddit /r/warframe /new.json (community chatter — leading indicator for hype).
 *
 * Writes matched mentions to data/events/sentiment-YYYY-MM-DD.jsonl.
 *
 * IMPORTANT: this signal is noisy. Weight it small (~5%) at the scoring layer.
 * Reddit rate limit: ~60 req/min unauth. Steam: generous. Both need a real UA.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WarframeMarketClient } from "../src/wfm/client.js";
import type { ReferenceSnapshot, RivenWeapon } from "../src/wfm/types.js";

const STEAM_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=230410&count=25&maxlength=8000";
const REDDIT_URL = "https://www.reddit.com/r/warframe/new.json?limit=100";
const MIN_WEAPON_NAME_LENGTH = 4;

interface Args {
  dataDir: string;
  userAgent: string;
  redditPause: number;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const arg = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  return {
    dataDir: arg("--data-dir") ?? env.WFM_DATA_DIR ?? "data",
    userAgent: env.WFM_SENTIMENT_UA ?? "wf-riventrader-sentiment/0.1 (+https://github.com/ck0i/WF-RivenTrader)",
    redditPause: Number(env.WFM_REDDIT_PAUSE_MS ?? 1500),
  };
}

async function loadReference(dataDir: string, userAgent: string): Promise<ReferenceSnapshot> {
  const path = join(dataDir, "reference", "current.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as ReferenceSnapshot;
      if (Array.isArray(parsed.rivenWeapons) && parsed.rivenWeapons.length > 0) return parsed;
    } catch {
      // fall through
    }
  }
  const client = new WarframeMarketClient({ userAgent, cacheDir: process.env.WFM_CACHE_DIR ?? "/tmp/wfm-cache" });
  return client.loadReference();
}

interface WeaponMatcher {
  weapon: RivenWeapon;
  pattern: RegExp;
}

function buildMatchers(weapons: RivenWeapon[]): WeaponMatcher[] {
  const matchers: WeaponMatcher[] = [];
  for (const weapon of weapons) {
    const name = weapon.name.trim();
    if (name.length < MIN_WEAPON_NAME_LENGTH) continue;
    const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    matchers.push({ weapon, pattern: new RegExp(`\\b${escaped}\\b`, "i") });
  }
  return matchers;
}

interface SentimentEvent {
  kind: "mention";
  source: "steam-news" | "reddit";
  ts: string;
  weapon_slug: string;
  weapon_name: string;
  post_id: string;
  score?: number;
  comments?: number;
  title: string;
  url?: string;
}

async function fetchSteamNews(userAgent: string, matchers: WeaponMatcher[]): Promise<SentimentEvent[]> {
  const response = await fetch(STEAM_URL, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
  if (!response.ok) {
    console.warn(`steam news fetch failed: ${response.status}`);
    return [];
  }
  const payload = (await response.json()) as { appnews?: { newsitems?: Array<{ gid?: string; title?: string; contents?: string; url?: string; date?: number }> } };
  const items = payload.appnews?.newsitems ?? [];
  const events: SentimentEvent[] = [];
  for (const item of items) {
    const title = item.title ?? "";
    const body = item.contents ?? "";
    const combined = `${title}\n${body}`;
    const seen = new Set<string>();
    for (const matcher of matchers) {
      if (seen.has(matcher.weapon.slug)) continue;
      if (matcher.pattern.test(combined)) {
        seen.add(matcher.weapon.slug);
        events.push({
          kind: "mention",
          source: "steam-news",
          ts: item.date ? new Date(item.date * 1000).toISOString() : new Date().toISOString(),
          weapon_slug: matcher.weapon.slug,
          weapon_name: matcher.weapon.name,
          post_id: item.gid ?? "",
          title: title.slice(0, 240),
          ...(item.url ? { url: item.url } : {}),
        });
      }
    }
  }
  return events;
}

async function fetchReddit(userAgent: string, matchers: WeaponMatcher[]): Promise<SentimentEvent[]> {
  const response = await fetch(REDDIT_URL, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
  if (!response.ok) {
    console.warn(`reddit fetch failed: ${response.status}`);
    return [];
  }
  const payload = (await response.json()) as { data?: { children?: Array<{ data?: { id?: string; title?: string; selftext?: string; score?: number; num_comments?: number; created_utc?: number; permalink?: string } }> } };
  const children = payload.data?.children ?? [];
  const events: SentimentEvent[] = [];
  for (const child of children) {
    const post = child.data;
    if (!post) continue;
    const title = post.title ?? "";
    const body = post.selftext ?? "";
    const combined = `${title}\n${body}`;
    const seen = new Set<string>();
    for (const matcher of matchers) {
      if (seen.has(matcher.weapon.slug)) continue;
      if (matcher.pattern.test(combined)) {
        seen.add(matcher.weapon.slug);
        const event: SentimentEvent = {
          kind: "mention",
          source: "reddit",
          ts: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : new Date().toISOString(),
          weapon_slug: matcher.weapon.slug,
          weapon_name: matcher.weapon.name,
          post_id: post.id ?? "",
          title: title.slice(0, 240),
        };
        if (post.score !== undefined) event.score = post.score;
        if (post.num_comments !== undefined) event.comments = post.num_comments;
        if (post.permalink) event.url = `https://reddit.com${post.permalink}`;
        events.push(event);
      }
    }
  }
  return events;
}

async function appendJsonl(dataDir: string, events: SentimentEvent[]): Promise<void> {
  if (events.length === 0) return;
  await mkdir(join(dataDir, "events"), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dataDir, "events", `sentiment-${date}.jsonl`);
  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await appendFile(path, lines, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  await mkdir(args.dataDir, { recursive: true });
  const reference = await loadReference(args.dataDir, args.userAgent);
  const matchers = buildMatchers(reference.rivenWeapons);
  console.log(`Matcher count: ${matchers.length}. Fetching Steam news…`);
  const steam = await fetchSteamNews(args.userAgent, matchers);
  console.log(`Steam mentions: ${steam.length}. Waiting ${args.redditPause}ms before Reddit…`);
  await new Promise((resolve) => setTimeout(resolve, args.redditPause));
  const reddit = await fetchReddit(args.userAgent, matchers);
  console.log(`Reddit mentions: ${reddit.length}. Writing events…`);
  await appendJsonl(args.dataDir, [...steam, ...reddit]);
  console.log(`Wrote ${steam.length + reddit.length} sentiment events.`);
}

main().catch((error) => {
  console.error("sentiment-fetch failed:", error);
  process.exit(1);
});
