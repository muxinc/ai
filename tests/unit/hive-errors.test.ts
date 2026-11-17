import { describe, expect, it } from "vitest";

import { hiveCallError } from "../../src/lib/hive-errors";

describe("hiveCallError", () => {
  it.each([
    [405, { code: "provider_quota_exhausted", source: "internal", transient: false, retryable: false }],
    [403, { code: "provider_credentials_rejected", source: "internal", transient: false }],
    [429, { code: "provider_rate_limited", source: "upstream", transient: true }],
    [503, { code: "dependency_server_error", transient: true }],
    [400, { code: "dependency_request_rejected", source: "internal", transient: false }],
  ] as const)("reads Hive's %s", (status, expected) => {
    expect(hiveCallError("x", { call: "c", status })).toMatchObject({ ...expected, dependency: "ai_provider", facts: { call: "c", provider: "hive", status } });
  });

  it("codes a nonzero return_code as an answered error, keeping it as providerCode", () => {
    expect(hiveCallError("x", { call: "c", answered: true, returnCode: "4" })).toMatchObject({ code: "dependency_response_failed", transient: false, retryable: true, facts: { providerCode: "4" } });
    expect(hiveCallError("x", { call: "c", answered: true }).facts.providerCode).toBeUndefined();
  });

  it("codes no response and a timeout as transient", () => {
    expect(hiveCallError("x", { call: "c" })).toMatchObject({ code: "dependency_no_response", transient: true });
    expect(hiveCallError("x", { call: "c", timedOut: true })).toMatchObject({ code: "dependency_timeout", transient: true });
  });
});
