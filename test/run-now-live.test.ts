import assert from "node:assert/strict";
import { buildRunNowLiveArtifact, fetchLiveActivitySnapshot, overlayRunNowArtifact } from "../src/wfm/live.js";
import { createInitialProductDashboard } from "../src/wfm/productEngine.js";

const generatedAt = new Date("2026-07-07T12:00:00.000Z");
const fetcher: typeof fetch = async (input) => {
  const url = requestUrl(input);
  if (url.endsWith("/fissures")) {
    return jsonResponse([
      {
        id: "keep-fissure",
        node: "Ukko",
        missionType: "Capture",
        tier: "Axi",
        activation: "2026-07-07T11:55:00.000Z",
        expiry: "2026-07-07T12:45:00.000Z",
      },
      {
        id: "soon-expired-fissure",
        node: "Hepit",
        missionType: "Capture",
        tier: "Lith",
        activation: "2026-07-07T11:55:00.000Z",
        expiry: "2026-07-07T12:10:00.000Z",
      },
    ]);
  }
  if (url.endsWith("/arbitration")) {
    return jsonResponse({
      id: "fresh-arbitration",
      node: "Selkie",
      type: "Survival",
      activation: "2026-07-07T11:55:00.000Z",
      expiry: "2026-07-07T12:50:00.000Z",
    });
  }
  return new Response(JSON.stringify({ error: "unexpected url" }), { status: 404 });
};

const live = await fetchLiveActivitySnapshot("test-agent", fetcher, generatedAt);
const artifact = buildRunNowLiveArtifact(live, generatedAt.toISOString(), generatedAt);
assert.deepEqual(
  artifact.runNow.activities.map((activity) => activity.id).sort(),
  ["fresh-arbitration", "keep-fissure", "soon-expired-fissure"],
  "run-now artifact should include only the live endpoints and no WFM/cold scan data",
);
assert.equal(artifact.live.id, "live", "artifact must carry the live source health row used by the Run Now UI");

const baseProduct = createInitialProductDashboard();
baseProduct.methods = [{
  id: "run_now",
  label: "Run Now",
  description: "stale method fixture",
  status: "green",
  opportunityCount: 1,
  sourceIds: ["live"],
  warnings: [],
  bestOpportunityId: "run_now",
}];

const overlaid = overlayRunNowArtifact(baseProduct, artifact, new Date("2026-07-07T12:20:00.000Z"));
assert.deepEqual(
  overlaid.runNow.activities.map((activity) => activity.id).sort(),
  ["fresh-arbitration", "keep-fissure"],
  "backend overlay must prune activities that expired after the artifact was written but before it is served",
);
assert.ok(
  overlaid.runNow.warnings.some((warning) => warning.includes("Removed 1 expired live activity")),
  "read-time expiry pruning must be visible in Run Now warnings",
);
const overlaidLive = overlaid.dataHealth.sources.find((source) => source.id === "live");
assert.notEqual(overlaidLive?.status, "red", "fresh artifact with remaining activities must stay visible to the Run Now tab");
assert.equal(overlaidLive?.lastSuccessAt, generatedAt.toISOString(), "overlay must patch the live health timestamp from the live artifact");
assert.equal(overlaid.methods.find((method) => method.id === "run_now")?.opportunityCount, 2, "method summary must reflect pruned live activities");
assert.ok(
  overlaid.opportunities.every((opportunity) => opportunity.expiresAt !== "2026-07-07T12:10:00.000Z"),
  "global product opportunities must not retain expired run-now rows",
);

const stale = overlayRunNowArtifact(baseProduct, artifact, new Date("2026-07-07T13:01:00.000Z"));
assert.equal(stale.runNow.activities.length, 0, "artifacts older than one hour must not serve Run Now activities");
assert.equal(stale.dataHealth.sources.find((source) => source.id === "live")?.status, "red", "stale live artifacts must force the live health row red");
assert.equal(
  "bestOpportunityId" in (stale.methods.find((method) => method.id === "run_now") ?? {}),
  false,
  "empty Run Now method metadata must not point at an old best opportunity",
);

console.log("run-now live artifact tests passed");

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
