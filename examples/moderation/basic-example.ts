import { getModerationScores } from "@mux/ai/workflows";

import "../env";

const SUPPORTED_PROVIDERS = ["openai", "hive", "google-vision-api"] as const;
type ModerationProviderArg = (typeof SUPPORTED_PROVIDERS)[number];
type ProviderWithModel = Extract<ModerationProviderArg, "openai">;

const DEFAULT_MODELS: Record<ProviderWithModel, string> = {
  openai: "omni-moderation-latest",
};

async function main() {
  const assetId = process.argv[2];
  const providerArg = (process.argv[3] as ModerationProviderArg | undefined) || "openai";
  const maxSamples = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;

  if (!assetId) {
    console.log("Usage: npm run example:moderation <asset-id> [provider] [maxSamples]");
    console.log("Example: npm run example:moderation your-asset-id hive 3");
    console.log(`Supported providers: ${SUPPORTED_PROVIDERS.join(" | ")}`);
    process.exit(1);
  }

  if (!SUPPORTED_PROVIDERS.includes(providerArg)) {
    console.error(`❌ Unsupported provider "${providerArg}". Choose from: ${SUPPORTED_PROVIDERS.join(", ")}`);
    process.exit(1);
  }

  const provider = providerArg;
  const model = provider === "openai" ? DEFAULT_MODELS[provider] : undefined;

  console.log("Asset ID:", assetId);
  console.log(`Provider: ${provider} (${model})\n`);

  try {
    console.log("🛡️  Starting moderation analysis...\n");

    const result = await getModerationScores(assetId, {
      provider,
      ...(model ? { model } : {}),
      ...(maxSamples ? { maxSamples } : {}),
      thresholds: {
        sexual: 0.7,
        violence: 0.8,
      },
    });

    console.log("📊 Moderation Results:");
    console.log("Max Sexual Score:", result.maxScores.sexual.toFixed(3));
    console.log("Max Violence Score:", result.maxScores.violence.toFixed(3));
    console.log("Exceeds Threshold:", result.exceedsThreshold ? "❌ YES" : "✅ PASSED");

    console.log("\n🎯 Thresholds:");
    console.log("Sexual Threshold:", result.thresholds.sexual);
    console.log("Violence Threshold:", result.thresholds.violence);

    console.log(`\n📸 Analyzed ${result.thumbnailScores.length} thumbnails:`);
    result.thumbnailScores.forEach((thumb, index) => {
      if (thumb.error) {
        console.log(`  ${index + 1}. ❌ ERROR: ${thumb.errorMessage || "Unknown error"}`);
      } else {
        console.log(`  ${index + 1}. Sexual: ${thumb.sexual.toFixed(3)}, Violence: ${thumb.violence.toFixed(3)} ✅ OK`);
      }
    });

    console.log("\n📦 Asset ID:", result.assetId);

    console.log("\n📈 Usage:");
    console.log(JSON.stringify(result.usage, null, 2));
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
  }
}

main();
