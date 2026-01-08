/**
 * Workflow Crypto
 *
 * Provides AES-256-GCM encryption for securely passing credentials to workflows.
 * Encrypted payloads are JSON-serializable and include version/algorithm metadata
 * for forward compatibility.
 */

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encryption parameters (AES-256-GCM with standard IV/tag sizes)
const WORKFLOW_ENCRYPTION_VERSION = 1;
const WORKFLOW_ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH_BYTES = 12; // 96-bit IV per NIST recommendation for GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 128-bit authentication tag

/**
 * Structure of an encrypted payload (all fields are base64-encoded where applicable).
 *
 * The optional `kid` (key ID) field supports key rotation scenarios:
 * - Include a `kid` when encrypting to identify which key was used
 * - On decryption, read `payload.kid` to look up the correct key
 * - Keys should be invalidated/deleted after rotation, not kept indefinitely
 *
 * Security notes:
 * - `kid` is stored in plaintext (not encrypted) — don't put sensitive data in it
 * - Tampering with `kid` doesn't weaken security — wrong key = decryption fails
 */
export interface EncryptedPayload {
  v: typeof WORKFLOW_ENCRYPTION_VERSION;
  alg: typeof WORKFLOW_ENCRYPTION_ALGORITHM;
  kid?: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Branded type that preserves the original type information for decryption */
export type Encrypted<T> = EncryptedPayload & { __type?: T };

/** Converts key to Buffer and validates it's exactly 32 bytes (256 bits) */
function normalizeKey(key: Buffer | string): Buffer {
  const keyBuffer = typeof key === "string" ? Buffer.from(key, "base64") : Buffer.from(key);

  if (keyBuffer.length !== 32) {
    throw new Error("Invalid workflow secret key. Expected 32-byte base64 value.");
  }

  return keyBuffer;
}

/** Decodes a base64 field from the payload with descriptive error messages */
function decodeBase64(value: string, label: string): Buffer {
  if (!value) {
    throw new Error(`Invalid encrypted payload: missing ${label}.`);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(value, "base64");
  } catch {
    throw new Error(`Invalid encrypted payload: ${label} is not base64.`);
  }

  if (buffer.length === 0) {
    throw new Error(`Invalid encrypted payload: ${label} is empty.`);
  }

  return buffer;
}

/** Type guard to check if a value is a valid encrypted payload structure */
export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as EncryptedPayload;
  return (
    payload.v === WORKFLOW_ENCRYPTION_VERSION &&
    payload.alg === WORKFLOW_ENCRYPTION_ALGORITHM &&
    typeof payload.iv === "string" &&
    typeof payload.tag === "string" &&
    typeof payload.ciphertext === "string"
  );
}

/** Validates payload structure and cryptographic parameters before decryption */
function assertEncryptedPayload(payload: EncryptedPayload): void {
  if (payload.v !== WORKFLOW_ENCRYPTION_VERSION) {
    throw new Error("Invalid encrypted payload: unsupported version.");
  }

  if (payload.alg !== WORKFLOW_ENCRYPTION_ALGORITHM) {
    throw new Error("Invalid encrypted payload: unsupported algorithm.");
  }

  const iv = decodeBase64(payload.iv, "iv");
  const tag = decodeBase64(payload.tag, "tag");

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error("Invalid encrypted payload: iv length mismatch.");
  }

  if (tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Invalid encrypted payload: tag length mismatch.");
  }

  decodeBase64(payload.ciphertext, "ciphertext");
}

/**
 * Encrypts a value for secure transport to a workflow.
 *
 * @param value - Any JSON-serializable value (typically WorkflowCredentials)
 * @param key - 32-byte secret key (base64 string or Buffer)
 * @param keyId - Optional key identifier for rotation support (stored in plaintext)
 * @returns Encrypted payload with metadata, safe to pass through untrusted channels
 *
 * @example
 * // Without key ID
 * const encrypted = encryptForWorkflow(credentials, secretKey);
 *
 * // With key ID for rotation support
 * const encrypted = encryptForWorkflow(credentials, secretKey, "key-2024-01");
 */
export function encryptForWorkflow<T>(
  value: T,
  key: Buffer | string,
  keyId?: string,
): Encrypted<T> {
  const keyBuffer = normalizeKey(key);
  const iv = randomBytes(IV_LENGTH_BYTES); // Fresh IV for each encryption

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Failed to serialize value for encryption.");
  }

  const cipher = createCipheriv(WORKFLOW_ENCRYPTION_ALGORITHM, keyBuffer, iv);
  const ciphertext = Buffer.concat([
    cipher.update(serialized, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // GCM auth tag for tamper detection

  return {
    v: WORKFLOW_ENCRYPTION_VERSION,
    alg: WORKFLOW_ENCRYPTION_ALGORITHM,
    ...(keyId !== undefined && { kid: keyId }),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypts and deserializes a workflow payload.
 *
 * @param payload - Encrypted payload from `encryptForWorkflow`
 * @param key - Same 32-byte secret key used for encryption
 * @returns The original decrypted value
 * @throws If payload is invalid, tampered with, or key is wrong
 *
 * @example
 * // With key rotation: read kid to look up the correct key
 * const keyId = payload.kid ?? "default";
 * const key = keyStore.get(keyId);
 * const credentials = decryptFromWorkflow(payload, key);
 */
export function decryptFromWorkflow<T>(payload: EncryptedPayload, key: Buffer | string): T {
  if (!isEncryptedPayload(payload)) {
    throw new Error("Invalid encrypted payload.");
  }

  assertEncryptedPayload(payload);

  const keyBuffer = normalizeKey(key);
  const iv = decodeBase64(payload.iv, "iv");
  const tag = decodeBase64(payload.tag, "tag");
  const ciphertext = decodeBase64(payload.ciphertext, "ciphertext");

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(WORKFLOW_ENCRYPTION_ALGORITHM, keyBuffer, iv);
    decipher.setAuthTag(tag); // Verifies integrity before returning plaintext
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Failed to decrypt workflow payload.");
  }

  try {
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new Error("Failed to parse decrypted payload.");
  }
}
