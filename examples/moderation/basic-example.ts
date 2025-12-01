import "../env";
import { getModerationScores } from "@mux/ai/functions";

const SUPPORTED_PROVIDERS = ["openai", "hive"] as const;
type ModerationProviderArg = (typeof SUPPORTED_PROVIDERS)[number];
type ProviderWithModel = Exclude<ModerationProviderArg, "hive">;

const DEFAULT_MODELS: Record<ProviderWithModel, string> = {
  openai: "omni-moderation-latest",
};

async function main() {
  const assetId = process.argv[2];
  const providerArg = (process.argv[3] as ModerationProviderArg | undefined) || "openai";

  if (!assetId) {
    console.log("Usage: npm run example:moderation <asset-id> [provider]");
    console.log("Example: npm run example:moderation your-asset-id hive");
    console.log("Supported providers: openai | anthropic | google | hive");
    process.exit(1);
  }

  if (!SUPPORTED_PROVIDERS.includes(providerArg)) {
    console.error(`❌ Unsupported provider "${providerArg}". Choose from: ${SUPPORTED_PROVIDERS.join(", ")}`);
    process.exit(1);
  }

  const provider = providerArg;
  const model = provider === "hive" ? undefined : DEFAULT_MODELS[provider];

  console.log("Asset ID:", assetId);
  console.log(`Provider: ${provider} (${model})\n`);

  try {
    console.log("🛡️  Starting moderation analysis...\n");

    const result = await getModerationScores(assetId, {
      provider,
      ...(model ? { model } : {}),
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
      const status = thumb.error ? "❌ ERROR" : "✅ OK";
      console.log(`  ${index + 1}. Sexual: ${thumb.sexual.toFixed(3)}, Violence: ${thumb.violence.toFixed(3)} ${status}`);
    });

    console.log("\n📦 Asset ID:", result.assetId);
  }
  catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
  }
}

main();
