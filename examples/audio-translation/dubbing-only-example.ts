import { translateAudio } from '@mux/ai';
import { config } from 'dotenv';

// Load environment variables from parent directory - override existing
const result = config({ path: '.env', override: true });
console.log('Dotenv result:', result.error ? result.error.message : 'SUCCESS');

async function main() {
  const assetId = process.argv[2];
  const toLang = process.argv[3] || 'es';
  
  if (!assetId) {
    console.log('Usage: npm run dubbing-only <asset-id> [to-lang]');
    console.log('Example: npm run dubbing-only your-asset-id fr');
    console.log('Example: npm run dubbing-only your-asset-id de');
    console.log('');
    console.log('Note: This will only create the ElevenLabs dubbing job, not upload to Mux');
    console.log('Note: Uses default audio track, language is auto-detected');
    process.exit(1);
  }

  console.log(`Asset ID: ${assetId}`);
  console.log(`Audio Dubbing: auto-detect -> ${toLang} (dubbing only)\n`);

  try {
    console.log('🎙️ Starting ElevenLabs dubbing (no S3 upload)...\n');

    const result = await translateAudio(assetId, toLang, {
      provider: 'elevenlabs',
      numSpeakers: 0, // Auto-detect speakers
      uploadToMux: false // Only dub, don't upload
    });

    console.log('\n📊 Audio Dubbing Results:');
    console.log(`Target Language: ${result.targetLanguageCode}`);
    console.log(`Asset ID: ${result.assetId}`);
    console.log(`ElevenLabs Dubbing ID: ${result.dubbingId}`);
    
    console.log('\n✅ ElevenLabs dubbing completed successfully!');
    console.log('💡 To download the dubbed audio, use the ElevenLabs dashboard or API');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();