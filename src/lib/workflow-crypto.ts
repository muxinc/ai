/**
 * Workflow Crypto
 *
 * Provides AES-256-GCM encryption for securely passing credentials to workflows.
 * Encrypted payloads are JSON-serializable and include version/algorithm metadata
 * for forward compatibility.
 */

const BASE64_CHUNK_SIZE = 0x8000;
const BASE64_ALPHABET_RE = /^[A-Z0-9+/]+={0,2}$/i;

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

function getWebCrypto(): NonNullable<typeof globalThis.crypto> {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || !webCrypto.subtle || typeof webCrypto.getRandomValues !== "function") {
    throw new Error("Web Crypto API is required in workflow functions.");
  }
  return webCrypto;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  if (typeof globalThis.btoa !== "function") {
    throw new TypeError("Base64 encoder is not available in this environment.");
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(value: string, label: string): Uint8Array {
  if (!value) {
    throw new Error(`Invalid encrypted payload: missing ${label}.`);
  }
  const normalized = value.length % 4 === 0 ? value : value + "=".repeat(4 - (value.length % 4));
  if (!BASE64_ALPHABET_RE.test(normalized)) {
    throw new Error(`Invalid encrypted payload: ${label} is not base64.`);
  }
  if (typeof globalThis.atob !== "function") {
    throw new TypeError("Base64 decoder is not available in this environment.");
  }
  let binary: string;
  try {
    binary = globalThis.atob(normalized);
  } catch {
    throw new Error(`Invalid encrypted payload: ${label} is not base64.`);
  }
  if (!binary) {
    throw new Error(`Invalid encrypted payload: ${label} is empty.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Converts key to bytes and validates it's exactly 32 bytes (256 bits) */
function normalizeKey(key: Uint8Array | string): Uint8Array {
  let keyBytes: Uint8Array;
  if (typeof key === "string") {
    try {
      keyBytes = base64ToBytes(key, "key");
    } catch {
      throw new Error("Invalid workflow secret key. Expected 32-byte base64 value.");
    }
  } else {
    keyBytes = new Uint8Array(key);
  }

  if (keyBytes.length !== 32) {
    throw new Error("Invalid workflow secret key. Expected 32-byte base64 value.");
  }

  return keyBytes;
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

  const iv = base64ToBytes(payload.iv, "iv");
  const tag = base64ToBytes(payload.tag, "tag");

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error("Invalid encrypted payload: iv length mismatch.");
  }

  if (tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Invalid encrypted payload: tag length mismatch.");
  }

  base64ToBytes(payload.ciphertext, "ciphertext");
}

/**
 * Encrypts a value for secure transport to a workflow.
 *
 * @param value - Any JSON-serializable value (typically WorkflowCredentials)
 * @param key - 32-byte secret key (base64 string or Uint8Array)
 * @param keyId - Optional key identifier for rotation support (stored in plaintext)
 * @returns Encrypted payload with metadata, safe to pass through untrusted channels
 *
 * @example
 * // Without key ID
 * const encrypted = await encryptForWorkflow(credentials, secretKey);
 *
 * // With key ID for rotation support
 * const encrypted = await encryptForWorkflow(credentials, secretKey, "key-2024-01");
 */
export async function encryptForWorkflow<T>(
  value: T,
  key: Uint8Array | string,
  keyId?: string,
): Promise<Encrypted<T>> {
  const keyBytes = normalizeKey(key);
  const webCrypto = getWebCrypto();
  const iv = new Uint8Array(IV_LENGTH_BYTES);
  webCrypto.getRandomValues(iv); // Fresh IV for each encryption

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Failed to serialize value for encryption.");
  }

  const encoder = new TextEncoder();
  const plaintext = encoder.encode(serialized);
  const cryptoKey = await webCrypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const encrypted = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH_BYTES * 8 },
    cryptoKey,
    plaintext,
  );
  const encryptedBytes = new Uint8Array(encrypted);
  const tag = encryptedBytes.slice(encryptedBytes.length - AUTH_TAG_LENGTH_BYTES);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - AUTH_TAG_LENGTH_BYTES);

  return {
    v: WORKFLOW_ENCRYPTION_VERSION,
    alg: WORKFLOW_ENCRYPTION_ALGORITHM,
    ...(keyId !== undefined && { kid: keyId }),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
    ciphertext: bytesToBase64(ciphertext),
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
 * const credentials = await decryptFromWorkflow(payload, key);
 */
export async function decryptFromWorkflow<T>(
  payload: EncryptedPayload,
  key: Uint8Array | string,
): Promise<T> {
  if (!isEncryptedPayload(payload)) {
    throw new Error("Invalid encrypted payload.");
  }

  assertEncryptedPayload(payload);

  const keyBytes = normalizeKey(key);
  const iv = base64ToBytes(payload.iv, "iv");
  const tag = base64ToBytes(payload.tag, "tag");
  const ciphertext = base64ToBytes(payload.ciphertext, "ciphertext");

  const webCrypto = getWebCrypto();
  const cryptoKey = await webCrypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await webCrypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH_BYTES * 8 },
      cryptoKey,
      combined,
    );
  } catch {
    throw new Error("Failed to decrypt workflow payload.");
  }

  try {
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw new Error("Failed to parse decrypted payload.");
  }
}
