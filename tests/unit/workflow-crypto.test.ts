import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { decryptFromWorkflow, encryptForWorkflow } from "../../src/lib/workflow-crypto";

describe("workflow crypto helpers", () => {
  it("round-trips encrypt/decrypt payloads", async () => {
    const key = Buffer.alloc(32, 7);
    const payload = { muxTokenId: "id", muxTokenSecret: "secret", provider: "openai" };

    const encrypted = await encryptForWorkflow(payload, key);
    const decrypted = await decryptFromWorkflow<typeof payload>(encrypted, key);

    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = Buffer.alloc(32, 1);
    const wrongKey = Buffer.alloc(32, 2);

    const encrypted = await encryptForWorkflow({ value: "secret" }, key);

    await expect(decryptFromWorkflow(encrypted, wrongKey)).rejects.toThrow(
      "Failed to decrypt workflow payload.",
    );
  });

  it("rejects malformed payloads", async () => {
    const key = Buffer.alloc(32, 3);
    const malformed = {
      v: 1,
      alg: "aes-256-gcm",
      iv: "bad",
      tag: "bad",
      ciphertext: "bad",
    } as const;

    await expect(decryptFromWorkflow(malformed, key)).rejects.toThrow();
  });

  describe("secret key validation errors", () => {
    const validPayload = {
      v: 1 as const,
      alg: "aes-256-gcm" as const,
      iv: "AAAAAAAAAAAAAAAA", // 12 bytes
      tag: "AAAAAAAAAAAAAAAAAAAAAA==", // 16 bytes
      ciphertext: "AAAA",
    };

    it("rejects empty string key with clear error", async () => {
      await expect(encryptForWorkflow({ test: true }, "")).rejects.toThrow(
        "Invalid workflow secret key: value is missing. Expected 32-byte base64 value.",
      );
    });

    it("rejects invalid base64 key with clear error", async () => {
      await expect(encryptForWorkflow({ test: true }, "not-valid-base64!!!")).rejects.toThrow(
        "Invalid workflow secret key: value is not valid base64. Expected 32-byte base64 value.",
      );
    });

    it("rejects key that is too short with clear error", async () => {
      const shortKey = Buffer.alloc(16, 1).toString("base64"); // 16 bytes instead of 32

      await expect(encryptForWorkflow({ test: true }, shortKey)).rejects.toThrow(
        "Invalid workflow secret key: expected 32 bytes, got 16.",
      );
    });

    it("rejects key that is too long with clear error", async () => {
      const longKey = Buffer.alloc(64, 1).toString("base64"); // 64 bytes instead of 32

      await expect(encryptForWorkflow({ test: true }, longKey)).rejects.toThrow(
        "Invalid workflow secret key: expected 32 bytes, got 64.",
      );
    });

    it("rejects empty key on decrypt with clear error", async () => {
      await expect(decryptFromWorkflow(validPayload, "")).rejects.toThrow(
        "Invalid workflow secret key: value is missing. Expected 32-byte base64 value.",
      );
    });
  });

  describe("encrypted payload validation errors", () => {
    const validKey = Buffer.alloc(32, 1);

    it("rejects payload with missing iv", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "",
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: iv is missing",
      );
    });

    it("rejects payload with invalid base64 iv", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "not-valid!!!",
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: iv is not valid base64",
      );
    });

    it("rejects payload with wrong iv length", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "AAAA", // 3 bytes instead of 12
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: iv length mismatch.",
      );
    });

    it("rejects payload with missing tag", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "AAAAAAAAAAAAAAAA",
        tag: "",
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: tag is missing",
      );
    });

    it("rejects payload with invalid base64 tag", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "AAAAAAAAAAAAAAAA",
        tag: "!!!invalid!!!",
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: tag is not valid base64",
      );
    });

    it("rejects payload with wrong tag length", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "AAAAAAAAAAAAAAAA",
        tag: "AAAA", // 3 bytes instead of 16
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: tag length mismatch.",
      );
    });

    it("rejects payload with missing ciphertext", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "AAAAAAAAAAAAAAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: ciphertext is missing",
      );
    });

    it("rejects payload with invalid base64 ciphertext", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-256-gcm" as const,
        iv: "AAAAAAAAAAAAAAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "!!!bad!!!",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload: ciphertext is not valid base64",
      );
    });

    it("rejects payload with unsupported version", async () => {
      const payload = {
        v: 2 as unknown as 1,
        alg: "aes-256-gcm" as const,
        iv: "AAAAAAAAAAAAAAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload.",
      );
    });

    it("rejects payload with unsupported algorithm", async () => {
      const payload = {
        v: 1 as const,
        alg: "aes-128-gcm" as unknown as "aes-256-gcm",
        iv: "AAAAAAAAAAAAAAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        ciphertext: "AAAA",
      };

      await expect(decryptFromWorkflow(payload, validKey)).rejects.toThrow(
        "Invalid encrypted payload.",
      );
    });
  });

  describe("key ID (kid) support", () => {
    it("includes kid in payload when provided", async () => {
      const key = Buffer.alloc(32, 4);
      const payload = { secret: "value" };

      const encrypted = await encryptForWorkflow(payload, key, "key-2026-01");

      expect(encrypted.kid).toBe("key-2026-01");
    });

    it("omits kid from payload when not provided", async () => {
      const key = Buffer.alloc(32, 5);
      const payload = { secret: "value" };

      const encrypted = await encryptForWorkflow(payload, key);

      expect(encrypted.kid).toBeUndefined();
      expect("kid" in encrypted).toBe(false);
    });

    it("round-trips with kid intact", async () => {
      const key = Buffer.alloc(32, 6);
      const payload = { muxTokenId: "id", muxTokenSecret: "secret" };

      const encrypted = await encryptForWorkflow(payload, key, "rotation-key-v2");
      const decrypted = await decryptFromWorkflow<typeof payload>(encrypted, key);

      expect(encrypted.kid).toBe("rotation-key-v2");
      expect(decrypted).toEqual(payload);
    });

    it("allows empty string as kid", async () => {
      const key = Buffer.alloc(32, 8);
      const payload = { value: "test" };

      const encrypted = await encryptForWorkflow(payload, key, "");

      expect(encrypted.kid).toBe("");
    });

    it("decrypts payloads without kid (backwards compatibility)", async () => {
      const key = Buffer.alloc(32, 9);
      const payload = { legacy: "data" };

      // Simulate a legacy payload without kid
      const encrypted = await encryptForWorkflow(payload, key);
      expect(encrypted.kid).toBeUndefined();

      const decrypted = await decryptFromWorkflow<typeof payload>(encrypted, key);
      expect(decrypted).toEqual(payload);
    });
  });
});
