import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getShotsForAsset,
  requestShotsForAsset,
  waitForShotsForAsset,
} from "../../src/primitives/shots";

const MOCK_PENDING_RESPONSE = {
  status: "pending" as const,
  created_at: "1773108428",
};

const MOCK_ERRORED_RESPONSE = {
  status: "errored" as const,
  created_at: "1773108428",
  errors: {
    type: "arbitrary string",
    messages: ["string", "array"],
  },
};

const MOCK_COMPLETED_RESPONSE = {
  status: "completed" as const,
  created_at: "1773108428",
  shots_manifest_url: "https://stream.mux.com/aicontext/test-asset/shots.json?signature=test",
};

const MOCK_SHOTS_MANIFEST = {
  shots: [
    {
      start_time: 0.0416667,
      shot_preview_image_url: "https://stream.mux.com/aicontext/test-asset/shot_0.webp?signature=first",
    },
    {
      start_time: 2.75,
      shot_preview_image_url: "https://stream.mux.com/aicontext/test-asset/shot_1.webp?signature=second",
    },
  ],
};

vi.mock("../../src/lib/client-factory", () => ({
  getMuxClientFromEnv: vi.fn(),
}));

const mockRetrieveShots = vi.fn();
const mockGenerateShots = vi.fn();
const mockFetch = vi.fn();
const mockCreateClient = vi.fn(() => ({
  video: { assets: { retrieveShots: mockRetrieveShots, generateShots: mockGenerateShots } },
}));

const { getMuxClientFromEnv } = await import("../../src/lib/client-factory");

