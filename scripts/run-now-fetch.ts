import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildRunNowLiveArtifact, fetchLiveActivitySnapshot } from "../src/wfm/live.js";

interface Args {
  dataDir: string;
  userAgent: string;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const arg = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  return {
    dataDir: arg("--data-dir") ?? env.WFM_DATA_DIR ?? "data",
    userAgent: env.WFM_USER_AGENT ?? "the-plat-exchange-run-now/0.1 (+https://github.com/ck0i/ThePlatExchange)",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const now = new Date();
  const live = await fetchLiveActivitySnapshot(args.userAgent, fetch, now);
  const artifact = buildRunNowLiveArtifact(live, now.toISOString(), now);
  const latestDir = join(args.dataDir, "latest");
  await mkdir(latestDir, { recursive: true });
  await writeFile(join(latestDir, "run-now.json"), JSON.stringify(artifact, null, 2), "utf8");
  console.log(`Run Now live artifact wrote ${artifact.runNow.activities.length} activities, ${artifact.runNow.rejectedActivities.length} rejected, live status ${artifact.live.status}.`);
}

await main();
