import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPresignedGetUrl,

  putObjectToS3,
} from "../../src/lib/s3-sigv4";
import type { PresignGetObjectOptions, PutObjectOptions } from "../../src/lib/s3-sigv4";

const FIXED_DATE = new Date("2024-06-07T08:09:10.000Z");

const baseTarget = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  endpoint: "https://storage.example.com/root/path/",
  region: "us-east-1",
  bucket: "my bucket",
  key: "folder/file (1).txt",
} as const;

function buildPresignOptions(overrides: Partial<PresignGetObjectOptions> = {}): PresignGetObjectOptions {
  return {
    ...baseTarget,
    ...overrides,
  };
}

function buildPutOptions(overrides: Partial<PutObjectOptions> = {}): PutObjectOptions {
  return {
    ...baseTarget,
    body: "hello world",
    ...overrides,
  };
}

describe("s3 sigv4 helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a presigned GET URL with encoded path and signing params", async () => {
    const url = await createPresignedGetUrl(buildPresignOptions());
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://storage.example.com");
    expect(parsed.pathname).toBe("/root/path/my%20bucket/folder/file%20%281%29.txt");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
      "AKIDEXAMPLE/20240607/us-east-1/s3/aws4_request",
    );
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20240607T080910Z");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("puts an object with sigv4 auth headers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);

    await putObjectToS3(buildPutOptions({ contentType: "text/plain" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe("https://storage.example.com/root/path/my%20bucket/folder/file%20%281%29.txt");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe("hello world");
    expect(init?.headers).toMatchObject({
      "content-type": "text/plain",
      "x-amz-date": "20240607T080910Z",
    });

    const authHeader = (init?.headers as Record<string, string>).Authorization;
    expect(authHeader).toContain("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20240607/us-east-1/s3/aws4_request");
    expect(authHeader).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(authHeader).toContain("Signature=");
  });

  it("omits content-type header when none is provided", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);

    await putObjectToS3(buildPutOptions({ body: new Uint8Array([1, 2, 3]), contentType: undefined }));

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toEqual(new Uint8Array([1, 2, 3]));
    const authHeader = (init?.headers as Record<string, string>).Authorization;
    expect((init?.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(authHeader).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  it("throws a detailed error when S3 PUT fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("AccessDenied", { status: 403, statusText: "Forbidden" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(putObjectToS3(buildPutOptions())).rejects.toThrow(
      "S3 PUT failed (403 Forbidden). AccessDenied",
    );
  });

  it("rejects invalid endpoints", async () => {
    await expect(createPresignedGetUrl(buildPresignOptions({ endpoint: "not-a-url" }))).rejects.toThrow(
      "Invalid S3 endpoint: not-a-url",
    );
    await expect(createPresignedGetUrl(buildPresignOptions({ endpoint: "http://storage.example.com" }))).rejects.toThrow(
      "Insecure S3 endpoint protocol \"http:\" is not allowed. Use HTTPS.",
    );
    await expect(createPresignedGetUrl(buildPresignOptions({ endpoint: "https://storage.example.com?x=1" }))).rejects.toThrow(
      "S3 endpoint must not include query params or hash fragments.",
    );
    await expect(createPresignedGetUrl(buildPresignOptions({ endpoint: "https://storage.example.com#frag" }))).rejects.toThrow(
      "S3 endpoint must not include query params or hash fragments.",
    );
  });
});
