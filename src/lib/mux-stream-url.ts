import env from "@mux/ai/env";

const DEFAULT_MUX_STREAM_ORIGIN = "https://stream.mux.com";

function normalizeMuxStreamOrigin(value: string): string {
  const trimmed = value.trim();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Invalid MUX_STREAM_URL_OVERRIDE. Provide a hostname like " +
      `"stream.example.mux.com" (or a URL origin such as "https://stream.example.mux.com").`,
    );
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error(
      "Invalid MUX_STREAM_URL_OVERRIDE. Only a hostname/origin is allowed " +
      "(no credentials, query params, hash fragments, or path).",
    );
  }

  return parsed.origin;
}

export function getMuxStreamOrigin(): string {
  const override = env.MUX_STREAM_URL_OVERRIDE;
  if (!override) {
    return DEFAULT_MUX_STREAM_ORIGIN;
  }

  return normalizeMuxStreamOrigin(override);
}
