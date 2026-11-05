import { describe, expect, it } from "vitest";

import { createPresignedGetUrlWithStorageAdapter, putObjectWithStorageAdapter } from "../../src/lib/storage-adapter.ts";

const input = { endpoint: "https://s3.example.com", region: "auto", bucket: "dubs", key: "a/b.vtt", body: "WEBVTT", contentType: "text/vtt" };

describe("custom storage adapter failures", () => {
  it("classifies an AWS SDK-style server error as a transient storage failure", async () => {
    const adapter = {
      putObject: async () => {
        throw Object.assign(new Error("InternalError"), { $metadata: { httpStatusCode: 503 } });
      },
      createPresignedGetUrl: async () => "",
    };

    await expect(putObjectWithStorageAdapter(input, adapter)).rejects.toMatchObject({
      source: "upstream",
      dependency: "storage",
      facts: { call: "put_object", status: 503, bucket: "dubs" },
      transient: true,
    });
  });

  it("classifies a rejected presign as internal", async () => {
    const adapter = {
      putObject: async () => {},
      createPresignedGetUrl: async () => {
        throw Object.assign(new Error("AccessDenied"), { statusCode: 403 });
      },
    };

    await expect(createPresignedGetUrlWithStorageAdapter({ ...input, expiresInSeconds: 60 }, adapter)).rejects.toMatchObject({
      source: "internal",
      dependency: "storage",
      facts: { call: "presign_get_object", status: 403 },
      transient: false,
    });
  });
});
