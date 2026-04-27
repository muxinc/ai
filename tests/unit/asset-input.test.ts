/**
 * Tests that every workflow correctly branches on whether the first argument is
 * a string asset ID or a pre-fetched MuxAsset object.
 *
 * When a string is passed:   getPlaybackIdForAsset IS called (hits api.mux.com)
 * When an asset is passed:   toPlaybackAsset IS called, getPlaybackIdForAsset is NOT
 *
 * Each workflow test lets the function reject after asset resolution (since
 * downstream dependencies like AI providers or transcript fetches are not fully
 * mocked), but the spy assertions are recorded before any rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/mux-assets", () => ({
  getAssetDurationSecondsFromAsset: vi.fn(),
  getPlaybackIdForAsset: vi.fn(),
  getVideoTrackDurationSecondsFromAsset: vi.fn(),
  getVideoTrackMaxFrameRateFromAsset: vi.fn(),
  isAudioOnlyAsset: vi.fn(),
  toPlaybackAsset: vi.fn(),
}));

vi.mock("../../src/lib/workflow-credentials", () => ({
  resolveMuxSigningContext: vi.fn(),
  resolveMuxClient: vi.fn(),
  resolveProviderApiKey: vi.fn(),
}));

vi.mock("../../src/primitives/transcripts", () => ({
  fetchTranscriptForAsset: vi.fn(),
  getReadyTextTracks: vi.fn(),
  getReliableLanguageCode: vi.fn(),
  parseVTTCues: vi.fn(),
  secondsToTimestamp: vi.fn(),
  buildTranscriptUrl: vi.fn(),
  extractTextFromVTT: vi.fn(),
  vttTimestampToSeconds: vi.fn(),
  stripVttMetadataBlocks: vi.fn(),
}));

vi.mock("../../src/primitives/storyboards", () => ({
  getStoryboardUrl: vi.fn(),
}));

vi.mock("../../src/primitives/hotspots", () => ({
  getHotspotsForAsset: vi.fn(),
}));

vi.mock("../../src/primitives/heatmap", () => ({
  getHeatmapForAsset: vi.fn(),
}));

vi.mock("../../src/primitives/shots", () => ({
  getShotsForAsset: vi.fn(),
}));

vi.mock("../../src/lib/mux-tracks", () => ({
  fetchVttFromMux: vi.fn(),
  createTextTrackOnMux: vi.fn(),
}));

vi.mock("../../src/primitives/thumbnails", () => ({
  getThumbnailUrls: vi.fn(),
  getThumbnailUrlsFromTimestamps: vi.fn(),
}));

const {
  getAssetDurationSecondsFromAsset,
  getPlaybackIdForAsset,
  getVideoTrackDurationSecondsFromAsset,
  getVideoTrackMaxFrameRateFromAsset,
  isAudioOnlyAsset,
  toPlaybackAsset,
} = await import("../../src/lib/mux-assets");

const { resolveMuxSigningContext, resolveMuxClient } = await import("../../src/lib/workflow-credentials");
const { fetchTranscriptForAsset, getReadyTextTracks, getReliableLanguageCode } = await import("../../src/primitives/transcripts");
const { getStoryboardUrl } = await import("../../src/primitives/storyboards");
const { getHotspotsForAsset } = await import("../../src/primitives/hotspots");
const { getHeatmapForAsset } = await import("../../src/primitives/heatmap");
const { getShotsForAsset } = await import("../../src/primitives/shots");
const { fetchVttFromMux } = await import("../../src/lib/mux-tracks");
const { getThumbnailUrls } = await import("../../src/primitives/thumbnails");

const { getSummaryAndTags } = await import("../../src/workflows/summarization");
const { generateChapters } = await import("../../src/workflows/chapters");
const { hasBurnedInCaptions } = await import("../../src/workflows/burned-in-captions");
const { getModerationScores } = await import("../../src/workflows/moderation");
const { generateEngagementInsights } = await import("../../src/workflows/engagement-insights");
const { editCaptions } = await import("../../src/workflows/edit-captions");
const { askQuestions } = await import("../../src/workflows/ask-questions");
const { generateEmbeddings } = await import("../../src/workflows/embeddings");
const { translateAudio } = await import("../../src/workflows/translate-audio");
const { translateCaptions } = await import("../../src/workflows/translate-captions");

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockAsset = {
  id: "asset-abc",
  playback_ids: [{ id: "pb-xyz", policy: "public" }],
  tracks: [{ type: "video", id: "v1" }, { type: "audio", id: "a1" }],
} as any;

const mockPlaybackAsset = { asset: mockAsset, playbackId: "pb-xyz", policy: "public" as const };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // Core asset-resolution mocks
  vi.mocked(toPlaybackAsset).mockReturnValue(mockPlaybackAsset);
  vi.mocked(getPlaybackIdForAsset).mockResolvedValue(mockPlaybackAsset);

  // Asset metadata helpers
  vi.mocked(getAssetDurationSecondsFromAsset).mockReturnValue(60);
  vi.mocked(isAudioOnlyAsset).mockReturnValue(false);
  vi.mocked(getVideoTrackDurationSecondsFromAsset).mockReturnValue(60);
  vi.mocked(getVideoTrackMaxFrameRateFromAsset).mockReturnValue(30);

  // Credentials helpers — fail fast so workflows reject after asset resolution
  vi.mocked(resolveMuxSigningContext).mockResolvedValue(undefined);
  vi.mocked(resolveMuxClient).mockRejectedValue(new Error("mocked: no mux client"));

  // Downstream primitives — fail fast to avoid real network calls
  vi.mocked(fetchTranscriptForAsset).mockRejectedValue(new Error("mocked: no transcript"));
  vi.mocked(getReadyTextTracks).mockReturnValue([]);
  vi.mocked(getReliableLanguageCode).mockReturnValue(undefined);
  vi.mocked(getStoryboardUrl).mockRejectedValue(new Error("mocked: no storyboard"));
  vi.mocked(getHotspotsForAsset).mockRejectedValue(new Error("mocked: no hotspots"));
  vi.mocked(getHeatmapForAsset).mockRejectedValue(new Error("mocked: no heatmap"));
  vi.mocked(getShotsForAsset).mockRejectedValue(new Error("mocked: no shots"));
  vi.mocked(fetchVttFromMux).mockRejectedValue(new Error("mocked: no vtt"));
  vi.mocked(getThumbnailUrls).mockRejectedValue(new Error("mocked: no thumbnails"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs `fn` and asserts it eventually rejects (the downstream mocks are set up
 * to fail after asset resolution), then checks the spy calls.
 */
