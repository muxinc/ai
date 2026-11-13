import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadImageAsBase64 } from "../../src/lib/image-download";
import { MuxAiError } from "../../src/lib/mux-ai-error";

const SIGNED_URL = "https://image.mux.com/playback-123/storyboard.jpg?token=secret-token";
const NO_RETRIES = { retries: 0 };
const CLASSIFIED = { classifiedErrors: true, call: "fetch_storyboard" };

function stubFetch(response: Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }));
}

describe("downloadImageAsBase64", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the image as a data URI", async () => {
    stubFetch(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }));

    await expect(downloadImageAsBase64(SIGNED_URL, NO_RETRIES, CLASSIFIED)).resolves.toMatchObject({
      base64Data: "data:image/jpeg;base64,AQID",
      sizeBytes: 3,
    });
  });

  it("keeps throwing plain errors without the opt-in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(new Response("missing", { status: 404, statusText: "Not Found" }));

    const error = await downloadImageAsBase64(SIGNED_URL, NO_RETRIES).catch(e => e);

    expect(MuxAiError.is(error)).toBe(false);
    expect(error.message).toBe("HTTP 404: Not Found");
  });

  it("classifies an HTTP failure as Mux Video's, with the status and no URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(new Response("missing", { status: 404, headers: { "x-request-id": "req-1" } }));

    const error = await downloadImageAsBase64(SIGNED_URL, NO_RETRIES, CLASSIFIED).catch(e => e);

    expect(error).toMatchObject({
      source: "asset",
      dependency: "mux_video",
      transient: false,
      facts: { call: "fetch_storyboard", status: 404, requestId: "req-1" },
    });
    expect(JSON.stringify({ message: error.message, facts: error.facts })).not.toContain("secret-token");
  });

  it("classifies a 5xx that outlasted the download's retries as transient", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(new Response("down", { status: 503 }));

    await expect(downloadImageAsBase64(SIGNED_URL, NO_RETRIES, CLASSIFIED)).rejects.toMatchObject({
      source: "upstream",
      dependency: "mux_video",
      transient: true,
      facts: { call: "fetch_storyboard", status: 503 },
    });
  });

  it("classifies a network failure as no response, so transient", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(new TypeError("fetch failed"));

    await expect(downloadImageAsBase64(SIGNED_URL, NO_RETRIES, CLASSIFIED)).rejects.toMatchObject({
      source: "upstream",
      dependency: "mux_video",
      transient: true,
      facts: { call: "fetch_storyboard" },
    });
  });

  it.each([
    ["not_image", new Response("<html></html>", { headers: { "content-type": "text/html" } }), { contentType: "text/html" }],
    ["empty", new Response(new Uint8Array(), { headers: { "content-type": "image/jpeg" } }), {}],
  ] as const)("codes a %s response as image_response_invalid", async (reason, response, facts) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(response);

    await expect(downloadImageAsBase64(SIGNED_URL, NO_RETRIES, CLASSIFIED)).rejects.toMatchObject({
      code: "image_response_invalid",
      source: "upstream",
      dependency: "mux_video",
      transient: false,
      retryable: true,
      facts: { call: "fetch_storyboard", reason, ...facts },
    });
  });
});
