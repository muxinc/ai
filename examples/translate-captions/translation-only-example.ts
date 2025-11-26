import 'dotenv/config';
import { translateCaptions } from '@mux/ai/functions';

type Provider = 'openai' | 'anthropic' | 'google';

const defaultModels = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-2.5-flash'
} as const;

async function main() {
  const assetId = process.argv[2];
  const fromLang = process.argv[3] || 'en';
  const toLang = process.argv[4] || 'es';
  const provider = (process.argv[5] as Provider) || 'anthropic';
  const model = defaultModels[provider];

  if (!assetId) {
    console.log('Usage: npm run translation-only <asset-id> [from-lang] [to-lang] [provider]');
    console.log('Example: npm run translation-only your-asset-id en es anthropic');
    process.exit(1);
  }

  try {
    console.log('🌍 Starting translation (no S3 upload)...\n');
    console.log(`Provider: ${provider} (${model})\n`);

    const result = await translateCaptions(assetId, fromLang, toLang, {
      provider,
      model,
      uploadToMux: false  // Only translate, don't upload
    });

    console.log('\n📊 Translation Results:');
    console.log(`Source Language: ${result.sourceLanguageCode}`);
    console.log(`Target Language: ${result.targetLanguageCode}`);
    console.log(`Asset ID: ${result.assetId}`);

    console.log('\n--- Original VTT (first 500 chars) ---');
    console.log(result.originalVtt.substring(0, 500) + '...');
    console.log('\n--- Translated VTT (first 500 chars) ---');
    console.log(result.translatedVtt.substring(0, 500) + '...');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();