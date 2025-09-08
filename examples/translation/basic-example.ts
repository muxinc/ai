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
    console.log('Usage: npm run basic <asset-id> [from-lang] [to-lang]');
    console.log('Example: npm run basic your-asset-id en es');
    process.exit(1);
  }

  console.log(`Asset ID: ${assetId}`);
  console.log(`Translation: ${fromLang} -> ${toLang}\n`);

  try {
    console.log('🌍 Starting translation...\n');

    const result = await translateCaptions(assetId, fromLang, toLang, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514'
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