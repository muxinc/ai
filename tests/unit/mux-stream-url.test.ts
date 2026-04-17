import { afterEach, describe, expect, it, vi } from "vitest";

import { reloadEnv } from "../../src/env";
import { getMuxStreamOrigin } from "../../src/lib/mux-stream-url";
import { buildTranscriptUrl } from "../../src/primitives/transcripts";

describe("getMuxStreamOrigin", () => {
  afterEach(() => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "");
    reloadEnv();
    vi.unstubAllEnvs();
  });

  it("returns the default stream origin when no override is set", () => {
    expect(getMuxStreamOrigin()).toBe("https://stream.mux.com");
  });

  it("uses MUX_STREAM_URL_OVERRIDE when configured with a bare hostname", () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "stream.example.mux.com");
    reloadEnv();
    expect(getMuxStreamOrigin()).toBe("https://stream.example.mux.com");
  });

  it("accepts a full origin with scheme", () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "https://stream.example.mux.com");
    reloadEnv();
    expect(getMuxStreamOrigin()).toBe("https://stream.example.mux.com");
  });

  it("rejects an override that includes a path", () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "https://stream.example.mux.com/v1");
    reloadEnv();
    expect(() => getMuxStreamOrigin()).toThrow(/Only a hostname\/origin is allowed/);
  });

  it("rejects an override that includes query params", () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "https://stream.example.mux.com?foo=bar");
    reloadEnv();
    expect(() => getMuxStreamOrigin()).toThrow(/Only a hostname\/origin is allowed/);
  });

  it("rejects an override that includes credentials", () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "https://user:pass@stream.example.mux.com");
    reloadEnv();
    expect(() => getMuxStreamOrigin()).toThrow(/Only a hostname\/origin is allowed/);
  });

  it("rejects an unparseable override", () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "not a url :::");
    reloadEnv();
    expect(() => getMuxStreamOrigin()).toThrow(/Provide a hostname/);
  });
});

describe("buildTranscriptUrl with MUX_STREAM_URL_OVERRIDE", () => {
  afterEach(() => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "");
    reloadEnv();
    vi.unstubAllEnvs();
  });

  it("uses the default stream origin when no override is set", async () => {
    const url = await buildTranscriptUrl("playback-id", "track-id", false);
    expect(url).toBe("https://stream.mux.com/playback-id/text/track-id.vtt");
  });

  it("uses MUX_STREAM_URL_OVERRIDE for the transcript host when configured", async () => {
    vi.stubEnv("MUX_STREAM_URL_OVERRIDE", "stream.example.mux.com");
    reloadEnv();
    const url = await buildTranscriptUrl("playback-id", "track-id", false);
    expect(url).toBe("https://stream.example.mux.com/playback-id/text/track-id.vtt");
  });
});
