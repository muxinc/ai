import { describe, expect, it } from "vitest";

import { googleVisionCallError } from "../../src/lib/google-vision-errors";

describe("googleVisionCallError", () => {
  it.each([
    ["3", true, { code: "image_unprocessable", type: "validation_error", source: "asset", retryable: false }],
    // With a URL, Vision fetched the image itself: code 3 may be that fetch failing, not the image.
    ["3", false, { code: "dependency_response_failed", source: "upstream", transient: false, retryable: true }],
    ["14", false, { code: "provider_unavailable", source: "upstream", transient: true, retryable: true }],
    ["8", false, { code: "dependency_response_failed", transient: false, retryable: false }],
    ["13", false, { code: "dependency_response_failed", transient: false, retryable: true }],
  ] as const)("reads a per-image rpc code %s (inline: %s)", (rpcCode, inline, expected) => {
    expect(googleVisionCallError("x", { call: "c", answered: true, rpcCode, inline })).toMatchObject({ ...expected, facts: { provider: "google-vision-api", providerCode: rpcCode } });
  });

  it("codes a rejected request by its status", () => {
    expect(googleVisionCallError("x", { call: "c", status: 403 })).toMatchObject({ code: "dependency_auth_rejected", source: "internal", facts: { status: 403 } });
    expect(googleVisionCallError("x", { call: "c", status: 503 })).toMatchObject({ code: "dependency_server_error", transient: true });
  });
});
