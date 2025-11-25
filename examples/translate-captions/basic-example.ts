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
    console.log('Usage: npm run example:translation <asset-id> [from-lang] [to-lang] [provider]');
    console.log('Example: npm run example:translation your-asset-id en es anthropic');
    process.exit(1);
  }

  console.log(`Asset ID: ${assetId}`);
  console.log(`Translation: ${fromLang} -> ${toLang}`);
  console.log(`Provider: ${provider} (${model})\n`);

  try {
    console.log('🌍 Starting translation...\n');

    const result = await translateCaptions(assetId, fromLang, toLang, {
      provider,
      model
    });

    console.log('\n📊 Translation Results:');
    console.log(`Source Language: ${result.sourceLanguageCode}`);
    console.log(`Target Language: ${result.targetLanguageCode}`);
    console.log(`Asset ID: ${result.assetId}`);

    if (result.uploadedTrackId) {
      console.log(`🎬 Mux Track ID: ${result.uploadedTrackId}`);
    }

    if (result.presignedUrl) {
      console.log(`🔗 Presigned URL: ${result.presignedUrl.substring(0, 80)}...`);
    }

    console.log('\n✅ VTT translation completed successfully!');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();