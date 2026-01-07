/* eslint-disable node/no-process-env */

import { z } from "zod";

import "dotenv/config";

function optionalString(description: string, message?: string) {
  return z.preprocess(
    value => typeof value === "string" && value.trim().length === 0 ? undefined : value,
    z.string().trim().min(1, message).optional(),
  ).describe(description);
}

function requiredString(description: string, message?: string) {
  return z.preprocess(
    value => typeof value === "string" ? value.trim().length > 0 ? value.trim() : undefined : value,
    z.string().trim().min(1, message),
  ).describe(description);
}

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development").describe("Runtime environment."),

  MUX_TOKEN_ID: requiredString("Mux access token ID.", "Required to access Mux APIs"),
  MUX_TOKEN_SECRET: requiredString("Mux access token secret.", "Required to access Mux APIs"),

  MUX_SIGNING_KEY: optionalString("Mux signing key ID for signed playback URLs.", "Used to sign playback URLs"),
  MUX_PRIVATE_KEY: optionalString("Mux signing private key for signed playback URLs.", "Used to sign playback URLs"),

  // Test-only helpers (used by this repo's integration tests)
  MUX_TEST_ASSET_ID: optionalString("Mux asset ID used by integration tests.", "Mux test asset id"),
  MUX_TEST_ASSET_ID_VIOLENT: optionalString("Mux violent asset ID used by integration tests.", "Mux violent test asset id"),
  MUX_TEST_ASSET_ID_BURNED_IN_CAPTIONS: optionalString(
    "Mux burned-in captions asset ID used by integration tests.",
    "Mux burned-in captions test asset id",
  ),
  MUX_TEST_ASSET_ID_AUDIO_ONLY: optionalString("Mux test asset ID for audio-only assets.", "Mux test asset id for audio-only assets for testing"),
  MUX_TEST_ASSET_ID_VIOLENT_AUDIO_ONLY: optionalString("Mux test asset ID for audio-only assets with violent content.", "Mux test asset id for audio-only assets with violent content for testing"),

  // AI Providers
  OPENAI_API_KEY: optionalString("OpenAI API key for OpenAI-backed workflows.", "OpenAI API key"),
  ANTHROPIC_API_KEY: optionalString("Anthropic API key for Claude-backed workflows.", "Anthropic API key"),
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString("Google Generative AI API key for Gemini-backed workflows.", "Google Generative AI API key"),

  ELEVENLABS_API_KEY: optionalString("ElevenLabs API key for audio translation.", "ElevenLabs API key"),
  HIVE_API_KEY: optionalString("Hive Visual Moderation API key.", "Hive API key"),

  // S3-Compatible Storage (required for translation & audio dubbing)
  S3_ENDPOINT: optionalString("S3-compatible endpoint for uploads.", "S3 endpoint"),
  S3_REGION: optionalString("S3 region (defaults to 'auto' when omitted)."),
  S3_BUCKET: optionalString("Bucket used for caption and audio uploads.", "S3 bucket"),
  S3_ACCESS_KEY_ID: optionalString("Access key ID for S3-compatible uploads.", "S3 access key id"),
  S3_SECRET_ACCESS_KEY: optionalString("Secret access key for S3-compatible uploads.", "S3 secret access key"),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsedEnv = EnvSchema.safeParse(process.env);

  if (!parsedEnv.success) {
    console.error("❌ Invalid env:");
    console.error(JSON.stringify(parsedEnv.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }

  return parsedEnv.data;
}

const env: Env = parseEnv();

export function reloadEnv(): Env {
  const parsed = parseEnv();
  Object.assign(env, parsed);
  return env;
}

export { env };
export default env;