async function runAndAssertAssetResolution(
  fn: () => Promise<unknown>,
  { expectAssetObject }: { expectAssetObject: boolean },
) {
  await expect(fn()).rejects.toThrow();

  if (expectAssetObject) {
    expect(getPlaybackIdForAsset).not.toHaveBeenCalled();
    expect(toPlaybackAsset).toHaveBeenCalledWith(mockAsset);
  } else {
    expect(toPlaybackAsset).not.toHaveBeenCalled();
    expect(getPlaybackIdForAsset).toHaveBeenCalled();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getSummaryAndTags
// ─────────────────────────────────────────────────────────────────────────────

describe("getSummaryAndTags", () => {
  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => getSummaryAndTags(mockAsset),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => getSummaryAndTags("asset-abc"),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateChapters
// ─────────────────────────────────────────────────────────────────────────────

describe("generateChapters", () => {
  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => generateChapters(mockAsset),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => generateChapters("asset-abc"),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hasBurnedInCaptions
// ─────────────────────────────────────────────────────────────────────────────

describe("hasBurnedInCaptions", () => {
  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => hasBurnedInCaptions(mockAsset),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => hasBurnedInCaptions("asset-abc"),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getModerationScores
// ─────────────────────────────────────────────────────────────────────────────

describe("getModerationScores", () => {
  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => getModerationScores(mockAsset),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => getModerationScores("asset-abc"),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateEngagementInsights
// ─────────────────────────────────────────────────────────────────────────────

describe("generateEngagementInsights", () => {
  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => generateEngagementInsights(mockAsset),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => generateEngagementInsights("asset-abc"),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// editCaptions
// ─────────────────────────────────────────────────────────────────────────────

describe("editCaptions", () => {
  // replacements required to pass validation; uploadToMux: false skips S3 config check
  const editOptions = {
    replacements: [{ find: "foo", replace: "bar" }],
    uploadToMux: false as const,
  };

  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => editCaptions(mockAsset, "track-id", editOptions),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => editCaptions("asset-abc", "track-id", editOptions),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// askQuestions
// ─────────────────────────────────────────────────────────────────────────────

describe("askQuestions", () => {
  const questions = [{ question: "What is this video about?" }];

  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => askQuestions(mockAsset, questions),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => askQuestions("asset-abc", questions),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateEmbeddings
// ─────────────────────────────────────────────────────────────────────────────

describe("generateEmbeddings", () => {
  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => generateEmbeddings(mockAsset),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => generateEmbeddings("asset-abc"),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// translateAudio
// ─────────────────────────────────────────────────────────────────────────────

describe("translateAudio", () => {
  // uploadToMux: false skips S3 config validation
  const audioOptions = { uploadToMux: false as const };

  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => translateAudio(mockAsset, "es", audioOptions),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => translateAudio("asset-abc", "es", audioOptions),
      { expectAssetObject: false },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// translateCaptions
// ─────────────────────────────────────────────────────────────────────────────

describe("translateCaptions", () => {
  // uploadToMux: false skips S3 config validation
  const captionsOptions = { provider: "openai" as const, uploadToMux: false as const };

  it("calls toPlaybackAsset when given a MuxAsset object", async () => {
    await runAndAssertAssetResolution(
      () => translateCaptions(mockAsset, "track-id", "es", captionsOptions),
      { expectAssetObject: true },
    );
  });

  it("calls getPlaybackIdForAsset when given a string asset ID", async () => {
    await runAndAssertAssetResolution(
      () => translateCaptions("asset-abc", "track-id", "es", captionsOptions),
      { expectAssetObject: false },
    );
  });
});
