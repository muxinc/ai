import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WORKFLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

function stubBaseEnv() {
  vi.stubEnv("MUX_TOKEN_ID", "test-token-id");
  vi.stubEnv("MUX_TOKEN_SECRET", "test-token-secret");
  vi.stubEnv("MUX_AI_WORKFLOW_SECRET_KEY", "");
  vi.stubEnv("MUX_CUSTOM_DOMAIN", "");
  vi.stubEnv("MUX_IMAGE_URL_OVERRIDE", "");
  vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "");
}

async function importMuxUrl() {
  return import("../../src/lib/mux-url");
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  stubBaseEnv();
});

afterEach(async () => {
  const { setWorkflowCredentialsProvider } = await import("../../src/lib/workflow-credentials");
  setWorkflowCredentialsProvider(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getMuxPlaybackOrigin", () => {
  it("defaults to mux.com", async () => {
    const { getMuxPlaybackOrigin } = await importMuxUrl();
    expect(getMuxPlaybackOrigin("image")).toBe("https://image.mux.com");
    expect(getMuxPlaybackOrigin("stream")).toBe("https://stream.mux.com");
  });

  it("expands a custom domain the same way Mux Player does", async () => {
    const { getMuxPlaybackOrigin } = await importMuxUrl();
    expect(getMuxPlaybackOrigin("image", "media.example.com")).toBe("https://image.media.example.com");
    expect(getMuxPlaybackOrigin("stream", " Media.Example.com ")).toBe("https://stream.media.example.com");
  });

  it.each([
    ["an empty value", "  "],
    ["a scheme", "https://media.example.com"],
    ["a port", "media.example.com:8443"],
    ["a path", "media.example.com/v1"],
    ["query params", "media.example.com?foo=bar"],
    ["a hash fragment", "media.example.com#frag"],
    ["credentials", "user:pass@media.example.com"],
  ])("rejects a domain with %s", async (_label, domain) => {
    const { getMuxPlaybackOrigin } = await importMuxUrl();
    expect(() => getMuxPlaybackOrigin("image", domain)).toThrow(/Provide a bare hostname/);
  });
});

describe("playback origin resolution", () => {
  it("defaults to mux.com when nothing is configured", async () => {
    const { getMuxImageOrigin, getMuxStreamOrigin } = await importMuxUrl();
    await expect(getMuxImageOrigin()).resolves.toBe("https://image.mux.com");
    await expect(getMuxStreamOrigin()).resolves.toBe("https://stream.mux.com");
  });

  it("uses MUX_CUSTOM_DOMAIN for both hosts", async () => {
    vi.stubEnv("MUX_CUSTOM_DOMAIN", "staging.mux.com");
    const { getMuxImageOrigin, getMuxStreamOrigin } = await importMuxUrl();
    await expect(getMuxImageOrigin()).resolves.toBe("https://image.staging.mux.com");
    await expect(getMuxStreamOrigin()).resolves.toBe("https://stream.staging.mux.com");
  });

  it("rejects an invalid MUX_CUSTOM_DOMAIN", async () => {
    vi.stubEnv("MUX_CUSTOM_DOMAIN", "https://staging.mux.com");
    const { getMuxImageOrigin } = await importMuxUrl();
    await expect(getMuxImageOrigin()).rejects.toThrow(/Invalid MUX_CUSTOM_DOMAIN/);
  });

  it("prefers a per-host legacy override over MUX_CUSTOM_DOMAIN, per host", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MUX_CUSTOM_DOMAIN", "staging.mux.com");
    vi.stubEnv("MUX_IMAGE_URL_OVERRIDE", "image.legacy.mux.com");
    const { getMuxImageOrigin, getMuxStreamOrigin } = await importMuxUrl();
    await expect(getMuxImageOrigin()).resolves.toBe("https://image.legacy.mux.com");
    await expect(getMuxStreamOrigin()).resolves.toBe("https://stream.staging.mux.com");
  });

  it("prefers muxCustomDomain from credentials over every env setting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MUX_CUSTOM_DOMAIN", "staging.mux.com");
    vi.stubEnv("MUX_IMAGE_URL_OVERRIDE", "image.legacy.mux.com");
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "stream.legacy.mux.com");
    const { getMuxImageOrigin, getMuxStreamOrigin } = await importMuxUrl();
    const credentials = { muxCustomDomain: "media.example.com" };
    await expect(getMuxImageOrigin(credentials)).resolves.toBe("https://image.media.example.com");
    await expect(getMuxStreamOrigin(credentials)).resolves.toBe("https://stream.media.example.com");
  });

  it("uses muxCustomDomain from the credentials provider", async () => {
    const { setWorkflowCredentialsProvider } = await import("../../src/lib/workflow-credentials");
    setWorkflowCredentialsProvider(() => ({ muxCustomDomain: "provider.example.com" }));
    const { getMuxImageOrigin } = await importMuxUrl();
    await expect(getMuxImageOrigin()).resolves.toBe("https://image.provider.example.com");
  });

  it("prefers direct credentials over the credentials provider", async () => {
    const { setWorkflowCredentialsProvider } = await import("../../src/lib/workflow-credentials");
    setWorkflowCredentialsProvider(() => ({ muxCustomDomain: "provider.example.com" }));
    const { getMuxImageOrigin } = await importMuxUrl();
    await expect(getMuxImageOrigin({ muxCustomDomain: "direct.example.com" }))
      .resolves
      .toBe("https://image.direct.example.com");
  });

  it("reads muxCustomDomain from encrypted credentials", async () => {
    vi.stubEnv("MUX_AI_WORKFLOW_SECRET_KEY", TEST_WORKFLOW_SECRET_KEY);
    const { encryptForWorkflow } = await import("../../src/lib/workflow-crypto");
    const { getMuxStreamOrigin } = await importMuxUrl();
    const encrypted = await encryptForWorkflow({ muxCustomDomain: "media.example.com" }, TEST_WORKFLOW_SECRET_KEY);
    await expect(getMuxStreamOrigin(encrypted)).resolves.toBe("https://stream.media.example.com");
  });

  it("resolves different domains for concurrent requests", async () => {
    const { getMuxImageOrigin } = await importMuxUrl();
    const origins = await Promise.all([
      getMuxImageOrigin({ muxCustomDomain: "a.example.com" }),
      getMuxImageOrigin({ muxCustomDomain: "b.example.com" }),
      getMuxImageOrigin(),
    ]);
    expect(origins).toEqual([
      "https://image.a.example.com",
      "https://image.b.example.com",
      "https://image.mux.com",
    ]);
  });

  it("rejects an invalid muxCustomDomain", async () => {
    const { getMuxImageOrigin } = await importMuxUrl();
    await expect(getMuxImageOrigin({ muxCustomDomain: "media.example.com/v1" }))
      .rejects
      .toThrow(/Invalid muxCustomDomain/);
  });
});

