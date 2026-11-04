import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadImageAsBase64 } from "../../src/lib/image-download";

const URL = "https://image.mux.com/playback/storyboard.png?token=secret";
const options = { retries: 1, retryDelay: 1, maxRetryDelay: 1 };

describe("downloadImageAsBase64", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails a 404 at once as an asset-side Mux error, without the signed URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await downloadImageAsBase64(URL, options).catch(e => e);
    expect(error).toMatchObject({
      name: "FatalError",
      type: "validation_error",
      source: "asset",
      dependency: "mux_video",
      transient: false,
      facts: { call: "fetch_image", status: 404, host: "image.mux.com" },
    });
    expect(JSON.stringify(error.facts)).not.toContain("secret");
    expect(error.message).not.toContain("secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a 503 transient after its own retries are spent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadImageAsBase64(URL, options)).rejects.toMatchObject({
      name: "Error",
      source: "upstream",
      dependency: "mux_video",
      transient: true,
      facts: { call: "fetch_image", status: 503 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a non-image response as an unusable upstream answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));

    await expect(downloadImageAsBase64(URL, options)).rejects.toMatchObject({
      type: "processing_error",
      source: "upstream",
      transient: false,
      facts: { call: "fetch_image", contentType: "text/html" },
    });
  });
});
