import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getShotsForAsset,
  requestShotsForAsset,
  waitForShotsForAsset,
} from "../../src/primitives/shots";

const MOCK_PENDING_RESPONSE = {
  data: {
    status: "pending" as const,
    created_at: "1773108428",
  },
};

const MOCK_ERRORED_RESPONSE = {
  data: {
    status: "errored" as const,
    created_at: "1773108428",
  },
};

const MOCK_COMPLETED_RESPONSE = {
  data: {
    status: "completed" as const,
    created_at: "1773108428",
    shot_locations: [
      {
        start_time: 0.0416667,
        image_url: "https://stream.mux.com/aicontext/test-asset/shot_0.webp?signature=first",
      },
      {
        start_time: 2.75,
        image_url: "https://stream.mux.com/aicontext/test-asset/shot_1.webp?signature=second",
      },
    ],
  },
};

vi.mock("../../src/lib/client-factory", () => ({
  getMuxClientFromEnv: vi.fn(),
}));

const mockMuxGet = vi.fn();
const mockMuxPost = vi.fn();
const mockCreateClient = vi.fn(() => ({
  get: mockMuxGet,
  post: mockMuxPost,
}));

const { getMuxClientFromEnv } = await import("../../src/lib/client-factory");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMuxClientFromEnv).mockResolvedValue({
    createClient: mockCreateClient,
  } as any);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestShotsForAsset", () => {
  it("returns transformed pending result", async () => {
    mockMuxPost.mockResolvedValue(MOCK_PENDING_RESPONSE);

    const result = await requestShotsForAsset("test-asset-123");

    expect(result).toEqual({
      status: "pending",
      createdAt: "1773108428",
    });
  });

  it("constructs the correct POST path and empty body", async () => {
    mockMuxPost.mockResolvedValue(MOCK_PENDING_RESPONSE);

    await requestShotsForAsset("test-asset-123");

    expect(mockMuxPost).toHaveBeenCalledWith(
      "/video/v1/assets/test-asset-123/shots",
      { body: {} },
    );
  });

  it("passes credentials through to the mux client factory", async () => {
    mockMuxPost.mockResolvedValue(MOCK_PENDING_RESPONSE);
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
    mockMuxGet.mockResolvedValue(MOCK_PENDING_RESPONSE);

    const result = await getShotsForAsset("test-asset-123");

    expect(result).toEqual({
      status: "pending",
      createdAt: "1773108428",
    });
  });

  it("returns transformed completed result", async () => {
    mockMuxGet.mockResolvedValue(MOCK_COMPLETED_RESPONSE);

    const result = await getShotsForAsset("test-asset-123");

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

  it("returns transformed errored result", async () => {
    mockMuxGet.mockResolvedValue(MOCK_ERRORED_RESPONSE);

    const result = await getShotsForAsset("test-asset-123");

    expect(result).toEqual({
      status: "errored",
      createdAt: "1773108428",
    });
  });

  it("constructs the correct GET path", async () => {
    mockMuxGet.mockResolvedValue(MOCK_PENDING_RESPONSE);

    await getShotsForAsset("test-asset-123");

    expect(mockMuxGet).toHaveBeenCalledWith(
      "/video/v1/assets/test-asset-123/shots",
    );
  });
});

describe("waitForShotsForAsset", () => {
  it("requests shots and polls until completed", async () => {
    vi.useFakeTimers();
    mockMuxPost.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockMuxGet
      .mockResolvedValueOnce(MOCK_PENDING_RESPONSE)
      .mockResolvedValueOnce(MOCK_COMPLETED_RESPONSE);

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

    expect(mockMuxPost).toHaveBeenCalledTimes(1);
    expect(mockMuxGet).toHaveBeenCalledTimes(2);
  });

  it("continues polling when shots were already requested previously", async () => {
    vi.useFakeTimers();
    mockMuxPost.mockRejectedValue({
      status: 400,
      error: {
        messages: ["Shots generation has already been requested"],
      },
      message: "400 invalid_parameters",
    });
    mockMuxGet.mockResolvedValue(MOCK_COMPLETED_RESPONSE);

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 100,
      maxAttempts: 3,
    });
    const expectation = expect(promise).resolves.toMatchObject({
      status: "completed",
    });

    await vi.runAllTimersAsync();
    await expectation;

    expect(mockMuxPost).toHaveBeenCalledTimes(1);
    expect(mockMuxGet).toHaveBeenCalledTimes(1);
  });

  it("can poll without creating a request first", async () => {
    vi.useFakeTimers();
    mockMuxGet.mockResolvedValue(MOCK_COMPLETED_RESPONSE);

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
    expect(mockMuxPost).not.toHaveBeenCalled();
    expect(mockMuxGet).toHaveBeenCalledTimes(1);
  });

  it("throws a timeout error when shots never complete", async () => {
    vi.useFakeTimers();
    mockMuxPost.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockMuxGet.mockResolvedValue(MOCK_PENDING_RESPONSE);

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 100,
      maxAttempts: 3,
    });
    const expectation = expect(promise).rejects.toThrow(
      "Timed out waiting for shots for asset 'test-asset-123' after 3 attempts. Last status: pending",
    );

    await vi.runAllTimersAsync();
    await expectation;
    expect(mockMuxGet).toHaveBeenCalledTimes(3);
  });

  it("throws immediately when shots enter an errored terminal state", async () => {
    vi.useFakeTimers();
    mockMuxPost.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockMuxGet.mockResolvedValue(MOCK_ERRORED_RESPONSE);

    const promise = waitForShotsForAsset("test-asset-123", {
      pollIntervalMs: 100,
      maxAttempts: 3,
    });
    const expectation = expect(promise).rejects.toThrow(
      "Shots generation errored for asset 'test-asset-123'",
    );

    await vi.runAllTimersAsync();
    await expectation;
    expect(mockMuxGet).toHaveBeenCalledTimes(1);
  });

  it("enforces a minimum poll interval when zero is provided", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mockMuxPost.mockResolvedValue(MOCK_PENDING_RESPONSE);
    mockMuxGet
      .mockResolvedValueOnce(MOCK_PENDING_RESPONSE)
      .mockResolvedValueOnce(MOCK_COMPLETED_RESPONSE);

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
  });
});
