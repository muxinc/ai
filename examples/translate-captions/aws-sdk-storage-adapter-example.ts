import { Command } from "commander";

import type { StorageAdapter } from "@mux/ai";
import { translateCaptions } from "@mux/ai/workflows";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import "../env";

type Provider = "openai" | "anthropic" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.1",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-3-flash-preview",
};

function createAwsSdkStorageAdapter(): StorageAdapter {
  return {
    putObject: async (input) => {
      const accessKeyId = input.accessKeyId ?? process.env.S3_ACCESS_KEY_ID;
      const secretAccessKey = input.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY;

      if (!accessKeyId || !secretAccessKey) {
        throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required.");
      }

      const s3 = new S3Client({
        region: input.region,
        endpoint: input.endpoint,
        credentials: { accessKeyId, secretAccessKey },
      });

      await s3.send(new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }));
    },
    createPresignedGetUrl: async (input) => {
      const accessKeyId = input.accessKeyId ?? process.env.S3_ACCESS_KEY_ID;
      const secretAccessKey = input.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY;

      if (!accessKeyId || !secretAccessKey) {
        throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required.");
      }

      const s3 = new S3Client({
        region: input.region,
        endpoint: input.endpoint,
        credentials: { accessKeyId, secretAccessKey },
      });

      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
        { expiresIn: input.expiresInSeconds },
      );
    },
  };
}

const program = new Command();

program
  .name("translate-captions-aws-sdk")
  .description("Translate captions using AWS SDK v3 via storageAdapter")
  .argument("<asset-id>", "Mux asset ID to translate")
  .option("-f, --from <language>", "Source language code", "en")
  .option("-t, --to <language>", "Target language code", "es")
  .option("-p, --provider <provider>", "AI provider (openai, anthropic, google)", "anthropic")
  .option("-m, --model <model>", "Model name (overrides default for provider)")
  .option("--s3-endpoint <url>", "S3 endpoint override", process.env.S3_ENDPOINT ?? "https://s3.amazonaws.com")
  .option("--s3-region <region>", "S3 region", process.env.S3_REGION ?? "us-east-1")
  .option("--s3-bucket <name>", "S3 bucket", process.env.S3_BUCKET)
  .action(async (assetId: string, options: {
    from: string;
    to: string;
    provider: Provider;
    model?: string;
    s3Endpoint: string;
    s3Region: string;
    s3Bucket?: string;
  }) => {
    if (!["openai", "anthropic", "google"].includes(options.provider)) {
      console.error("❌ Unsupported provider. Choose from: openai, anthropic, google");
      process.exit(1);
    }

    if (!options.s3Bucket) {
      console.error("❌ Missing S3 bucket. Pass --s3-bucket or set S3_BUCKET.");
      process.exit(1);
    }

    const model = options.model || DEFAULT_MODELS[options.provider];
    const storageAdapter = createAwsSdkStorageAdapter();

    console.log(`Asset ID: ${assetId}`);
    console.log(`Translation: ${options.from} -> ${options.to}`);
    console.log(`Provider: ${options.provider} (${model})`);
    console.log(`S3 endpoint: ${options.s3Endpoint}`);
    console.log(`S3 region: ${options.s3Region}`);
    console.log(`S3 bucket: ${options.s3Bucket}\n`);

    try {
      const result = await translateCaptions(assetId, options.from, options.to, {
        provider: options.provider,
        model,
        s3Endpoint: options.s3Endpoint,
        s3Region: options.s3Region,
        s3Bucket: options.s3Bucket,
        storageAdapter,
      });

      console.log("\n📊 Translation Results:");
      console.log(`Source Language: ${result.sourceLanguageCode}`);
      console.log(`Target Language: ${result.targetLanguageCode}`);
      console.log(`Asset ID: ${result.assetId}`);

      if (result.uploadedTrackId) {
        console.log(`🎬 Mux Track ID: ${result.uploadedTrackId}`);
      }

      if (result.presignedUrl) {
        console.log(`🔗 Presigned URL: ${result.presignedUrl.substring(0, 80)}...`);
      }

      console.log("\n✅ VTT translation completed successfully!");
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
