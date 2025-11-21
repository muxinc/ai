import 'dotenv/config';
import { translateAudio } from '@mux/ai/functions';


async function main() {
  const assetId = process.argv[2];
  const toLang = process.argv[3] || 'es';
  
  if (!assetId) {
    console.log('Usage: npm run example:audio-translation <asset-id> [to-lang]');
    console.log('Example: npm run example:audio-translation your-asset-id es');
    console.log('Example: npm run example:audio-translation your-asset-id fr');
    console.log('');
    console.log('Note: Asset must have an audio.m4a static rendition');
    console.log('Note: Uses default audio track, language is auto-detected');
    process.exit(1);
  }

  console.log(`Asset ID: ${assetId}`);
  console.log(`Audio Dubbing: auto-detect -> ${toLang}\n`);

  try {
    console.log('🎙️ Starting audio dubbing...\n');

    const result = await translateAudio(assetId, toLang, {
      provider: 'elevenlabs',
      numSpeakers: 0 // Auto-detect speakers
    });

    console.log('\n📊 Audio Dubbing Results:');
    console.log(`Target Language: ${result.targetLanguageCode}`);
    console.log(`Asset ID: ${result.assetId}`);
    console.log(`ElevenLabs Dubbing ID: ${result.dubbingId}`);
    
    if (result.uploadedTrackId) {
      console.log(`🎬 Mux Audio Track ID: ${result.uploadedTrackId}`);
    }
    
    if (result.presignedUrl) {
      console.log(`🔗 Presigned URL: ${result.presignedUrl.substring(0, 80)}...`);
    }
    
    console.log('\n✅ Audio dubbing completed successfully!');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  }
}

main();