import env from "@mux/ai/env";

const AWS4_ALGORITHM = "AWS4-HMAC-SHA256";
const AWS4_REQUEST_TERMINATOR = "aws4_request";
const AWS4_SERVICE = "s3";

// Env flags for endpoint hardening.
// - S3_ALLOWED_ENDPOINT_HOSTS="s3.amazonaws.com,*.r2.cloudflarestorage.com"
//   restricts requests to explicit hostnames / wildcard suffixes.
const S3_ALLOWED_ENDPOINT_PATTERNS = parseEndpointAllowlist(
  env.S3_ALLOWED_ENDPOINT_HOSTS,
);

interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
}

export interface PutObjectOptions extends S3Target, S3Credentials {
  body: string | Uint8Array;
  contentType?: string;
}

export interface PresignGetObjectOptions extends S3Target, S3Credentials {
  expiresInSeconds?: number;
}

function getCrypto() {
  const webCrypto = globalThis.crypto as any;
  if (!webCrypto?.subtle) {
    throw new Error("Web Crypto API is required for S3 signing.");
  }

  return webCrypto;
}

const textEncoder = new TextEncoder();

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? textEncoder.encode(value) : value;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const digest = await getCrypto().subtle.digest("SHA-256", toBytes(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Raw(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await getCrypto().subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await getCrypto().subtle.sign("HMAC", cryptoKey, textEncoder.encode(value));
  return new Uint8Array(signature);
}

async function deriveSigningKey(
  secretAccessKey: string,
  shortDate: string,
  region: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256Raw(textEncoder.encode(`AWS4${secretAccessKey}`), shortDate);
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, AWS4_SERVICE);
  return hmacSha256Raw(kService, AWS4_REQUEST_TERMINATOR);
}

function formatAmzDate(date = new Date()): { amzDate: string; shortDate: string } {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  const shortDate = `${year}${month}${day}`;
  const amzDate = `${shortDate}T${hours}${minutes}${seconds}Z`;

  return { amzDate, shortDate };
}

function encodeRFC3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char: string) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(path: string): string {
  return path.split("/").map(segment => encodeRFC3986(segment)).join("/");
}

function normalizeEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid S3 endpoint: ${endpoint}`);
  }

  if (url.search || url.hash) {
    throw new Error("S3 endpoint must not include query params or hash fragments.");
  }

  enforceEndpointPolicy(url);

  return url;
}

function parseEndpointAllowlist(allowlist: string | undefined): string[] {
  if (!allowlist) {
    return [];
  }

  return allowlist
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }

  return hostname === pattern;
}

function enforceEndpointPolicy(url: URL): void {
  const hostname = url.hostname.toLowerCase();

  // Enforce secure transport for all S3 uploads/signing flows.
  if (url.protocol !== "https:") {
    throw new Error(
      `Insecure S3 endpoint protocol "${url.protocol}" is not allowed. Use HTTPS.`,
    );
  }

  // Optional allowlist enforcement to prevent exfiltration/SSRF-like endpoint misuse.
  // When unset, behavior remains backward compatible (any host allowed).
  if (
    S3_ALLOWED_ENDPOINT_PATTERNS.length > 0 &&
    !S3_ALLOWED_ENDPOINT_PATTERNS.some(pattern => hostnameMatchesPattern(hostname, pattern))
  ) {
    throw new Error(
      `S3 endpoint host "${hostname}" is not in S3_ALLOWED_ENDPOINT_HOSTS.`,
    );
  }
}

function buildCanonicalUri(endpoint: URL, bucket: string, key: string): string {
  const endpointPath =
    endpoint.pathname === "/" ? "" : encodePath(endpoint.pathname.replace(/\/+$/, ""));
  const encodedBucket = encodeRFC3986(bucket);
  const encodedKey = encodePath(key);

  return `${endpointPath}/${encodedBucket}/${encodedKey}`;
}

function buildCanonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeRFC3986(key)}=${encodeRFC3986(value)}`)
    .join("&");
}

async function signString(
  secretAccessKey: string,
  shortDate: string,
  region: string,
  value: string,
): Promise<string> {
  const signingKey = await deriveSigningKey(secretAccessKey, shortDate, region);
  const signatureBytes = await hmacSha256Raw(signingKey, value);
  return bytesToHex(signatureBytes);
}

function buildCredentialScope(shortDate: string, region: string): string {
  return `${shortDate}/${region}/${AWS4_SERVICE}/${AWS4_REQUEST_TERMINATOR}`;
}

export async function putObjectToS3({
  accessKeyId,
  secretAccessKey,
  endpoint,
  region,
  bucket,
  key,
  body,
  contentType,
}: PutObjectOptions): Promise<void> {
  const resolvedEndpoint = normalizeEndpoint(endpoint);
  const canonicalUri = buildCanonicalUri(resolvedEndpoint, bucket, key);
  const host = resolvedEndpoint.host;
  const { amzDate, shortDate } = formatAmzDate();
  const payloadHash = await sha256Hex(body);

  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = buildCredentialScope(shortDate, region);
  const stringToSign = [
    AWS4_ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = await signString(secretAccessKey, shortDate, region, stringToSign);
  const authorization = `${AWS4_ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const requestUrl = `${resolvedEndpoint.origin}${canonicalUri}`;

  const response = await fetch(requestUrl, {
    method: "PUT",
    headers: {
      "Authorization": authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body: typeof body === "string" ? body : body,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const detail = errorBody ? ` ${errorBody}` : "";
    throw new Error(`S3 PUT failed (${response.status} ${response.statusText}).${detail}`);
  }
}

export async function createPresignedGetUrl({
  accessKeyId,
  secretAccessKey,
  endpoint,
  region,
  bucket,
  key,
  expiresInSeconds = 3600,
}: PresignGetObjectOptions): Promise<string> {
  const resolvedEndpoint = normalizeEndpoint(endpoint);
  const canonicalUri = buildCanonicalUri(resolvedEndpoint, bucket, key);
  const host = resolvedEndpoint.host;
  const { amzDate, shortDate } = formatAmzDate();
  const credentialScope = buildCredentialScope(shortDate, region);
  const signedHeaders = "host";
  const queryParams = {
    "X-Amz-Algorithm": AWS4_ALGORITHM,
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": `${expiresInSeconds}`,
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = buildCanonicalQuery(queryParams);
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    AWS4_ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = await signString(secretAccessKey, shortDate, region, stringToSign);
  const queryWithSignature = `${canonicalQuery}&X-Amz-Signature=${signature}`;

  return `${resolvedEndpoint.origin}${canonicalUri}?${queryWithSignature}`;
}
