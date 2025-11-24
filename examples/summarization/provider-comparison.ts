import 'dotenv/config';
import { getSummaryAndTags } from '@mux/ai/functions';

async function compareProviders(assetId: string) {
  console.log('🔍 Comparing OpenAI vs Anthropic analysis results...\n');

  const providers = [
    { name: 'OpenAI', provider: 'openai' as const, model: 'gpt-5-mini' },
    { name: 'Anthropic', provider: 'anthropic' as const, model: 'claude-sonnet-4-5' },
    { name: 'Google', provider: 'google' as const, model: 'gemini-2.5-flash' },
  ];

  for (const config of providers) {
    try {
      console.log(`--- ${config.name.toUpperCase()} ANALYSIS ---`);
      console.log(`Model: ${config.model}`);

      const startTime = Date.now();
      const result = await getSummaryAndTags(assetId, {
        provider: config.provider,
        model: config.model,
        tone: 'normal',
        includeTranscript: true,
      });
      const duration = Date.now() - startTime;

      console.log(`⏱️  Analysis time: ${duration}ms`);
      console.log(`📝 Title: ${result.title}`);
      console.log(`📋 Description: ${result.description}`);
      console.log(`🏷️  Tags: ${result.tags.join(', ')}`);
      console.log('---\n');

    } catch (error) {
      console.error(`❌ Error with ${config.name}:`, error instanceof Error ? error.message : error);
      console.log('---\n');
    }
  }
}

async function main() {
  const assetId = process.argv[2];

  if (!assetId) {
    console.log('Usage: npm run example:summarization:compare <asset-id>');
    process.exit(1);
  }

  await compareProviders(assetId);
}

main();