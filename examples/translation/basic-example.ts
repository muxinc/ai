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

  // Debug: Check if env vars are loaded
  console.log('Debug - Environment variables:');
  console.log('MUX_TOKEN_ID:', process.env.MUX_TOKEN_ID ? `${process.env.MUX_TOKEN_ID.substring(0, 10)}...` : 'NOT SET');
  console.log('MUX_TOKEN_SECRET:', process.env.MUX_TOKEN_SECRET ? `${process.env.MUX_TOKEN_SECRET.substring(0, 10)}...` : 'NOT SET'); 
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? `${process.env.ANTHROPIC_API_KEY.substring(0, 10)}...` : 'NOT SET');
  console.log('S3_ENDPOINT:', process.env.S3_ENDPOINT ? `${process.env.S3_ENDPOINT.substring(0, 20)}...` : 'NOT SET');
  console.log('S3_BUCKET:', process.env.S3_BUCKET || 'NOT SET');
  console.log('S3_ACCESS_KEY_ID:', process.env.S3_ACCESS_KEY_ID ? `${process.env.S3_ACCESS_KEY_ID.substring(0, 10)}...` : 'NOT SET');
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
    
    console.log('\n--- Original VTT (first 500 chars) ---');
    console.log(result.originalVtt.substring(0, 500) + '...');
    console.log('\n--- Translated VTT (first 500 chars) ---');
    console.log(result.translatedVtt.substring(0, 500) + '...');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();