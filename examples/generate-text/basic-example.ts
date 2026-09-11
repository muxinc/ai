import { Command } from "commander";

import { generateText } from "@mux/ai/workflows";
import type { GenerateTextCallToAction, GenerateTextVoice } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "anthropic" | "google" | "baseten" | "openai-compatible";

const program = new Command();

program
  .name("generate-text")
  .description("Write source-grounded posts and articles from a Mux asset")
  .argument("<asset-id>", "Mux asset ID to write from")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google, baseten, openai-compatible)", "openai")
  .option("-a, --audience <audience>", "Intended reader, e.g. \"Video developers\"")
  .option("-v, --voice <voice>", "conversational | editorial | playful | professional")
  .option("-c, --cta <cta>", "none | soft | direct")
  .option("--shots", "Attach shot frames as extra visual evidence (video assets only)", false)
  .option("--output-language <code>", "Output language as BCP 47 code (e.g. 'fr', 'ja') or 'auto'")
  .action(async (assetId: string, options: {
    provider: Provider;
    audience?: string;
    voice?: GenerateTextVoice;
    cta?: GenerateTextCallToAction;
    shots: boolean;
    outputLanguage?: string;
  }) => {
    if (!["openai", "anthropic", "google", "baseten", "openai-compatible"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, anthropic, google, baseten, openai-compatible");
      process.exit(1);
    }

    console.log(`✍️  Generating text for asset: ${assetId}`);
    console.log(`🤖 Provider: ${options.provider}`);
    if (options.audience) console.log(`🎯 Audience: ${options.audience}`);
    if (options.voice) console.log(`🗣️  Voice: ${options.voice}`);
    if (options.shots) console.log("🎬 Shot frames: enabled");
    console.log();

    try {
      const start = Date.now();

      const result = await generateText(assetId, {
        provider: options.provider,
        variants: [
          { key: "product_led", instructions: "Use a promotional, product-led angle." },
          { key: "insight_led", instructions: "Use an educational, insight-led angle." },
        ],
        artifacts: [
          { key: "x_post", kind: "short_form", channel: "x" },
          { key: "linkedin_post", kind: "short_form", channel: "linkedin" },
          { key: "blog_post", kind: "long_form", maxLength: { unit: "words", value: 600 } },
        ],
        audience: options.audience,
        voice: options.voice,
        callToAction: options.cta,
        useShots: options.shots,
        outputLanguageCode: options.outputLanguage,
      });

      console.log("✅ Success!");
      console.log(`⏱️  Duration: ${Date.now() - start}ms`);
      console.log(`📊 Tokens: ${result.usage?.totalTokens ?? "n/a"}`);
      if (result.safety?.leaksDetected) {
        console.log(`⚠️  Suppressed fields: ${result.safety.scrubbedFields.map(field => field.field).join(", ")}`);
      }

      for (const variant of result.variants) {
        console.log(`\n══════════ Variant: ${variant.key} ══════════`);
        for (const artifact of variant.artifacts) {
          console.log(`\n── ${artifact.key} (${artifact.kind}) ──`);
          console.log(artifact.content);
        }
      }
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
