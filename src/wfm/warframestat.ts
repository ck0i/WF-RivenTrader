/*
 * Fetches the community-maintained warframestat.us weapons index once and
 * builds a lowercase-name → imageName map. The image itself is served by
 * https://cdn.warframestat.us/img/${imageName}, a public CDN.
 *
 * Called from client.loadReference() after WFM's own reference lands, so
 * every RivenWeapon gets an imageName where a warframestat mapping exists.
 * Non-fatal: if the fetch fails, weapons just render without thumbnails.
 */
import type { RivenWeapon } from "./types.js";

const WARFRAMESTAT_URL = "https://api.warframestat.us/weapons";

interface WarframestatWeapon {
  name?: string;
  uniqueName?: string;
  imageName?: string;
}

export async function fetchWarframestatImageMap(userAgent: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const response = await fetch(WARFRAMESTAT_URL, {
      headers: { "User-Agent": userAgent, Accept: "application/json" },
    });
    if (!response.ok) return map;
    const payload = (await response.json()) as WarframestatWeapon[];
    if (!Array.isArray(payload)) return map;
    for (const entry of payload) {
      if (typeof entry?.name === "string" && typeof entry?.imageName === "string") {
        const key = entry.name.toLowerCase().trim();
        if (!map.has(key)) map.set(key, entry.imageName);
      }
    }
  } catch {
    // ignore — warframestat is a nice-to-have
  }
  return map;
}

export function enrichWeaponsWithImageNames(weapons: RivenWeapon[], imageMap: ReadonlyMap<string, string>): number {
  if (imageMap.size === 0) return 0;
  let matched = 0;
  for (const weapon of weapons) {
    if (weapon.imageName) continue;
    const key = weapon.name.toLowerCase().trim();
    const imageName = imageMap.get(key);
    if (imageName) {
      weapon.imageName = imageName;
      matched += 1;
    }
  }
  return matched;
}
