/* eslint-disable node/no-process-env */

import { z } from "zod";

import "dotenv/config";

function optionalString(description: string, message?: string) {
  return z.preprocess(
    value => typeof value === "string" && value.trim().length === 0 ? undefined : value,
    z.string().trim().min(1, message).optional(),
  ).describe(description);
}

// eslint-disable-next-line unused-imports/no-unused-vars
function requiredString(description: string, message?: string) {
  return z.preprocess(
    value => typeof value === "string" ? value.trim().length > 0 ? value.trim() : undefined : value,
    z.string().trim().min(1, message),
  ).describe(description);
}

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development").describe("Runtime environment."),

  MUX_TOKEN_ID: optionalString("Mux access token ID.", "Required to access Mux APIs"),
  MUX_TOKEN_SECRET: optionalString("Mux access token secret.", "Required to access Mux APIs"),
  MUX_AI_WORKFLOW_SECRET_KEY: optionalString(
    "Base64-encoded 32-byte key for workflow encryption/decryption.",
    "Workflow secret key",
  ),
  EVALITE_INGEST_SECRET: optionalString(
    "Shared secret for posting Evalite results.",
    "Evalite ingest secret",
  ),

  MUX_SIGNING_KEY: optionalString("Mux signing key ID for signed playback URLs.", "Used to sign playback URLs"),
  MUX_PRIVATE_KEY: optionalString("Mux signing private key for signed playback URLs.", "Used to sign playback URLs"),
  MUX_IMAGE_URL_OVERRIDE: optionalString(
    "Override for Mux image base URL (defaults to https://image.mux.com).",
    "Mux image URL override",
  ),

  // Test-only helpers (used by this repo's integration tests)
  MUX_TEST_ASSET_ID: optionalString("Mux asset ID used by integration tests.", "Mux test asset id"),
  MUX_TEST_ASSET_ID_CHAPTERS: optionalString("Mux asset ID used by integration tests for chapters.", "Mux test asset id for chapters"),
  MUX_TEST_ASSET_ID_VIOLENT: optionalString("Mux violent asset ID used by integration tests.", "Mux violent test asset id"),
  MUX_TEST_ASSET_ID_BURNED_IN_CAPTIONS: optionalString(
    "Mux burned-in captions asset ID used by integration tests.",
    "Mux burned-in captions test asset id",
  ),
  MUX_TEST_ASSET_ID_BURNED_IN_CAPTIONS_2: optionalString(
    "Mux burned-in captions asset ID 2 (a different asset) used by integration tests.",
    "Mux burned-in captions test asset id 2 (a different asset)",
  ),
  MUX_TEST_ASSET_ID_WITHOUT_BURNED_IN_CAPTIONS: optionalString(
    "Mux without burned-in captions asset ID used by integration tests.",
    "Mux without burned-in captions test asset id",
  ),
  MUX_TEST_ASSET_ID_AUDIO_ONLY: optionalString("Mux test asset ID for audio-only assets.", "Mux test asset id for audio-only assets for testing"),
  MUX_TEST_ASSET_ID_VIOLENT_AUDIO_ONLY: optionalString("Mux test asset ID for audio-only assets with violent content.", "Mux test asset id for audio-only assets with violent content for testing"),

  // Eval config
  MUX_AI_EVAL_MODEL_SET: optionalString("Eval model selection mode.", "Choose between 'default' (provider defaults only) or 'all' (all configured models)"),
  MUX_AI_EVAL_MODELS: optionalString("Comma-separated eval model pairs.", "Comma-separated provider:model pairs (e.g. 'openai:gpt-5.1,anthropic:claude-sonnet-4-5,google:gemini-3-flash-preview')"),

  // AI Providers
  OPENAI_API_KEY: optionalString("OpenAI API key for OpenAI-backed workflows.", "OpenAI API key"),
  ANTHROPIC_API_KEY: optionalString("Anthropic API key for Claude-backed workflows.", "Anthropic API key"),
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString("Google Generative AI API key for Gemini-backed workflows.", "Google Generative AI API key"),
  AI_GATEWAY_API_KEY: optionalString("Vercel AI Gateway API key for Gateway-backed workflows.", "Vercel AI Gateway API key"),

  ELEVENLABS_API_KEY: optionalString("ElevenLabs API key for audio translation.", "ElevenLabs API key"),
  HIVE_API_KEY: optionalString("Hive Visual Moderation API key.", "Hive API key"),

  // S3-Compatible Storage (required for translation & audio dubbing)
  S3_ENDPOINT: optionalString("S3-compatible endpoint for uploads.", "S3 endpoint"),
  S3_REGION: optionalString("S3 region (defaults to 'auto' when omitted)."),
  S3_BUCKET: optionalString("Bucket used for caption and audio uploads.", "S3 bucket"),
  S3_ACCESS_KEY_ID: optionalString("Access key ID for S3-compatible uploads.", "S3 access key id"),
  S3_SECRET_ACCESS_KEY: optionalString("Secret access key for S3-compatible uploads.", "S3 secret access key"),
  S3_ALLOWED_ENDPOINT_HOSTS: optionalString(
    "Comma-separated S3 endpoint allowlist (supports exact hosts and *.suffix patterns).",
  ),

  EVALITE_RESULTS_ENDPOINT: optionalString(
    "Full URL for posting Evalite results (e.g., https://example.com/api/evalite-results).",
    "Evalite results endpoint",
  ),
}).refine(
  (env) => {
    const hasMuxCredentials = Boolean(env.MUX_TOKEN_ID && env.MUX_TOKEN_SECRET);
    const hasWorkflowKey = Boolean(env.MUX_AI_WORKFLOW_SECRET_KEY);
    return hasMuxCredentials || hasWorkflowKey;
  },
  {
    message: "Either MUX_TOKEN_ID + MUX_TOKEN_SECRET or MUX_AI_WORKFLOW_SECRET_KEY must be set.",
  },
);

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
