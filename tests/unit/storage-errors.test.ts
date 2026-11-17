import { afterEach, describe, expect, it, vi } from "vitest";

import { MuxAiError } from "../../src/lib/mux-ai-error";
import { putObjectToS3 } from "../../src/lib/s3-sigv4";
import { putObjectWithStorageAdapter } from "../../src/lib/storage-adapter";
import { s3ErrorDetails } from "../../src/lib/storage-errors";
import { WorkflowStorageClient } from "../../src/lib/workflow-storage-client";

const target = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
  endpoint: "https://storage.example.com",
  region: "us-east-1",
  bucket: "bucket",
  key: "captions/a.vtt",
  body: "WEBVTT",
} as const;

function s3Error(code: string, status: number, statusText = "") {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>Something about https://bucket/key?X-Amz-Signature=abc</Message><RequestId>REQ123</RequestId></Error>`, { status, statusText });
}

async function putError(response: Response | Error) {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }));
  return putObjectToS3({ ...target, classifiedErrors: true }).catch(error => error as MuxAiError);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("s3ErrorDetails", () => {
  it("reads S3's code and request id, and only as tokens", () => {
    expect(s3ErrorDetails("<Error><Code>SlowDown</Code><RequestId>ABC-1</RequestId></Error>")).toEqual({ s3Code: "SlowDown", requestId: "ABC-1" });
    expect(s3ErrorDetails("<Error><Code>not a token</Code></Error>")).toEqual({});
    expect(s3ErrorDetails("Internal Server Error")).toEqual({});
  });
});

describe("classified S3 uploads", () => {
  it("leaves unmigrated callers' errors as they were", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => s3Error("AccessDenied", 403, "Forbidden")));
    const error = await putObjectToS3(target).catch(e => e);

    expect(MuxAiError.is(error)).toBe(false);
    expect(error).toBeInstanceOf(Error);
  });

  it("keeps rejected credentials the service's configuration, with S3's code", async () => {
    // The storage keys come from the service's environment, not the caller.
    expect(await putError(s3Error("AccessDenied", 403, "Forbidden"))).toMatchObject({
      code: "dependency_auth_rejected",
      source: "internal",
      dependency: "storage",
      transient: false,
      facts: { call: "put_object", status: 403, requestId: "REQ123", s3Code: "AccessDenied" },
    });
  });

  it("retries S3's throttling as a rate limit", async () => {
    expect(await putError(s3Error("SlowDown", 503))).toMatchObject({ code: "provider_rate_limited", type: "capacity_error", source: "upstream", transient: true });
  });

  it("retries a stalled upload, although S3 sends it as a 400", async () => {
    expect(await putError(s3Error("RequestTimeout", 400))).toMatchObject({ code: "dependency_timeout", type: "timeout_error", source: "upstream", transient: true, facts: { status: 400, s3Code: "RequestTimeout" } });
  });

  it("falls back to the status for a code without a rule", async () => {
    expect(await putError(s3Error("NoSuchBucket", 404))).toMatchObject({ code: "dependency_not_found", source: "internal", transient: false, facts: { s3Code: "NoSuchBucket" } });
    expect(await putError(s3Error("InternalError", 500))).toMatchObject({ code: "dependency_server_error", transient: true });
  });

  it("keeps S3's free text out of facts and message, and signed URL tokens out of the record", async () => {
    const error = await putError(s3Error("AccessDenied", 403, "Forbidden"));

    expect(JSON.stringify(error.facts)).not.toMatch(/Signature|Something about/);
    expect(error.message).toBe("S3 PUT failed (403 Forbidden).");
    expect(error.causes[0]?.message).toContain("Something about https://bucket/key?…");
    expect(JSON.stringify(error.causes)).not.toContain("X-Amz-Signature=abc");
  });

  it("retries an upload that got no response", async () => {
    expect(await putError(new TypeError("fetch failed"))).toMatchObject({ code: "dependency_no_response", source: "upstream", dependency: "storage", transient: true });
  });

  it("calls missing credentials the service's configuration", async () => {
    await expect(putObjectWithStorageAdapter({ ...target, accessKeyId: undefined }, undefined, { classifiedErrors: true }))
      .rejects
      .toMatchObject({ code: "storage_not_configured", source: "internal" });
    await expect(new WorkflowStorageClient({ classifiedErrors: true }).putObject({ ...target, accessKeyId: undefined, secretAccessKey: undefined }))
      .rejects
      .toMatchObject({ code: "storage_not_configured" });
  });

  it("opts in through the workflow storage client", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => s3Error("SlowDown", 503)));

    await expect(new WorkflowStorageClient({ classifiedErrors: true }).putObject(target)).rejects.toMatchObject({ code: "provider_rate_limited" });
    await expect(new WorkflowStorageClient().putObject(target)).rejects.not.toHaveProperty("code");
  });
});