beforeEach(() => {
  vi.resetAllMocks();
  mockCreateClient.mockImplementation(() => ({
    video: { assets: { retrieveShots: mockRetrieveShots, generateShots: mockGenerateShots } },
  }));
  vi.stubGlobal("fetch", mockFetch);
  vi.mocked(getMuxClientFromEnv).mockResolvedValue({
    createClient: mockCreateClient,
  } as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("requestShotsForAsset", () => {
  it("returns transformed pending result", async () => {
    mockGenerateShots.mockResolvedValue(MOCK_PENDING_RESPONSE);

    const result = await requestShotsForAsset("test-asset-123");

    expect(result).toEqual({
      status: "pending",
      createdAt: "1773108428",
    });
  });

  it("calls generateShots with the asset ID and an empty body", async () => {
    mockGenerateShots.mockResolvedValue(MOCK_PENDING_RESPONSE);

    await requestShotsForAsset("test-asset-123");

    expect(mockGenerateShots).toHaveBeenCalledWith("test-asset-123", {});
  });

  it("passes credentials through to the mux client factory", async () => {
    mockGenerateShots.mockResolvedValue(MOCK_PENDING_RESPONSE);
    const credentials = {
      muxTokenId: "token-id",
      muxTokenSecret: "token-secret",
    };

    await requestShotsForAsset("test-asset-123", { credentials });

    expect(getMuxClientFromEnv).toHaveBeenCalledWith(credentials);
  });
});

describe("getShotsForAsset", () => {
  it("returns transformed pending result", async () => {
    mockRetrieveShots.mockResolvedValue(MOCK_PENDING_RESPONSE);

    const result = await getShotsForAsset("test-asset-123");

    expect(result).toEqual({
      status: "pending",
      createdAt: "1773108428",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches and transforms completed shots from a manifest URL", async () => {
    mockRetrieveShots.mockResolvedValue(MOCK_COMPLETED_RESPONSE);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(MOCK_SHOTS_MANIFEST),
    });

    const result = await getShotsForAsset("test-asset-123");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://stream.mux.com/aicontext/test-asset/shots.json?signature=test",
    );
    expect(result).toEqual({
      status: "completed",
      createdAt: "1773108428",
      shots: [
        {
          startTime: 0.0416667,
          imageUrl: "https://stream.mux.com/aicontext/test-asset/shot_0.webp?signature=first",
        },
        {
          startTime: 2.75,
          imageUrl: "https://stream.mux.com/aicontext/test-asset/shot_1.webp?signature=second",
        },
      ],
    });
  });

  it("falls back to the deprecated image_url field with a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRetrieveShots.mockResolvedValue(MOCK_COMPLETED_RESPONSE);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        shots: [
          {
            start_time: 0.0416667,
            image_url: "https://stream.mux.com/aicontext/test-asset/shot_0.webp?signature=legacy",
          },
        ],
      }),
    });

    const result = await getShotsForAsset("test-asset-123");

    expect(result).toEqual({
      status: "completed",
      createdAt: "1773108428",
      shots: [
        {
          startTime: 0.0416667,
          imageUrl: "https://stream.mux.com/aicontext/test-asset/shot_0.webp?signature=legacy",
        },
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("image_url"));
  });

  it("returns transformed errored result", async () => {
    mockRetrieveShots.mockResolvedValue(MOCK_ERRORED_RESPONSE);

    const result = await getShotsForAsset("test-asset-123");

    expect(result).toEqual({
      status: "errored",
      createdAt: "1773108428",
      error: {
        type: "arbitrary string",
        messages: ["string", "array"],
      },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls retrieveShots with the asset ID", async () => {
    mockRetrieveShots.mockResolvedValue(MOCK_PENDING_RESPONSE);

    await getShotsForAsset("test-asset-123");

    expect(mockRetrieveShots).toHaveBeenCalledWith("test-asset-123");
  });

  it("throws a clear error for statuses this library does not handle", async () => {
    for (const status of ["skipped", "deleted"]) {
      mockRetrieveShots.mockResolvedValue({ status, created_at: "1773108428" });
      await expect(getShotsForAsset("test-asset-123")).rejects.toThrow(`Unsupported shots status '${status}'`);
    }
  });

  it("throws when a completed response has no manifest URL", async () => {
    mockRetrieveShots.mockResolvedValue({ status: "completed", created_at: "1773108428" });

    await expect(getShotsForAsset("test-asset-123")).rejects.toThrow("missing shots_manifest_url");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("waitForShotsForAsset", () => {
  it("requests shots and polls until completed", async () => {
    vi.useFakeTimers();
    mockGenerateShots.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockRetrieveShots
      .mockResolvedValueOnce(MOCK_PENDING_RESPONSE)
      .mockResolvedValueOnce(MOCK_COMPLETED_RESPONSE);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(MOCK_SHOTS_MANIFEST),
    });

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 100,
      maxAttempts: 5,
    });
    const expectation = expect(promise).resolves.toEqual({
      status: "completed",
      createdAt: "1773108428",
      shots: [
        {
          startTime: 0.0416667,
          imageUrl: "https://stream.mux.com/aicontext/test-asset/shot_0.webp?signature=first",
        },
        {
          startTime: 2.75,
          imageUrl: "https://stream.mux.com/aicontext/test-asset/shot_1.webp?signature=second",
        },
      ],
    });

    await vi.runAllTimersAsync();
    await expectation;

    expect(mockGenerateShots).toHaveBeenCalledTimes(1);
    expect(mockRetrieveShots).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("continues polling when shots were already requested previously", async () => {
    vi.useFakeTimers();
    mockGenerateShots.mockRejectedValue({
      status: 400,
      error: {
        error: {
          type: "invalid_parameters",
          messages: ["Shots generation has already been requested"],
        },
      },
      message: "400 invalid_parameters",
    });
    mockRetrieveShots.mockResolvedValue(MOCK_COMPLETED_RESPONSE);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(MOCK_SHOTS_MANIFEST),
    });

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 100,
      maxAttempts: 3,
    });
    const expectation = expect(promise).resolves.toMatchObject({
      status: "completed",
    });

    await vi.runAllTimersAsync();
    await expectation;

    expect(mockGenerateShots).toHaveBeenCalledTimes(1);
    expect(mockRetrieveShots).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("can poll without creating a request first", async () => {
    vi.useFakeTimers();
    mockRetrieveShots.mockResolvedValue(MOCK_COMPLETED_RESPONSE);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(MOCK_SHOTS_MANIFEST),
    });

    const promise = waitForShotsForAsset("test-asset-123", {
      createIfMissing: false,
      pollIntervalMs: 100,
      maxAttempts: 3,
    });
    const expectation = expect(promise).resolves.toMatchObject({
      status: "completed",
    });

    await vi.runAllTimersAsync();
    await expectation;
    expect(mockGenerateShots).not.toHaveBeenCalled();
    expect(mockRetrieveShots).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws a timeout error when shots never complete", async () => {
    vi.useFakeTimers();
    mockGenerateShots.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockRetrieveShots.mockResolvedValue(MOCK_PENDING_RESPONSE);

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 100,
      maxAttempts: 3,
    });
    const expectation = expect(promise).rejects.toThrow(
      "Timed out waiting for shots for asset test-asset-123. Last status: pending.",
    );

    await vi.runAllTimersAsync();
    await expectation;
    expect(mockRetrieveShots).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when shots enter an errored terminal state", async () => {
    vi.useFakeTimers();
    mockGenerateShots.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockRetrieveShots.mockResolvedValue(MOCK_ERRORED_RESPONSE);

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 100,
      maxAttempts: 3,
    });
    const expectation = expect(promise).rejects.toThrow(
      "Shot generation failed for asset test-asset-123.",
    );

    await vi.runAllTimersAsync();
    await expectation;
    expect(mockRetrieveShots).toHaveBeenCalledTimes(1);
  });

  it("enforces a minimum poll interval when zero is provided", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mockGenerateShots.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockRetrieveShots
      .mockResolvedValueOnce(MOCK_PENDING_RESPONSE)
      .mockResolvedValueOnce(MOCK_COMPLETED_RESPONSE);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(MOCK_SHOTS_MANIFEST),
    });

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 0,
      maxAttempts: 2,
    });
    const expectation = expect(promise).resolves.toMatchObject({
      status: "completed",
    });

    await vi.runAllTimersAsync();
    await expectation;

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
