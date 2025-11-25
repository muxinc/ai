import 'dotenv/config';
import { getSummaryAndTags } from '@mux/ai/functions';

type Provider = 'openai' | 'anthropic' | 'google';

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash',
};

async function main() {
  const assetId = process.argv[2];
  const provider = (process.argv[3] as Provider) || 'anthropic';

  if (!assetId) {
    console.log('Usage: npm run example:summarization <asset-id> [provider]');
    console.log('Example: npm run example:summarization your-asset-id anthropic');
    process.exit(1);
  }

  if (!['openai', 'anthropic', 'google'].includes(provider)) {
    console.error('❌ Unsupported provider. Choose from: openai, anthropic, google');
    process.exit(1);
  }

  const model = DEFAULT_MODELS[provider as Provider];

  console.log('Asset ID:', assetId);
  console.log(`Provider: ${provider} (${model})\n`);

  try {
    // Uses the default prompt built into the library
    const result = await getSummaryAndTags(assetId, {
      tone: 'sassy',
      provider,
      model,
      includeTranscript: true,
      // Credentials can be passed in options or via environment variables
      muxTokenId: process.env.MUX_TOKEN_ID,
      muxTokenSecret: process.env.MUX_TOKEN_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY,
    });

    console.log('📝 Title:');
    console.log(result.title);
    console.log('\n📋 Description:');
    console.log(result.description);
    console.log('\n🏷️  Tags:');
    console.log(result.tags.join(', '));
    console.log('\n🖼️  Storyboard URL:');
    console.log(result.storyboardUrl);
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();