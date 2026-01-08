import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { decryptFromWorkflow, encryptForWorkflow } from "../../src/lib/workflow-crypto";

describe("workflow crypto helpers", () => {
  it("round-trips encrypt/decrypt payloads", () => {
    const key = Buffer.alloc(32, 7);
    const payload = { muxTokenId: "id", muxTokenSecret: "secret", provider: "openai" };

    const encrypted = encryptForWorkflow(payload, key);
    const decrypted = decryptFromWorkflow<typeof payload>(encrypted, key);

    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong key", () => {
    const key = Buffer.alloc(32, 1);
    const wrongKey = Buffer.alloc(32, 2);

    const encrypted = encryptForWorkflow({ value: "secret" }, key);

    expect(() => decryptFromWorkflow(encrypted, wrongKey)).toThrow();
  });

  it("rejects malformed payloads", () => {
    const key = Buffer.alloc(32, 3);
    const malformed = {
      v: 1,
      alg: "aes-256-gcm",
      iv: "bad",
      tag: "bad",
      ciphertext: "bad",
    } as const;

    expect(() => decryptFromWorkflow(malformed, key)).toThrow();
  });

  describe("key ID (kid) support", () => {
    it("includes kid in payload when provided", () => {
      const key = Buffer.alloc(32, 4);
      const payload = { secret: "value" };

      const encrypted = encryptForWorkflow(payload, key, "key-2026-01");

      expect(encrypted.kid).toBe("key-2026-01");
    });

    it("omits kid from payload when not provided", () => {
      const key = Buffer.alloc(32, 5);
      const payload = { secret: "value" };

      const encrypted = encryptForWorkflow(payload, key);

      expect(encrypted.kid).toBeUndefined();
      expect("kid" in encrypted).toBe(false);
    });

    it("round-trips with kid intact", () => {
      const key = Buffer.alloc(32, 6);
      const payload = { muxTokenId: "id", muxTokenSecret: "secret" };

      const encrypted = encryptForWorkflow(payload, key, "rotation-key-v2");
      const decrypted = decryptFromWorkflow<typeof payload>(encrypted, key);

      expect(encrypted.kid).toBe("rotation-key-v2");
      expect(decrypted).toEqual(payload);
    });

    it("allows empty string as kid", () => {
      const key = Buffer.alloc(32, 8);
      const payload = { value: "test" };

      const encrypted = encryptForWorkflow(payload, key, "");

      expect(encrypted.kid).toBe("");
    });

    it("decrypts payloads without kid (backwards compatibility)", () => {
      const key = Buffer.alloc(32, 9);
      const payload = { legacy: "data" };

      // Simulate a legacy payload without kid
      const encrypted = encryptForWorkflow(payload, key);
      expect(encrypted.kid).toBeUndefined();

      const decrypted = decryptFromWorkflow<typeof payload>(encrypted, key);
      expect(decrypted).toEqual(payload);
    });
  });
});
