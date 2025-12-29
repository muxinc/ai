import { Command } from "commander";

import type { ChunkingStrategy } from "@mux/ai";
import { generateEmbeddings } from "@mux/ai/workflows";

import "../env";

type Provider = "openai" | "google";
type Strategy = "token" | "vtt";

const program = new Command();

program
  .name("embeddings")
  .description("Generate embeddings for a Mux asset transcript")
  .argument("<asset-id>", "Mux asset ID to analyze")
  .option("-l, --language <code>", "Language code for transcription", "en")
  .option("-p, --provider <provider>", "AI provider (openai, google)", "openai")
  .option("-s, --strategy <type>", "Chunking strategy (token, vtt)", "token")
  .option("-t, --max-tokens <number>", "Maximum tokens per chunk", "500")
  .option("-o, --overlap <number>", "Overlap between chunks (tokens for token, cues for vtt)", "100")
  .action(async (assetId: string, options: {
    language: string;
    maxTokens: string;
    overlap: string;
    provider: Provider;
    strategy: string;
  }) => {
    // Validate provider
    if (!["openai", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, google");
      process.exit(1);
    }

    // Validate strategy
    if (!["token", "vtt"].includes(options.strategy)) {
      console.error("❌ Unsupported strategy. Choose from: token, vtt");
      process.exit(1);
    }

    const strategy = options.strategy as Strategy;
    const maxTokens = Number.parseInt(options.maxTokens, 10);
    const overlap = Number.parseInt(options.overlap, 10);

    if (Number.isNaN(maxTokens) || maxTokens < 1) {
      console.error("❌ Invalid max-tokens value");
      process.exit(1);
    }

    if (Number.isNaN(overlap) || overlap < 0) {
      console.error("❌ Invalid overlap value");
      process.exit(1);
    }

    console.log(`🎯 Generating embeddings for asset: ${assetId}`);
    console.log(`📝 Language: ${options.language}`);
    console.log(`🤖 Provider: ${options.provider}`);
    console.log(`📦 Strategy: ${strategy}`);

    const overlapLabel = strategy === "vtt" ? "cues" : "tokens";
    console.log(`📊 Chunking: ${maxTokens} tokens per chunk, ${overlap} ${overlapLabel} overlap\n`);

    try {
      const start = Date.now();

      // Build chunking strategy based on type
      const chunkingStrategy: ChunkingStrategy = strategy === "vtt" ?
          { type: "vtt", maxTokens, overlapCues: overlap } :
          { type: "token", maxTokens, overlap };

      const result = await generateEmbeddings(assetId, {
        provider: options.provider,
        languageCode: options.language,
        chunkingStrategy,
      });

      const duration = Date.now() - start;

      console.log("✅ Success!");
      console.log(`⏱️  Duration: ${duration}ms`);
      console.log(`📊 Generated ${result.metadata.totalChunks} chunks`);
      console.log(`🔢 Total tokens: ${result.metadata.totalTokens}`);
      console.log(`📐 Embedding dimensions: ${result.metadata.embeddingDimensions}\n`);

      console.log("📋 Chunk Details:");
      for (const [i, chunk] of result.chunks.slice(0, 3).entries()) {
        console.log(`  ${i + 1}. ${chunk.chunkId}: ${chunk.metadata.tokenCount} tokens`);
        console.log(`     First 5 dims: [${chunk.embedding.slice(0, 5).map(n => n.toFixed(4)).join(", ")}...]`);
      }

      if (result.chunks.length > 3) {
        console.log(`  ... and ${result.chunks.length - 3} more chunks`);
      }

      console.log("\n🎯 Averaged Embedding:");
      console.log(`  Vector length: ${result.averagedEmbedding.length}`);
      console.log(`  First 5 dims: [${result.averagedEmbedding.slice(0, 5).map(n => n.toFixed(4)).join(", ")}...]`);

      console.log("\n💡 Usage Examples:");
      console.log("// Store averaged embedding for asset-level search:");
      console.log("// await vectorDB.insert({");
      console.log("//   id: result.assetId,");
      console.log("//   embedding: result.averagedEmbedding,");
      console.log("//   metadata: result.metadata");
      console.log("// });");
      console.log("\n// Store chunks for timestamp-accurate search:");
      console.log("// for (const chunk of result.chunks) {");
      console.log("//   await vectorDB.insert({");
      // eslint-disable-next-line no-template-curly-in-string
      console.log("//     id: `${result.assetId}:${chunk.chunkId}`,");
      console.log("//     embedding: chunk.embedding,");
      console.log("//     metadata: chunk.metadata");
      console.log("//   });");
      console.log("// }");
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
