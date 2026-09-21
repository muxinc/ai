/**
 * Verifies the model claims in docs/VISION-MODELS.md against live endpoints.
 *
 * For each model, sends a storyboard image by URL with schema-constrained
 * output through the same provider factory the workflows use, so a pass here
 * means the model satisfies both requirements documented in VISION-MODELS.md
 * (image_url input and response_format: json_schema).
 *
 * Usage:
 *   npx tsx scripts/verify-vision-models.ts                          # Baseten Model APIs vision models
 *   npx tsx scripts/verify-vision-models.ts -m "moonshotai/Kimi-K3"  # specific models
 *   npx tsx scripts/verify-vision-models.ts -p openai-compatible -m "mistral-small-latest"
 *
 * Requires BASETEN_API_KEY (or OPENAI_COMPATIBLE_BASE_URL / _API_KEY when
 * -p openai-compatible is used).
 */
import { generateText, Output } from "ai";
import { Command } from "commander";
import { z } from "zod";

import type { SupportedProvider } from "../src/lib/providers";

import "dotenv/config";

// src/env.ts exits at import time unless Mux credentials are configured.
// This script never calls Mux APIs, so satisfy that check with placeholders
// instead of requiring unrelated credentials.

process.env.MUX_TOKEN_ID ??= "unused-by-verify-vision-models";
process.env.MUX_TOKEN_SECRET ??= "unused-by-verify-vision-models";

const { createLanguageModelFromConfig } = await import("../src/lib/providers");

const BASETEN_MODEL_APIS_VISION_MODELS = [
  "moonshotai/Kimi-K3",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.7-Code",
];

// Public Mux demo asset; override with --image-url.
const DEFAULT_IMAGE_URL = "https://image.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/storyboard.png?width=640";

const descriptionSchema = z.object({
  title: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
});

interface VerificationResult {
  model: string;
  ok: boolean;
  attemptsUsed: number;
  latencyMs?: number;
  title?: string;
  error?: string;
}

async function verifyModel(
  provider: SupportedProvider,
  modelId: string,
  imageUrl: string,
  attempts: number,
): Promise<VerificationResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    try {
      const model = await createLanguageModelFromConfig(provider, modelId);
      const response = await generateText({
        model,
        output: Output.object({
          name: "storyboard_metadata",
          description: "Structured metadata describing the storyboard image.",
          schema: descriptionSchema,
        }),
        messages: [
          {
            role: "system",
            content: "You are a video content analyst. You receive storyboard images containing sequential frames from a video. Output only the JSON object; no markdown or extra text.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze the storyboard frames and generate metadata: a title (max 10 words), a description of what is visible across the frames (max 50 words), and up to 10 keywords.",
              },
              { type: "image", image: imageUrl },
            ],
          },
        ],
      });

      const output = descriptionSchema.parse(response.output);
      if (!output.title.trim() || !output.description.trim()) {
        throw new Error("Model returned empty title or description");
      }

      return {
        model: modelId,
        ok: true,
        attemptsUsed: attempt,
        latencyMs: Date.now() - started,
        title: output.title,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    model: modelId,
    ok: false,
    attemptsUsed: attempts,
    error: lastError,
  };
}

const program = new Command();

program
  .name("verify-vision-models")
  .description("Verify that models listed in docs/VISION-MODELS.md accept image_url input with json_schema output")
  .option("-p, --provider <provider>", "Provider to test (baseten, openai-compatible)", "baseten")
  .option("-m, --models <models>", "Comma-separated model IDs (defaults to the Baseten Model APIs vision list)")
  .option("--image-url <url>", "Storyboard image URL to send", DEFAULT_IMAGE_URL)
  .option("--attempts <count>", "Attempts per model before marking it failed", "3")
  .action(async (options: {
    provider: string;
    models?: string;
    imageUrl: string;
    attempts: string;
  }) => {
    if (!["baseten", "openai-compatible"].includes(options.provider)) {
      console.error("Unsupported provider. Choose from: baseten, openai-compatible");
      process.exit(1);
    }
    const provider = options.provider as SupportedProvider;

    const models = options.models ?
        options.models.split(",").map(value => value.trim()).filter(Boolean) :
      BASETEN_MODEL_APIS_VISION_MODELS;
    const attempts = Number.parseInt(options.attempts, 10);

    const imageCheck = await fetch(options.imageUrl, { method: "HEAD" });
    if (!imageCheck.ok) {
      console.error(`Image URL is not reachable (HTTP ${imageCheck.status}): ${options.imageUrl}`);
      process.exit(1);
    }

    console.warn(`Provider: ${provider}`);
    console.warn(`Image: ${options.imageUrl}`);
    console.warn(`Attempts per model: ${attempts}\n`);

    const results: VerificationResult[] = [];
    for (const modelId of models) {
      process.stdout.write(`${modelId} ... `);
      const result = await verifyModel(provider, modelId, options.imageUrl, attempts);
      results.push(result);
      if (result.ok) {
        const retryNote = result.attemptsUsed > 1 ? ` (attempt ${result.attemptsUsed})` : "";
        console.warn(`PASS in ${result.latencyMs}ms${retryNote} — "${result.title}"`);
      } else {
        console.warn(`FAIL after ${result.attemptsUsed} attempts — ${result.error}`);
      }
    }

    const failed = results.filter(result => !result.ok);
    console.warn(`\n${results.length - failed.length}/${results.length} models passed`);
    if (failed.length > 0) {
      console.warn(`Failed: ${failed.map(result => result.model).join(", ")}`);
      process.exit(1);
    }
  });

program.parse();
