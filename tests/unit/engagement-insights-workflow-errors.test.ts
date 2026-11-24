import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/mux-assets", () => ({
  getPlaybackIdForAsset: vi.fn(),
  getAssetDurationSecondsFromAsset: vi.fn(),
  isAudioOnlyAsset: vi.fn(),
}));
vi.mock("../../src/lib/workflow-credentials", () => ({ resolveMuxSigningContext: vi.fn() }));
vi.mock("../../src/lib/providers", () => ({ resolveLanguageModelConfig: vi.fn(), createLanguageModelFromConfig: vi.fn() }));
vi.mock("../../src/primitives/hotspots", () => ({ getHotspotsForAsset: vi.fn() }));
vi.mock("../../src/primitives/heatmap", () => ({ getHeatmapForAsset: vi.fn() }));
vi.mock("../../src/primitives/shots", () => ({ getShotsForAsset: vi.fn() }));
vi.mock("../../src/primitives/storyboards", () => ({ getStoryboardUrl: vi.fn() }));
vi.mock("../../src/primitives/transcripts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/primitives/transcripts")>(),
  fetchTranscriptForAsset: vi.fn(),
}));

const { getPlaybackIdForAsset, getAssetDurationSecondsFromAsset, isAudioOnlyAsset } = await import("../../src/lib/mux-assets");
const { resolveMuxSigningContext } = await import("../../src/lib/workflow-credentials");
const { resolveLanguageModelConfig } = await import("../../src/lib/providers");
const { getHotspotsForAsset } = await import("../../src/primitives/hotspots");
const { getHeatmapForAsset } = await import("../../src/primitives/heatmap");
const { getShotsForAsset } = await import("../../src/primitives/shots");
const { getStoryboardUrl } = await import("../../src/primitives/storyboards");
const { fetchTranscriptForAsset } = await import("../../src/primitives/transcripts");
const { generateEngagementInsights } = await import("../../src/workflows/engagement-insights");

/** As Workflow DevKit rejects a step's promise when a replay diverges. */
function replayDivergence() {
  return Object.assign(new Error("Replay divergence: step created but not found in invocation queue"), { name: "ReplayDivergenceError" });
}

describe("generateEngagementInsights and Workflow DevKit's control flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPlaybackIdForAsset).mockResolvedValue({ asset: { id: "asset-1" }, playbackId: "playback-1", policy: "public" } as never);
    vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(120);
    vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
    vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
    vi.mocked(resolveLanguageModelConfig).mockReturnValue({ provider: "openai", modelId: "test-model" } as never);
    vi.mocked(getHotspotsForAsset).mockResolvedValue([{ startMs: 1000, endMs: 2000, score: 0.9 }]);
    vi.mocked(getHeatmapForAsset).mockResolvedValue({ heatmap: [] } as never);
    vi.mocked(getShotsForAsset).mockResolvedValue({ status: "pending" } as never);
    vi.mocked(getStoryboardUrl).mockResolvedValue("https://image.mux.com/playback-1/storyboard.png");
    vi.mocked(fetchTranscriptForAsset).mockResolvedValue({ transcriptText: "" } as never);
  });

  it.each([
    ["shots", () => vi.mocked(getShotsForAsset).mockRejectedValueOnce(replayDivergence())],
    ["transcript", () => vi.mocked(fetchTranscriptForAsset).mockRejectedValueOnce(replayDivergence())],
    ["storyboard", () => vi.mocked(getStoryboardUrl).mockRejectedValueOnce(replayDivergence())],
  ])("rethrows a replay divergence from the %s step instead of falling back", async (_step, arrange) => {
    arrange();

    const error = await generateEngagementInsights("asset-1").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "ReplayDivergenceError" });
    expect(error).not.toHaveProperty("code");
  });
});