describe("legacy MUX_STREAM_URL_OVERRIDE", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("accepts a bare hostname", async () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "stream.example.mux.com");
    const { getMuxStreamOrigin } = await importMuxUrl();
    await expect(getMuxStreamOrigin()).resolves.toBe("https://stream.example.mux.com");
  });

  it("accepts a full origin with scheme", async () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "https://stream.example.mux.com");
    const { getMuxStreamOrigin } = await importMuxUrl();
    await expect(getMuxStreamOrigin()).resolves.toBe("https://stream.example.mux.com");
  });

  it.each([
    ["a path", "https://stream.example.mux.com/v1"],
    ["query params", "https://stream.example.mux.com?foo=bar"],
    ["credentials", "https://user:pass@stream.example.mux.com"],
  ])("rejects an override that includes %s", async (_label, value) => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", value);
    const { getMuxStreamOrigin } = await importMuxUrl();
    await expect(getMuxStreamOrigin()).rejects.toThrow(/Only a hostname\/origin is allowed/);
  });

  it("rejects an unparseable override", async () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "not a url :::");
    const { getMuxStreamOrigin } = await importMuxUrl();
    await expect(getMuxStreamOrigin()).rejects.toThrow(/Provide a hostname/);
  });
});

describe("legacy override deprecation warning", () => {
  it("warns once at startup, not on reload or per invocation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MUX_IMAGE_URL_OVERRIDE", "image.staging.mux.com");
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "stream.staging.mux.com");

    const { reloadEnv } = await import("../../src/env");
    const { getMuxImageOrigin, getMuxStreamOrigin } = await importMuxUrl();
    reloadEnv();
    await getMuxImageOrigin();
    await getMuxStreamOrigin();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/MUX_CUSTOM_DOMAIN/);
  });

  it("stays silent when only MUX_CUSTOM_DOMAIN is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MUX_CUSTOM_DOMAIN", "staging.mux.com");

    await import("../../src/env");

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("buildTranscriptUrl", () => {
  it("uses the default stream origin when nothing is configured", async () => {
    const { buildTranscriptUrl } = await import("../../src/primitives/transcripts");
    await expect(buildTranscriptUrl("playback-id", "track-id", false))
      .resolves
      .toBe("https://stream.mux.com/playback-id/text/track-id.vtt");
  });

  it("uses muxCustomDomain from credentials for the transcript host", async () => {
    const { buildTranscriptUrl } = await import("../../src/primitives/transcripts");
    await expect(buildTranscriptUrl("playback-id", "track-id", false, { muxCustomDomain: "media.example.com" }))
      .resolves
      .toBe("https://stream.media.example.com/playback-id/text/track-id.vtt");
  });
});
