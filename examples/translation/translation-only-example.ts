import { translateCaptions } from '@mux/ai';
import { config } from 'dotenv';

// Load environment variables from parent directory - override existing
const result = config({ path: '../../.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function main() {
  const assetId = process.argv[2];
  const fromLang = process.argv[3] || 'en';
  const toLang = process.argv[4] || 'es';
  
  if (!assetId) {
    console.log('Usage: npm run translation-only <asset-id> [from-lang] [to-lang]');
    console.log('Example: npm run translation-only your-asset-id en es');
    process.exit(1);
  }

  try {
    console.log('🌍 Starting translation (no S3 upload)...\n');

    const result = await translateCaptions(assetId, fromLang, toLang, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
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